//! XMLTV EPG parsing (spec 7.2 `live.parseEpg`).
//!
//! Ported from `sidecars/py/live.py::parse_epg`. An XMLTV file is often tens of
//! MB and covers nine rolling days, so the document is streamed twice instead
//! of being built into a tree:
//!
//! 1. map `channel id -> display names`;
//! 2. keep only programmes of the channels matching the requested name.
//!
//! Rust does this in-process now; the raw payload is still cached by
//! `live::live_epg` (TTL 3h) so zapping between channels does not re-download.

use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, Local, NaiveDate, TimeZone};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// 单频道单日最多返回多少条：e.xml 一份覆盖 9 天，不裁剪的话 CCTV1 会吐 2213 条，
/// 前端一次渲染 2000+ 个 `<li>`，面板直接卡住。
const MAX_EPG_PROGRAMS: usize = 240;

fn quality_suffix() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:2160p|1080p|720p|4k|8k|uhd|hd|超清|高清|标清|蓝光)$").expect("quality")
    })
}

fn separators() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\s\-_.·]+").expect("separators"))
}

fn xmltv_time() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?").expect("time")
    })
}

fn date_key() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("date"))
}

/// EPG 文本清洗：XML 解析只解一层实体，源里常见双重转义
/// （`&amp;apos;` 解完还是 `&apos;`），直接上屏就是 `&apos;字`。
fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let Some(end) = tail.find(';').filter(|end| *end <= 12) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" => Some("'".to_string()),
            "nbsp" => Some("\u{a0}".to_string()),
            "hellip" => Some("…".to_string()),
            "mdash" => Some("—".to_string()),
            "ndash" => Some("–".to_string()),
            "ldquo" => Some("“".to_string()),
            "rdquo" => Some("”".to_string()),
            "lsquo" => Some("‘".to_string()),
            "rsquo" => Some("’".to_string()),
            "middot" => Some("·".to_string()),
            other => other
                .strip_prefix('#')
                .and_then(|digits| match digits.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok().and_then(char::from_u32),
                    None => digits.parse::<u32>().ok().and_then(char::from_u32),
                })
                .map(|ch| ch.to_string()),
        };
        match decoded {
            Some(value) => {
                out.push_str(&value);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn clean_text(value: &str) -> String {
    decode_entities(value.trim()).trim().to_string()
}

fn attribute(start: &BytesStart<'_>, key: &str) -> Option<String> {
    start
        .attributes()
        .flatten()
        .find(|attr| attr.key.as_ref() == key.as_bytes())
        .and_then(|attr| attr.unescape_value().ok())
        .map(|value| value.into_owned())
}

/// XMLTV 时间 `20261113060000 +0800` → ISO 8601（`2026-11-13T06:00:00+08:00`）。
/// 解析失败原样返回，交给前端兜底。
pub(crate) fn localize_time(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Some(capture) = xmltv_time().captures(trimmed) else {
        return trimmed.to_string();
    };
    let number = |index: usize| capture[index].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        number(1),
        number(2),
        number(3),
        number(4),
        number(5),
        number(6),
    ) else {
        return trimmed.to_string();
    };
    let offset = capture.get(7).map(|raw| raw.as_str()).and_then(|raw| {
        let sign = if raw.starts_with('-') { -1 } else { 1 };
        let hours: i32 = raw[1..3].parse().ok()?;
        let minutes: i32 = raw[3..5].parse().ok()?;
        FixedOffset::east_opt(sign * (hours * 3600 + minutes * 60))
    });
    let naive = NaiveDate::from_ymd_opt(year as i32, month, day)
        .and_then(|date| date.and_hms_opt(hour, minute, second));
    let Some(naive) = naive else {
        return trimmed.to_string();
    };
    match offset {
        Some(offset) => match offset.from_local_datetime(&naive).single() {
            Some(moment) => moment.to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
            None => trimmed.to_string(),
        },
        // 没有时区：Python 的 `isoformat()` 也不带偏移。
        None => naive.format("%Y-%m-%dT%H:%M:%S").to_string(),
    }
}

fn norm_channel(value: &str) -> String {
    let trimmed = quality_suffix().replace(value.trim(), "");
    separators().replace_all(&trimmed, "").to_lowercase()
}

/// 0 = 不匹配；分数越高越可信。
///
/// 必须区分 `CCTV1` 与 `CCTV11`：真实的直播源里两者同时存在，用朴素的
/// `target in name` 会让 CCTV1 频道把 CCTV11/12… 的节目单一起收进来。
fn match_score(target: &str, name: &str) -> u32 {
    let left = norm_channel(target);
    let right = norm_channel(name);
    if left.is_empty() || right.is_empty() {
        return 0;
    }
    if left == right {
        return 100;
    }

    let (longer, shorter) = if right.len() > left.len() && right.starts_with(&left) {
        (right.as_str(), left.as_str())
    } else if left.len() > right.len() && left.starts_with(&right) {
        (left.as_str(), right.as_str())
    } else if left.contains(&right) || right.contains(&left) {
        return 40;
    } else {
        return 0;
    };

    let rest = &longer[shorter.len()..];
    if rest.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        return 0;
    }
    if shorter.chars().count() < 2 {
        return 0;
    }
    let ratio = 10.0 * shorter.chars().count() as f64 / longer.chars().count() as f64;
    80 + ratio.round() as u32
}

/// 频道 id → 显示名（第一遍扫描的产物）。
struct ChannelIndex {
    id_to_names: HashMap<String, HashSet<String>>,
    names_to_id: HashMap<String, String>,
}

fn collect_channels(raw: &str) -> ChannelIndex {
    let mut id_to_names: HashMap<String, HashSet<String>> = HashMap::new();
    let mut names_to_id: HashMap<String, String> = HashMap::new();
    let mut reader = Reader::from_str(raw);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut current: Option<String> = None;
    let mut names: HashSet<String> = HashSet::new();
    let mut name_buffer = String::new();
    let mut in_name = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"channel" => {
                    current = Some(attribute(&start, "id").unwrap_or_default());
                    names.clear();
                }
                b"display-name" | b"name" => {
                    in_name = true;
                    name_buffer.clear();
                }
                _ => {}
            },
            Ok(Event::Text(text)) => {
                if in_name {
                    if let Ok(value) = text.unescape() {
                        name_buffer.push_str(&value);
                    }
                }
            }
            Ok(Event::CData(data)) => {
                if in_name {
                    name_buffer.push_str(&String::from_utf8_lossy(&data));
                }
            }
            Ok(Event::End(end)) => match end.name().as_ref() {
                b"channel" => {
                    if let Some(id) = current.take() {
                        for name in &names {
                            names_to_id
                                .entry(name.clone())
                                .or_insert_with(|| id.clone());
                        }
                        id_to_names.insert(id, std::mem::take(&mut names));
                    }
                }
                b"display-name" | b"name" => {
                    in_name = false;
                    let name = clean_text(&name_buffer);
                    if !name.is_empty() {
                        names.insert(name);
                    }
                    name_buffer.clear();
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    ChannelIndex {
        id_to_names,
        names_to_id,
    }
}

fn match_channels(target: &str, index: &ChannelIndex) -> HashSet<String> {
    let mut exact = HashSet::new();
    if let Some(id) = index.names_to_id.get(target) {
        exact.insert(id.clone());
    }
    if index.id_to_names.contains_key(target) {
        exact.insert(target.to_string());
    }
    if !exact.is_empty() {
        return exact;
    }

    let mut best_score = 0;
    let mut best: HashSet<String> = HashSet::new();
    for (id, names) in &index.id_to_names {
        let score = names
            .iter()
            .map(|name| match_score(target, name))
            .chain(std::iter::once(match_score(target, id)))
            .max()
            .unwrap_or(0);
        if score == 0 {
            continue;
        }
        if score > best_score {
            best_score = score;
            best.clear();
            best.insert(id.clone());
        } else if score == best_score {
            best.insert(id.clone());
        }
    }
    best
}

fn collect_programs(raw: &str, matched: &HashSet<String>) -> Vec<Value> {
    let mut programs: Vec<Value> = Vec::new();
    let mut reader = Reader::from_str(raw);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut current: Option<(String, String, String)> = None;
    let mut title = String::new();
    let mut desc = String::new();
    let mut field: Option<u8> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"programme" => {
                    let channel = attribute(&start, "channel").unwrap_or_default();
                    let begin = attribute(&start, "start").unwrap_or_default();
                    let stop = attribute(&start, "stop").unwrap_or_default();
                    current = Some((channel, begin, stop));
                    title.clear();
                    desc.clear();
                    field = None;
                }
                b"title" => field = Some(1),
                b"desc" => field = Some(2),
                _ => {}
            },
            Ok(Event::Text(text)) => match field {
                Some(1) => {
                    if let Ok(value) = text.unescape() {
                        title.push_str(&value);
                    }
                }
                Some(2) => {
                    if let Ok(value) = text.unescape() {
                        desc.push_str(&value);
                    }
                }
                _ => {}
            },
            Ok(Event::CData(data)) => match field {
                Some(1) => title.push_str(&String::from_utf8_lossy(&data)),
                Some(2) => desc.push_str(&String::from_utf8_lossy(&data)),
                _ => {}
            },
            Ok(Event::End(end)) => match end.name().as_ref() {
                b"programme" => {
                    if let Some((channel, begin, stop)) = current.take() {
                        if matched.contains(&channel) {
                            programs.push(json!({
                                "start": localize_time(&begin),
                                "stop": if stop.is_empty() { String::new() } else { localize_time(&stop) },
                                "title": clean_text(&title),
                                "desc": clean_text(&desc),
                            }));
                        }
                    }
                }
                b"title" | b"desc" => field = None,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    programs
}

pub(crate) fn parse(raw: &str, channel: &str, date: Option<&str>) -> Value {
    let target = channel.trim();
    if target.is_empty() {
        return json!({ "channel": channel, "date": date, "programs": [] });
    }
    let index = collect_channels(raw);
    let matched = match_channels(target, &index);
    if matched.is_empty() {
        return json!({ "channel": channel, "date": date, "programs": [] });
    }
    let mut programs = collect_programs(raw, &matched);
    programs.sort_by(|left, right| {
        left["start"]
            .as_str()
            .unwrap_or("")
            .cmp(right["start"].as_str().unwrap_or(""))
    });
    let windowed = within_window(&programs, date);
    json!({ "channel": channel, "date": date, "programs": windowed })
}

fn parse_moment(value: &str) -> Option<DateTime<FixedOffset>> {
    if let Ok(moment) = DateTime::parse_from_rfc3339(value) {
        return Some(moment);
    }
    let naive = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").ok()?;
    let offset = *Local::now().offset();
    offset.from_local_datetime(&naive).single()
}

/// 只保留 `date` 当天（本地时区）的节目；没有 date 时取前后 3/21 小时。
fn within_window(programs: &[Value], date: Option<&str>) -> Vec<Value> {
    let now = Local::now();
    let mut start_bound = now - ChronoDuration::hours(3);
    let mut end_bound = now + ChronoDuration::hours(21);
    if let Some(key) = date.map(str::trim).filter(|key| date_key().is_match(key)) {
        if let Some(begin) = NaiveDate::parse_from_str(key, "%Y-%m-%d")
            .ok()
            .and_then(|day| day.and_hms_opt(0, 0, 0))
            .and_then(|naive| Local.from_local_datetime(&naive).single())
        {
            start_bound = begin;
            end_bound = begin + ChronoDuration::days(1);
        }
    }

    let mut out = Vec::new();
    for item in programs {
        let begin = item["start"].as_str().unwrap_or("");
        let Some(start) = parse_moment(begin) else {
            out.push(item.clone());
            continue;
        };
        if start >= end_bound {
            continue;
        }
        let stop = item["stop"]
            .as_str()
            .filter(|value| !value.is_empty())
            .and_then(parse_moment);
        // 跨天节目（昨天 23:30 开始的）也要留在今天的列表里。
        match stop {
            Some(stop) => {
                if stop <= start_bound {
                    continue;
                }
            }
            None => {
                if start < start_bound {
                    continue;
                }
            }
        }
        out.push(item.clone());
    }
    out.truncate(MAX_EPG_PROGRAMS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> &'static str {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="cctv1"><display-name>CCTV-1 综合</display-name><display-name>CCTV1</display-name></channel>
  <channel id="cctv11"><display-name>CCTV-11</display-name></channel>
  <programme channel="cctv1" start="20261113060000 +0800" stop="20261113070000 +0800"><title>新闻&amp;apos;联播</title><desc>今日</desc></programme>
  <programme channel="cctv11" start="20261113060000 +0800" stop="20261113070000 +0800"><title>戏曲</title></programme>
</tv>"#
    }

    #[test]
    fn xmltv_time_is_localized() {
        assert_eq!(
            localize_time("20261113060000 +0800"),
            "2026-11-13T06:00:00+08:00"
        );
        assert_eq!(localize_time("20261113060000"), "2026-11-13T06:00:00");
        assert_eq!(localize_time("垃圾"), "垃圾");
    }

    #[test]
    fn channel_names_are_normalized_for_matching() {
        assert_eq!(norm_channel("CCTV-1 综合"), "cctv1综合");
        assert_eq!(norm_channel("东方卫视4K"), "东方卫视");
        assert_eq!(match_score("CCTV1", "CCTV11"), 0);
        assert!(match_score("CCTV1", "CCTV-1 综合") > 0);
    }

    #[test]
    fn programmes_are_filtered_by_channel() {
        let parsed = parse(sample(), "CCTV-1", Some("2026-11-13"));
        let programs = parsed["programs"].as_array().unwrap();
        assert_eq!(programs.len(), 1);
        assert_eq!(programs[0]["title"], "新闻'联播");
        assert_eq!(programs[0]["start"], "2026-11-13T06:00:00+08:00");
    }

    #[test]
    fn unknown_channel_yields_empty_list() {
        let parsed = parse(sample(), "不存在的台", None);
        assert_eq!(parsed["programs"].as_array().unwrap().len(), 0);
    }
}
