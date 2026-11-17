//! M3U / TXT live playlist parsing (spec 7.2 `live.parseM3u`).
//!
//! Ported from `sidecars/py/live.py::parse_m3u`. Only the plain M3U subset is
//! handled: `#EXTINF` attributes plus the URL line. Groups come from
//! `group-title`; channels without a group fall into `未分组`.
//!
//! Channels sharing the same name inside one group are merged into a single
//! entry whose `urls` collects every playable line (deduped, original order
//! kept). This mirrors TVBox's 线路 behaviour: a station repeated by several
//! providers becomes one chip with N switchable lines instead of N rows.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

const DEFAULT_GROUP: &str = "未分组";

fn attr_regex() -> &'static regex::Regex {
    static ATTR: OnceLock<regex::Regex> = OnceLock::new();
    ATTR.get_or_init(|| regex::Regex::new(r#"([\w-]+)="([^"]*)""#).expect("attr regex"))
}

/// TVBox 的多线路写法：`url1$url2`，每段后面还可能跟线路名
/// （`https://…/a.m3u8$LR•IPV4•2『线路1』`），所以只认 http(s) 开头的段。
pub(crate) fn split_streams(text: &str) -> Vec<String> {
    text.split('$')
        .map(str::trim)
        .filter(|part| part.starts_with("http://") || part.starts_with("https://"))
        .map(str::to_string)
        .collect()
}

struct Entry {
    name: String,
    logo: String,
    epg: String,
    group: String,
    /// 频道级请求头：`http-user-agent` / `http-referer` 是 IPTV 列表里的
    /// 通行写法，部分源站（咪咕系央视/卫视）不带它直接 404，带了才回播放
    /// 列表。空串表示该频道没声明，回落到播放源的 `lives[].ua`。
    ua: String,
    referer: String,
}

/// TVBox `http-header="Key=Value;Key=Value"`：把通用请求头属性拆成键值对。
/// 分隔按 TVBox 约定用 `;` 与 `,`；值里若仍含分隔符（URL 少见）只取第一段，
/// 宁可少拆不可拆错。空值、无 `=` 的碎片忽略。
fn split_http_header(value: &str) -> Vec<(String, String)> {
    value
        .split([';', ','])
        .map(str::trim)
        .filter_map(|pair| {
            let (key, val) = pair.split_once('=')?;
            let key = key.trim();
            let val = val.trim();
            (!key.is_empty() && !val.is_empty()).then(|| (key.to_lowercase(), val.to_string()))
        })
        .collect()
}

fn parse_extinf(line: &str) -> Entry {
    let mut attrs: HashMap<String, String> = HashMap::new();
    for capture in attr_regex().captures_iter(line) {
        let key = capture[1].to_lowercase();
        let value = capture[2].to_string();
        attrs.entry(key).or_insert(value);
    }
    let title = match line.rfind(',') {
        Some(index) => line[index + 1..].trim().to_string(),
        None => String::new(),
    };
    let name = attrs
        .get("tvg-name")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or(title);
    let group = attrs
        .get("group-title")
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_GROUP.to_string());
    let mut ua = attrs.get("http-user-agent").cloned().unwrap_or_default();
    let mut referer = attrs.get("http-referer").cloned().unwrap_or_default();
    // `http-header` 与专用属性表达同一件事，只是更通用；专用属性先声明则不被覆盖。
    if let Some(header) = attrs.get("http-header") {
        for (key, value) in split_http_header(header) {
            match key.as_str() {
                "user-agent" if ua.is_empty() => ua = value,
                "referer" | "referrer" if referer.is_empty() => referer = value,
                _ => {}
            }
        }
    }
    Entry {
        name,
        logo: attrs.get("tvg-logo").cloned().unwrap_or_default(),
        epg: attrs.get("tvg-id").cloned().unwrap_or_default(),
        group,
        ua,
        referer,
    }
}

/// 同名频道聚合：合并线路，去重且保留首次出现顺序；频道级请求头只在
/// 当前频道还没声明时补上（先出现的那家说了算，避免同名台互相覆盖）。
fn merge_channel(channel: &mut Value, streams: &[String], entry: &Entry) {
    merge_urls(channel, streams);
    for (key, value) in [("ua", &entry.ua), ("referer", &entry.referer)] {
        if value.is_empty() {
            continue;
        }
        if channel.get(key).and_then(Value::as_str).is_none() {
            channel[key] = json!(value);
        }
    }
}

fn channel_value(name: &str, streams: &[String], entry: &Entry) -> Value {
    let mut channel = serde_json::Map::new();
    channel.insert("name".to_string(), json!(name));
    channel.insert("url".to_string(), json!(streams[0]));
    channel.insert("urls".to_string(), json!(streams));
    channel.insert("logo".to_string(), json!(entry.logo));
    channel.insert("epg".to_string(), json!(entry.epg));
    // 只有真有值才写字段，免得几千条频道里多出两串空字符串。
    if !entry.ua.is_empty() {
        channel.insert("ua".to_string(), json!(entry.ua));
    }
    if !entry.referer.is_empty() {
        channel.insert("referer".to_string(), json!(entry.referer));
    }
    Value::Object(channel)
}

/// 同名频道聚合：合并线路，去重且保留首次出现顺序。
fn merge_urls(channel: &mut Value, streams: &[String]) {
    let mut urls: Vec<String> = channel["urls"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    for stream in streams {
        if !urls.contains(stream) {
            urls.push(stream.clone());
        }
    }
    channel["urls"] = json!(urls);
}

/// `{groups:[{name, channels:[{name,url,urls,logo,epg}]}], source, count}`.
pub(crate) fn parse(raw: &str, source: &str) -> Value {
    // group -> channel name -> merged channel（保持插入顺序）
    let mut groups: Vec<String> = Vec::new();
    let mut by_group: HashMap<String, Vec<String>> = HashMap::new();
    let mut channels: HashMap<(String, String), Value> = HashMap::new();

    let mut pending: Option<Entry> = None;
    let mut current_group = DEFAULT_GROUP.to_string();
    // 连续多条 URL 共用上一条 `#EXTINF`：TVBox 的 txt/m3u 列表几乎都是这个写法
    // （一个台名后面跟 N 条线路），必须并进同一个频道，否则会变成 N 个同名频道。
    let mut last_key: Option<(String, String)> = None;

    for line in raw.lines() {
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        if text.starts_with("#EXTINF") {
            let entry = parse_extinf(text);
            current_group = entry.group.clone();
            pending = Some(entry);
            continue;
        }
        if text.starts_with('#') {
            continue;
        }
        let streams = split_streams(text);
        if streams.is_empty() {
            // 不是 URL（或 `$` 后只剩线路名），没有可播地址。
            pending = None;
            continue;
        }
        if pending.is_none() {
            if let Some((group, name)) = last_key.clone() {
                // 上一条 EXTINF 的续行线路。
                let key = (group.clone(), name.clone());
                if let Some(channel) = channels.get_mut(&key) {
                    merge_urls(channel, &streams);
                }
                continue;
            }
            // 纯 URL 播放列表：保留，但名字留空（取文件名兜底）。
            let name = if text.starts_with("http") {
                String::new()
            } else {
                text.to_string()
            };
            current_group = DEFAULT_GROUP.to_string();
            pending = Some(Entry {
                name,
                logo: String::new(),
                epg: String::new(),
                group: DEFAULT_GROUP.to_string(),
                ua: String::new(),
                referer: String::new(),
            });
        }
        let Some(entry) = pending.take() else {
            continue;
        };
        let name = if entry.name.is_empty() {
            streams[0].rsplit('/').next().unwrap_or("").to_string()
        } else {
            entry.name.clone()
        };

        let group_order = by_group.entry(current_group.clone()).or_insert_with(|| {
            groups.push(current_group.clone());
            Vec::new()
        });
        let key = (current_group.clone(), name.clone());
        match channels.get_mut(&key) {
            Some(channel) => merge_channel(channel, &streams, &entry),
            None => {
                if !group_order.contains(&name) {
                    group_order.push(name.clone());
                }
                channels.insert(key.clone(), channel_value(&name, &streams, &entry));
            }
        }
        last_key = Some(key);
    }

    let mut out = Vec::new();
    for group in &groups {
        let names = by_group.get(group).cloned().unwrap_or_default();
        let list: Vec<Value> = names
            .into_iter()
            .filter_map(|name| channels.get(&(group.clone(), name)).cloned())
            .collect();
        out.push(json!({ "name": group, "channels": list }));
    }
    let count: usize = out
        .iter()
        .map(|group| group["channels"].as_array().map(Vec::len).unwrap_or(0))
        .sum();
    json!({ "groups": out, "source": source, "count": count })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extinf_attributes_and_groups_are_read() {
        let raw = "#EXTM3U\n#EXTINF:-1 tvg-id=\"cctv1\" tvg-logo=\"http://l/1.png\" group-title=\"央视\",CCTV-1 综合\nhttp://a/1.m3u8\n";
        let parsed = parse(raw, "http://a/list.txt");
        assert_eq!(parsed["count"], 1);
        let channel = &parsed["groups"][0]["channels"][0];
        assert_eq!(channel["name"], "CCTV-1 综合");
        assert_eq!(channel["group"], Value::Null);
        assert_eq!(channel["logo"], "http://l/1.png");
        assert_eq!(channel["epg"], "cctv1");
        assert_eq!(channel["url"], "http://a/1.m3u8");
    }

    #[test]
    fn same_name_channels_merge_lines_without_duplicates() {
        let raw = "#EXTINF:-1 group-title=\"央视\",CCTV1\nhttp://a/1.m3u8\n#EXTINF:-1 group-title=\"央视\",CCTV1\nhttp://a/2.m3u8\nhttp://a/1.m3u8\n";
        let parsed = parse(raw, "");
        assert_eq!(parsed["count"], 1);
        let urls = parsed["groups"][0]["channels"][0]["urls"].clone();
        assert_eq!(urls, json!(["http://a/1.m3u8", "http://a/2.m3u8"]));
    }

    #[test]
    fn line_labels_after_dollar_are_dropped() {
        let raw = "#EXTINF:-1,测试\nhttp://a/1.m3u8$LR•IPV4•2『线路1』\n";
        let parsed = parse(raw, "");
        assert_eq!(parsed["groups"][0]["channels"][0]["url"], "http://a/1.m3u8");
    }

    #[test]
    fn channels_without_group_fall_into_default_bucket() {
        let raw = "#EXTINF:-1,无分组\nhttp://a/1.m3u8\n";
        let parsed = parse(raw, "");
        assert_eq!(parsed["groups"][0]["name"], "未分组");
    }

    #[test]
    fn non_url_lines_are_skipped_and_do_not_poison_the_next_entry() {
        let raw = "#EXTINF:-1,坏行\n这不是地址\n#EXTINF:-1,好行\nhttp://a/ok.m3u8\n";
        let parsed = parse(raw, "");
        assert_eq!(parsed["count"], 1);
        assert_eq!(parsed["groups"][0]["channels"][0]["name"], "好行");
    }

    #[test]
    fn channel_level_ua_and_referer_are_kept() {
        let raw = "#EXTM3U\n#EXTINF:-1 http-user-agent=\"aliplayer\" http-referer=\"http://a/\" group-title=\"央视\",CCTV1\nhttp://a/cctv1.m3u8\n";
        let parsed = parse(raw, "");
        let channel = &parsed["groups"][0]["channels"][0];
        assert_eq!(channel["ua"], "aliplayer");
        assert_eq!(channel["referer"], "http://a/");
    }

    #[test]
    fn channels_without_ua_do_not_carry_empty_fields() {
        let raw = "#EXTM3U\n#EXTINF:-1,普通台\nhttp://a/1.m3u8\n";
        let parsed = parse(raw, "");
        let channel = &parsed["groups"][0]["channels"][0];
        assert!(channel.get("ua").is_none());
        assert!(channel.get("referer").is_none());
    }

    #[test]
    fn http_header_supplies_referer_when_no_dedicated_attr() {
        // 江苏卫视这类：UA 走行内，必需 Referer 只写在 http-header 里。
        let raw = "#EXTM3U\n#EXTINF:-1 tvg-name=\"江苏卫视\" http-user-agent=\"AptvPlayer-UA\" http-header=\"Referer=https://litchi-play-encrypted-site.jstv.com/\",江苏卫视\nhttp://a/jsws4k.m3u8\n";
        let channel = &parse(raw, "")["groups"][0]["channels"][0];
        assert_eq!(channel["ua"], "AptvPlayer-UA");
        assert_eq!(channel["referer"], "https://litchi-play-encrypted-site.jstv.com/");
    }

    #[test]
    fn http_header_splits_multiple_pairs_and_prefers_dedicated_attrs() {
        // 专用 http-referer 先声明，不被 http-header 里的 Referer 覆盖；
        // http-header 里的 User-Agent 在行内没写时才补上。
        let raw = "#EXTM3U\n#EXTINF:-1 http-referer=\"http://inline/\" http-header=\"User-Agent=aliplayer;Referer=http://other/\",X\nhttp://a/1.m3u8\n";
        let channel = &parse(raw, "")["groups"][0]["channels"][0];
        assert_eq!(channel["referer"], "http://inline/");
        assert_eq!(channel["ua"], "aliplayer");
    }

    #[test]
    fn http_header_ignores_unknown_keys() {
        let raw = "#EXTM3U\n#EXTINF:-1 http-header=\"X-Foo=bar\",Y\nhttp://a/1.m3u8\n";
        let channel = &parse(raw, "")["groups"][0]["channels"][0];
        assert!(channel.get("ua").is_none());
        assert!(channel.get("referer").is_none());
    }

    #[test]
    fn merging_same_name_channels_keeps_first_declared_headers() {
        let raw = "#EXTM3U\n#EXTINF:-1 http-user-agent=\"first\" group-title=\"央视\",CCTV1\nhttp://a/1.m3u8\n#EXTINF:-1 http-user-agent=\"second\" group-title=\"央视\",CCTV1\nhttp://b/2.m3u8\n";
        let parsed = parse(raw, "");
        let channels = parsed["groups"][0]["channels"]
            .as_array()
            .expect("channels");
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0]["ua"], "first");
        assert_eq!(
            channels[0]["urls"],
            json!(["http://a/1.m3u8", "http://b/2.m3u8"])
        );
    }
}
