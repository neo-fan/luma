//! CMS / py spider response parsing (spec 7.2 / 8.2).
//!
//! A CMS site answers `ac=list|videolist|detail` with either a JSON object
//! (`{"list": [...]}`) or an XML document
//! (`<list page="1"><video>…</video></list>`); both carry the same fields under
//! a handful of aliases. A py spider answers with whatever the community script
//! returned, so its envelope is normalized against the same field mapping here
//! (`normalize_spider_result`). Mapping lives in-process: it is pure framework
//! work, and the sidecar is reserved for third-party source scripts.
//!
//! Everything is defensive on purpose — a CMS deployment is not a schema. An
//! unexpected `list` (a string, an object) must yield an empty page, never an
//! error: the caller then shows "该站暂无结果" instead of failing the whole fan-out.

use crate::error::{code, AppError};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const VOD_FIELDS: [&str; 12] = [
    "vod_id",
    "vod_name",
    "vod_pic",
    "vod_remarks",
    "vod_content",
    "vod_year",
    "vod_area",
    "vod_actor",
    "vod_director",
    "type_name",
    "vod_play_from",
    "vod_play_url",
];

/// CMS 字段别名：不同采集站同一语义用不同的键名。
const JSON_ALIASES: [(&str, &str); 9] = [
    ("id", "vod_id"),
    ("name", "vod_name"),
    ("pic", "vod_pic"),
    ("remarks", "vod_remarks"),
    ("des", "vod_content"),
    ("content", "vod_content"),
    ("year", "vod_year"),
    ("area", "vod_area"),
    ("actor", "vod_actor"),
];

/// 一条采集结果 → 契约字段。缺的字段补空串，契约不允许 undefined。
pub(crate) fn vod(raw: &Map<String, Value>) -> Value {
    let mut item: Map<String, Value> = Map::new();
    for field in VOD_FIELDS {
        if let Some(value) = raw.get(field) {
            item.insert(field.to_string(), value.clone());
        }
    }
    for (alias, field) in JSON_ALIASES {
        if !item.contains_key(field) {
            if let Some(value) = raw.get(alias) {
                item.insert(field.to_string(), value.clone());
            }
        }
    }
    // 契约里 id 是字符串；采集站经常直接给数字。
    let id = item
        .get("vod_id")
        .map(text_of)
        .filter(|text| !text.is_empty())
        .or_else(|| raw.get("id").map(text_of))
        .unwrap_or_default();
    item.insert("vod_id".to_string(), json!(id));
    for (field, alias) in [
        ("vod_name", "name"),
        ("vod_pic", "pic"),
        ("vod_play_from", ""),
        ("vod_play_url", ""),
    ] {
        if item.get(field).map(text_of).unwrap_or_default().is_empty() {
            let fallback = if alias.is_empty() {
                String::new()
            } else {
                raw.get(alias).map(text_of).unwrap_or_default()
            };
            item.insert(field.to_string(), json!(fallback));
        }
    }
    Value::Object(item)
}

/// 任意 JSON 标量 → 字符串（Python 侧 `str()` 的等价物）。
fn text_of(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

fn as_int(value: Option<&Value>, default: i64) -> i64 {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64))
            .unwrap_or(default),
        Some(Value::String(text)) => text.trim().parse::<i64>().unwrap_or(default),
        Some(Value::Bool(flag)) => i64::from(*flag),
        _ => default,
    }
}

pub(crate) fn page_from_json(payload: &Map<String, Value>) -> Value {
    let items: Vec<Value> = match payload.get("list") {
        Some(Value::Array(list)) => list.iter().filter_map(|item| item.as_object().map(vod)).collect(),
        _ => Vec::new(),
    };
    let classes = match payload.get("class").or_else(|| payload.get("classes")) {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(key, value)| json!({ "type_id": key, "type_name": text_of(value) }))
            .collect(),
        Some(Value::Array(list)) => list.clone(),
        _ => Vec::new(),
    };
    let filters = match payload.get("filters") {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    };
    json!({
        "list": items,
        "filters": filters,
        "pagecount": as_int(payload.get("pagecount"), 1),
        "page": as_int(payload.get("page"), 1),
        "limit": as_int(payload.get("limit"), 20),
        "total": as_int(payload.get("total"), items.len() as i64),
        "classes": classes,
    })
}

/// XML 采集站：`<list page="1" pagecount="9" …><video><id>…</id>…<dl><dd flag="…">…</dd></dl></video></list>`。
fn page_from_xml(raw: &str) -> Result<Value, AppError> {
    let mut reader = Reader::from_str(raw);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut in_list = false;
    let mut list_attrs: HashMap<String, String> = HashMap::new();
    let mut videos: Vec<Value> = Vec::new();
    let mut video: Option<Map<String, Value>> = None;
    let mut field: Option<&'static str> = None;
    let mut text = String::new();
    let mut flags: Vec<String> = Vec::new();
    let mut urls: Vec<String> = Vec::new();
    let mut dd_flag: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"list" => {
                    in_list = true;
                    list_attrs = attributes(&start);
                }
                b"video" => {
                    video = Some(Map::new());
                    flags.clear();
                    urls.clear();
                }
                b"dd" => {
                    dd_flag = attributes(&start).remove("flag");
                    text.clear();
                }
                name => {
                    if let Some(key) = known_field(name) {
                        field = Some(key);
                        text.clear();
                    }
                }
            },
            Ok(Event::Empty(start)) => {
                if start.name().as_ref() == b"video" {
                    videos.push(vod(&Map::new()));
                }
            }
            Ok(Event::Text(chunk)) => {
                if field.is_some() || dd_flag.is_some() {
                    if let Ok(value) = chunk.unescape() {
                        text.push_str(&value);
                    }
                }
            }
            Ok(Event::CData(chunk)) => {
                if field.is_some() || dd_flag.is_some() {
                    text.push_str(&String::from_utf8_lossy(&chunk));
                }
            }
            Ok(Event::End(end)) => match end.name().as_ref() {
                b"list" => in_list = false,
                b"dd" => {
                    flags.push(dd_flag.take().unwrap_or_default());
                    urls.push(text.trim().to_string());
                    text.clear();
                }
                b"video" => {
                    if let Some(mut item) = video.take() {
                        item.insert("vod_play_from".to_string(), json!(flags.join("$$$")));
                        item.insert("vod_play_url".to_string(), json!(urls.join("$$$")));
                        videos.push(vod(&item));
                    }
                }
                name => {
                    if let Some(key) = known_field(name) {
                        if let Some(item) = video.as_mut() {
                            item.insert(key.to_string(), json!(text.trim()));
                        }
                        field = None;
                        text.clear();
                    }
                }
            },
            Ok(Event::Eof) => break,
            Err(error) => {
                if !in_list && videos.is_empty() {
                    return Err(AppError::new(
                        code::INVALID_ARGUMENT,
                        format!("unsupported CMS response: {error}"),
                    ));
                }
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(json!({
        "list": videos,
        "filters": {},
        "pagecount": attr_int(&list_attrs, "pagecount", 1),
        "page": attr_int(&list_attrs, "page", 1),
        "limit": attr_int(&list_attrs, "pagesize", 20),
        "total": attr_int(&list_attrs, "recordcount", videos.len() as i64),
        "classes": [],
    }))
}

fn attr_int(attrs: &HashMap<String, String>, key: &str, default: i64) -> i64 {
    attrs
        .get(key)
        .and_then(|text| text.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

fn attributes(start: &BytesStart<'_>) -> HashMap<String, String> {
    start
        .attributes()
        .flatten()
        .filter_map(|attr| {
            attr.unescape_value()
                .ok()
                .map(|value| (String::from_utf8_lossy(attr.key.as_ref()).to_string(), value.into_owned()))
        })
        .collect()
}

fn known_field(name: &[u8]) -> Option<&'static str> {
    Some(match name {
        b"id" => "vod_id",
        b"name" => "vod_name",
        b"pic" => "vod_pic",
        b"des" => "vod_content",
        b"type" => "type_name",
        _ => return None,
    })
}

pub(crate) fn parse_page(raw: &str) -> Result<Value, AppError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "empty CMS response"));
    }
    if text.starts_with('{') {
        let payload: Value = serde_json::from_str(text).map_err(|error| {
            AppError::new(
                code::INVALID_ARGUMENT,
                format!("CMS json is not an object: {error}"),
            )
        })?;
        let Some(object) = payload.as_object() else {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                "CMS json must be an object",
            ));
        };
        return Ok(page_from_json(object));
    }
    page_from_xml(text)
}

/// `ac=detail` 允许直接吐一个 vod 对象、`{"list": vod}`、或包在 `data`/`result`/`vod` 里。
fn detail_from_payload(output: &Map<String, Value>) -> Vec<Value> {
    let is_vod = |value: &Value| {
        value.as_object().is_some_and(|object| {
            ["vod_id", "vod_name", "vod_play_url", "vod_play_from", "vod_pic"]
                .iter()
                .any(|key| object.contains_key(*key))
        })
    };
    for key in ["list", "data", "result", "vod"] {
        let Some(value) = output.get(key) else {
            continue;
        };
        if let Some(list) = value.as_array() {
            return list
                .iter()
                .filter_map(|item| item.as_object().map(vod))
                .collect();
        }
        if is_vod(value) {
            if let Some(object) = value.as_object() {
                return vec![vod(object)];
            }
        }
    }
    if is_vod(&Value::Object(output.clone())) {
        return vec![vod(output)];
    }
    Vec::new()
}

/// `parseDetail`：先按分页解析（标准 `{"list": [...]}`），失败或为空再走宽松兜底。
pub(crate) fn parse_detail(raw: &str) -> Value {
    if let Ok(page) = parse_page(raw) {
        let items = page["list"].as_array().cloned().unwrap_or_default();
        if !items.is_empty() {
            return Value::Array(items);
        }
    }
    let text = raw.trim();
    if !text.starts_with('{') {
        return Value::Array(Vec::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(object)) => Value::Array(detail_from_payload(&object)),
        _ => Value::Array(Vec::new()),
    }
}

/// 空分页信封：py 源返回了非对象（`null` / 字符串 / 数组）时的兜底。
pub(crate) fn empty_page() -> Value {
    page_from_json(&Map::new())
}

/// `detailContent` 允许的所有社区形状：裸列表、单条 vod、`{"list": vod}`，或把
/// 列表 / 对象包在 `data` / `result` / `vod` 里。
fn detail_items(result: &Value) -> Vec<Value> {
    if let Some(list) = result.as_array() {
        return list.iter().filter_map(|item| item.as_object().map(vod)).collect();
    }
    match result.as_object() {
        Some(object) => detail_from_payload(object),
        None => Vec::new(),
    }
}

/// py 源返回值 → 契约信封（原 `sidecars/py/pyspider.py::_normalize`）。
///
/// `pyrun.py` 已在进程边界把结果洗成 JSON-safe，所以这里不会遇到 bound
/// method；但社区脚本仍会给出各种形状，统一在这里兜底，保证 py 与 CMS 两条
/// 链路的字段映射是同一份实现。形状不对时降级为空信封、绝不抛错：否则一个坏
/// 源会让整轮聚合搜索失败。
pub(crate) fn normalize_spider_result(method: &str, result: &Value) -> Value {
    match method {
        "detailContent" => Value::Array(detail_items(result)),
        "playerContent" | "liveContent" | "proxy" => {
            if result.is_object() {
                result.clone()
            } else {
                json!({})
            }
        }
        _ => result.as_object().map_or_else(empty_page, page_from_json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_page_keeps_aliases_and_coerces_ids() {
        let raw = r#"{"page":2,"pagecount":9,"total":120,"class":[{"type_id":"1","type_name":"电影"}],
            "list":[{"id":12,"name":"后天","pic":"http://p/1.jpg","remarks":"HD","des":"梗概"}]}"#;
        let page = parse_page(raw).unwrap();
        assert_eq!(page["page"], 2);
        assert_eq!(page["pagecount"], 9);
        assert_eq!(page["total"], 120);
        assert_eq!(page["classes"][0]["type_name"], "电影");
        let item = &page["list"][0];
        assert_eq!(item["vod_id"], "12");
        assert_eq!(item["vod_name"], "后天");
        assert_eq!(item["vod_content"], "梗概");
        assert_eq!(item["vod_play_url"], "");
    }

    #[test]
    fn classes_object_becomes_a_list() {
        let raw = r#"{"class":{"1":"电影","2":"剧集"},"list":[]}"#;
        let page = parse_page(raw).unwrap();
        assert_eq!(page["classes"][1]["type_id"], "2");
        assert_eq!(page["classes"][1]["type_name"], "剧集");
    }

    #[test]
    fn xml_page_collects_play_from_and_urls() {
        let raw = r#"<rss><list page="3" pagecount="9" pagesize="20" recordcount="170">
            <video><id>7</id><name>流浪地球</name><pic>http://p/2.jpg</pic><des>科幻</des><type>电影</type>
            <dl><dd flag="m3u8">第1集$http://a/1.m3u8</dd><dd flag="mp4">第2集$http://a/2.mp4</dd></dl>
            </video></list></rss>"#;
        let page = parse_page(raw).unwrap();
        assert_eq!(page["page"], 3);
        assert_eq!(page["pagecount"], 9);
        assert_eq!(page["limit"], 20);
        let item = &page["list"][0];
        assert_eq!(item["vod_id"], "7");
        assert_eq!(item["vod_name"], "流浪地球");
        assert_eq!(item["vod_play_from"], "m3u8$$$mp4");
        assert_eq!(item["vod_play_url"], "第1集$http://a/1.m3u8$$$第2集$http://a/2.mp4");
    }

    #[test]
    fn empty_payload_is_an_error_but_odd_lists_are_not() {
        assert!(parse_page("   ").is_err());
        let page = parse_page(r#"{"list":"oops"}"#).unwrap();
        assert_eq!(page["list"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn detail_falls_back_to_wrapped_vod_objects() {
        let wrapped = r#"{"code":1,"data":{"vod_id":9,"vod_name":"沙丘","vod_play_url":"正片$http://a/9.m3u8"}}"#;
        let items = parse_detail(wrapped);
        assert_eq!(items[0]["vod_name"], "沙丘");
        assert_eq!(items[0]["vod_id"], "9");

        let plain = r#"{"vod_id":3,"vod_name":"独立日"}"#;
        assert_eq!(parse_detail(plain)[0]["vod_name"], "独立日");

        assert_eq!(parse_detail("not json")[0], Value::Null);
    }

    #[test]
    fn spider_detail_accepts_every_community_shape() {
        let single = json!({"vod_id": 7, "vod_name": "走马上任", "vod_play_url": "正片$http://a/7.m3u8"});
        let payloads = [
            ("bare list", json!([single.clone()])),
            ("list is one object", json!({"list": single.clone()})),
            ("root is a vod", single.clone()),
            ("data alias", json!({"data": [single.clone()]})),
            ("result alias", json!({"result": single.clone()})),
            ("vod alias", json!({"vod": [single.clone()]})),
        ];
        for (label, payload) in payloads {
            let items = normalize_spider_result("detailContent", &payload);
            let list = items.as_array().unwrap_or_else(|| panic!("{label}: {items}"));
            assert_eq!(list.len(), 1, "{label}: {items}");
            assert_eq!(list[0]["vod_id"], "7", "{label}");
            assert_eq!(list[0]["vod_name"], "走马上任", "{label}");
        }
    }

    #[test]
    fn spider_shapes_that_cannot_be_videos_degrade_to_empty() {
        let detail = normalize_spider_result("detailContent", &json!({"list": []}));
        assert_eq!(detail, json!([]));
        assert_eq!(normalize_spider_result("detailContent", &json!(null)), json!([]));
        assert_eq!(normalize_spider_result("detailContent", &json!("oops")), json!([]));
        assert_eq!(normalize_spider_result("playerContent", &json!("oops")), json!({}));
        assert_eq!(normalize_spider_result("proxy", &json!([1])), json!({}));
        assert_eq!(normalize_spider_result("liveContent", &json!(null)), json!({}));
    }

    #[test]
    fn spider_play_and_live_payloads_pass_through() {
        let play = json!({"parse": 0, "url": "http://a/1.m3u8", "header": "{}"});
        assert_eq!(normalize_spider_result("playerContent", &play), play);
        let live = json!({"lives": [{"name": "CCTV1", "url": "http://a/1.m3u8"}]});
        assert_eq!(normalize_spider_result("liveContent", &live), live);
    }

    #[test]
    fn spider_page_methods_normalize_like_cms() {
        let page = normalize_spider_result(
            "searchContent",
            &json!({"page": 2, "list": [{"vod_id": "9", "name": "沙丘"}], "class": {"1": "电影"}}),
        );
        assert_eq!(page["page"], 2);
        assert_eq!(page["list"][0]["vod_name"], "沙丘");
        assert_eq!(page["classes"][0]["type_name"], "电影");

        let empty = normalize_spider_result("homeContent", &json!("oops"));
        assert_eq!(empty["list"], json!([]));
        assert_eq!(empty["page"], 1);
        assert_eq!(empty["limit"], 20);
    }
}
