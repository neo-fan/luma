//! 豆瓣元数据（详情页自动补全）。
//!
//! 详情页拿到片名后调 `douban_meta`，这里把「片名 + 可选年份」换成豆瓣条目：
//! 标题、年份、评分、评价人数、简介、导演、演员、类型、海报。前端取不到就按
//! `null` 静默回退 —— 补全只是锦上添花，不能挡住用户看片，所以网络失败一律
//! `Ok(None)`，只有**本地参数错误**（空片名、自定义代理缺前缀）才返回 `Err`。
//!
//! ## 数据来源（2026-11-15 实测）
//!
//! 1. `https://movie.douban.com/j/subject_suggest?q=<片名>`：候选列表，带
//!    `id` / `title` / `year` / `img`，用来做「标题规范化 + 年份优先」匹配。
//! 2. `https://m.douban.com/rexxar/api/v2/{tv|movie}/<id>?ck=&for_mobile=1`：
//!    详情主源（简介 / 评分 / 评价人数 / 海报 / 导演 / 演员 / 类型）。TV 条目只
//!    能用 `tv` 路径：`movie` 对 TV 会 301 到 `tv`（多一次往返），而 `tv` 对电影
//!    直接 404，所以先试 `tv` 再回落 `movie`。
//! 3. `https://movie.douban.com/j/subject_abstract?subject_id=<id>`：降级源，
//!    只有评分 / 导演 / 演员 / 类型，没有简介、评价人数和海报。
//!
//! **不做 HTML 解析**：`https://movie.douban.com/subject/<id>/` 不带 Cookie 一律
//! 302 到 `sec.douban.com` 反爬页（实测），解析它等于给自己埋一个随时失效的分支；
//! 缺字段就留空，前端按空态渲染。
//!
//! ## 代理（口径对齐 MoonTVPlus）
//!
//! 三种模式的前缀/主机映射照抄 MoonTVPlus（<https://github.com/mtvpls/MoonTVPlus>，
//! `src/lib/douban.client.ts` 的 `buildDoubanRequester` / `fetchWithTimeout`，
//! 2026-11-15 取 `main` 分支核实）：
//!
//! - `direct`：直连，不加任何前缀。
//! - `cmliussss-cdn-tencent` / `cmliussss-cdn-ali`：**主机名替换**，不是前缀拼接。
//!   `movie.douban.com` → `movie.douban.cmliussss.net` / `.com`，
//!   `m.douban.com` → `m.douban.cmliussss.net` / `.com`。这两组域名实测对
//!   suggest / abstract / rexxar 都返回同样的 JSON。
//! - `cors-proxy-zwei`：`https://ciao-cors.is-an.org/` + percent-encoded 目标 URL。
//!   该代理要求请求带 CORS 头（浏览器自动带 `Origin`，Rust 侧手工补），否则直接
//!   403 `Missing required request header. Must specify one of: origin,x-requested-with`。
//!   实测它转发到豆瓣也常被打到「登录跳转页」，**不如两个 CDN 稳**，只作备选。
//! - `custom`：`proxy_prefix` + 目标 URL，两种形态都支持 —— 前缀里带 `?` 时按
//!   `?url=<encoded>` 拼（自建代理的常见形态），以 `/` 结尾时按前缀直拼原始 URL
//!   （cors-anywhere 形态）；两者都不是时退化成 `?url=<encoded>`。
//!
//! MoonTVPlus 里还有 `cors-anywhere`（`https://cors-anywhere.com/` + 原始 URL 直拼），
//! 该服务早已对公网要求临时授权头，这里不实现。
//!
//! ## 海报
//!
//! 豆瓣图床对没有 Referer 的直连返回 418，所以 `pic` 末尾拼
//! `@Referer=https://movie.douban.com/`，前端把它交给 `/image` 反代
//! （`domain/proxy/handlers.rs` 的 `parse_vod_pic_url` 认识这种内联头），
//! 播放器侧不需要额外处理。

use crate::error::{code, AppError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use url::Url;

/// 豆瓣只认浏览器 UA：`okhttp/3.15`（仓库默认）会被 403。
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/// 豆瓣请求 Referer。suggest / abstract / rexxar 都认它。
pub const DOUBAN_REFERER: &str = "https://movie.douban.com/";

/// 海报内联 Referer 后缀，交给 `/image` 反代（见模块注释「海报」）。
pub const PIC_REFERER_SUFFIX: &str = "@Referer=https://movie.douban.com/";

/// MoonTVPlus 的 ciao-cors 前缀（主机名与前缀都已按上游源码核实）。
pub const CORS_ZWEI_PREFIX: &str = "https://ciao-cors.is-an.org/";

/// 单次请求超时。豆瓣正常 200~600ms，8s 已经够慢网兜底。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// 结果缓存：详情页前进/后退、同一部剧换集都会重复问同一个片名。
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const CACHE_CAP: usize = 128;

/// 豆瓣搜索有频率限制：几十张海报同时进视口会一次性发出几十个搜索请求，
/// 命中「搜索访问太频繁」之后所有搜索都返回空。这里串行节流并在被限流时整体冷却。
const SEARCH_MIN_GAP: Duration = Duration::from_millis(1200);
const THROTTLE_COOLDOWN: Duration = Duration::from_secs(180);

/// 前端传参（camelCase）。`proxyType` 缺省 = 直连。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubanMetaRequest {
    pub title: String,
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub proxy_type: Option<String>,
    #[serde(default)]
    pub proxy_prefix: Option<String>,
}

/// 补全结果（camelCase，与前端 `DoubanMeta` 对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubanMeta {
    pub id: String,
    pub title: String,
    pub year: String,
    pub rating: f32,
    pub rating_count: u64,
    pub intro: String,
    pub directors: Vec<String>,
    pub actors: Vec<String>,
    pub genres: Vec<String>,
    /// 已拼好 `@Referer=` 内联头的海报地址；取不到时是空串。
    pub pic: String,
    pub url: String,
}

/// 代理模式。认不出的值一律直连：代理只是取数通道，配错不该把功能弄没。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyKind {
    Direct,
    Custom,
    CdnTencent,
    CdnAli,
    CorsZwei,
}

impl ProxyKind {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "custom" => Self::Custom,
            "cmliussss-cdn-tencent" => Self::CdnTencent,
            "cmliussss-cdn-ali" => Self::CdnAli,
            "cors-proxy-zwei" => Self::CorsZwei,
            "direct" | "" => Self::Direct,
            _ => Self::Direct,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Custom => "custom",
            Self::CdnTencent => "cmliussss-cdn-tencent",
            Self::CdnAli => "cmliussss-cdn-ali",
            Self::CorsZwei => "cors-proxy-zwei",
        }
    }
}

/// 把豆瓣原始 URL 换成实际要请求的 URL。
///
/// `custom` 的前缀为空算本地参数错误（用户选了自定义却没填），其余模式永远
/// 能给出一个可请求的 URL —— 内建 CDN 只认豆瓣那几个主机，遇到不认识的原样放行。
pub fn proxy_url(kind: ProxyKind, prefix: &str, target: &str) -> Result<String, AppError> {
    match kind {
        ProxyKind::Direct => Ok(target.to_string()),
        ProxyKind::CdnTencent | ProxyKind::CdnAli => {
            Ok(rewrite_cdn_host(kind, target).unwrap_or_else(|| target.to_string()))
        }
        ProxyKind::CorsZwei => Ok(format!("{CORS_ZWEI_PREFIX}{}", percent_encode(target))),
        ProxyKind::Custom => {
            let base = prefix.trim();
            if base.is_empty() {
                return Err(AppError::new(
                    code::INVALID_ARGUMENT,
                    "自定义豆瓣代理缺少前缀",
                ));
            }
            if base.contains('?') {
                // `?url=` 形态：`https://p.example/?url=<encoded>`。
                if base.ends_with('=') {
                    Ok(format!("{base}{}", percent_encode(target)))
                } else if base.ends_with('?') || base.ends_with('&') {
                    Ok(format!("{base}url={}", percent_encode(target)))
                } else {
                    Ok(format!("{base}&url={}", percent_encode(target)))
                }
            } else if base.ends_with('/') {
                // 前缀直拼形态：`https://p.example/https://movie.douban.com/...`
                // （cors-anywhere 这类代理只认裸 URL，不能再编码）。
                Ok(format!("{base}{target}"))
            } else {
                // 既没有 `?` 也没有结尾 `/`，无法安全直拼，退化成 `?url=`。
                Ok(format!("{base}?url={}", percent_encode(target)))
            }
        }
    }
}

/// 内建 CDN 的主机替换表（上游把三条路径都写死在构造 URL 的分支里）。
fn rewrite_cdn_host(kind: ProxyKind, target: &str) -> Option<String> {
    let mut url = Url::parse(target).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let mapped = match (kind, host.as_str()) {
        (ProxyKind::CdnTencent, "movie.douban.com") => "movie.douban.cmliussss.net",
        (ProxyKind::CdnTencent, "m.douban.com") => "m.douban.cmliussss.net",
        (ProxyKind::CdnAli, "movie.douban.com") => "movie.douban.cmliussss.com",
        (ProxyKind::CdnAli, "m.douban.com") => "m.douban.cmliussss.com",
        _ => return None,
    };
    url.set_host(Some(mapped)).ok()?;
    Some(url.into())
}

/// RFC 3986 unreserved 之外全编码（`encodeURIComponent` 的保守版）。
fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 3);
    for byte in raw.as_bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 海报补 Referer。已有内联头的不重复拼（幂等）。
pub fn with_pic_referer(pic: &str) -> String {
    let trimmed = pic.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains("@Referer=") || trimmed.contains("@referer=") {
        return trimmed.to_string();
    }
    format!("{trimmed}{PIC_REFERER_SUFFIX}")
}

// ---- 标题匹配 -------------------------------------------------------------

/// 候选（`subject_suggest` 的一行）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SuggestItem {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub sub_title: String,
    #[serde(default)]
    pub year: String,
    #[serde(default)]
    pub img: String,
    #[serde(default)]
    pub url: String,
}

impl SuggestItem {
    /// 展示用标题：`title` 偶尔为空（只有 `sub_title`）。
    pub fn display_title(&self) -> &str {
        let title = self.title.trim();
        if title.is_empty() {
            self.sub_title.trim()
        } else {
            title
        }
    }
}

/// 标题规范化：半角化 → 去掉括号里的年份 → 去空白/分隔符 → 小写 → 去季/部尾缀。
///
/// 「庆余年」「庆余年 第一季」「庆余年 第一季‎ (2019)」「庆余年（第二季）」最后都
/// 落到同一个键上，季与年份留给打分阶段处理。
pub fn normalize_title(raw: &str) -> String {
    let stripped = drop_year_brackets(raw);
    let half_width = to_half_width(&stripped);
    let spaced = strip_tv_suffix(&half_width);
    let compact: String = spaced
        .chars()
        .filter(|ch| !is_title_noise(*ch))
        .collect::<String>()
        .to_ascii_lowercase();
    strip_season_suffix(&compact).to_string()
}

/// 去掉尾巴上的 `S2` / `Season 1`。
///
/// 必须在压掉空白**之前**做，并且要求前面有空白边界 —— 否则
/// `ghostbusters2` 会被削成 `ghostbuster`，两部作品就混了。
fn strip_tv_suffix(spaced: &str) -> &str {
    let trimmed = spaced.trim_end();
    let mut cut = trimmed.len();
    let mut digits = 0;
    for ch in trimmed.chars().rev() {
        if ch.is_ascii_digit() && digits < 2 {
            digits += 1;
            cut -= ch.len_utf8();
        } else {
            break;
        }
    }
    if digits == 0 {
        return spaced;
    }
    let head = trimmed[..cut].trim_end();
    // `to_ascii_lowercase` 不改变字节长度，所以 rest 的下标可以回指 head。
    let lower = head.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_suffix("season")
        .or_else(|| lower.strip_suffix('s'))
    else {
        return spaced;
    };
    let Some(last) = rest.chars().last() else {
        // 标题本身就是 `S2` / `season 1`，别清空。
        return spaced;
    };
    if !last.is_whitespace() {
        return spaced;
    }
    head[..rest.trim_end().len()].trim_end()
}

fn to_half_width(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            let point = ch as u32;
            if (0xFF01..=0xFF5E).contains(&point) {
                char::from_u32(point - 0xFEE0).unwrap_or(ch)
            } else if point == 0x3000 {
                ' '
            } else {
                ch
            }
        })
        .collect()
}

fn is_title_noise(ch: char) -> bool {
    matches!(
        ch,
        ' ' | '·'
            | '・'
            | ':'
            | '：'
            | ','
            | '，'
            | '.'
            | '。'
            | '、'
            | '-'
            | '_'
            | '—'
            | '–'
            | '~'
            | '～'
            | '!'
            | '！'
            | '?'
            | '？'
            | '"'
            | '“'
            | '”'
            | '\''
            | '‘'
            | '’'
            | '('
            | ')'
            | '（'
            | '）'
            | '['
            | ']'
            | '【'
            | '】'
            | '<'
            | '>'
            | '《'
            | '》'
            | '|'
            | '/'
            | '\\'
            | '&'
            | '+'
            // 豆瓣标题里混的不可见排版标记（U+200E 等），不洗掉会卡住季号剥离。
            | '\u{200e}'
            | '\u{200f}'
            | '\u{200b}'
            | '\u{feff}'
    )
}

/// 去掉只含四位年份的括号组，如 `(2019)` / `（2019）` / `[2019]`。
///
/// 只认「括号里恰好四位数字」的情况，所以 `(TV版)`、`(上)` 之类原样保留。
fn drop_year_brackets(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut buffered = String::new();
    let mut open: Option<char> = None;
    for ch in raw.chars() {
        match open {
            None => {
                if matches!(ch, '(' | '（' | '[' | '【' | '{') {
                    open = Some(ch);
                    buffered.clear();
                } else {
                    out.push(ch);
                }
            }
            Some(bracket) => {
                let close = match bracket {
                    '(' => ')',
                    '（' => '）',
                    '[' => ']',
                    '【' => '】',
                    _ => '}',
                };
                if ch == close {
                    let only_year =
                        buffered.len() == 4 && buffered.chars().all(|c| c.is_ascii_digit());
                    if !only_year {
                        out.push(bracket);
                        out.push_str(&buffered);
                        out.push(ch);
                    }
                    open = None;
                    buffered.clear();
                } else {
                    buffered.push(ch);
                }
            }
        }
    }
    if let Some(bracket) = open {
        out.push(bracket);
        out.push_str(&buffered);
    }
    out
}

fn strip_season_suffix(mut title: &str) -> &str {
    loop {
        let next = strip_one_season(title);
        if next.len() == title.len() {
            return title;
        }
        title = next;
    }
}

fn strip_one_season(title: &str) -> &str {
    // 第N季 / 第N部 / 第N期
    if let Some(pos) = title.rfind('第') {
        let tail = &title[pos + '第'.len_utf8()..];
        if let Some(last) = tail.chars().last() {
            if matches!(last, '季' | '部' | '期') {
                let number = &tail[..tail.len() - last.len_utf8()];
                if !number.is_empty() && number.chars().all(is_number_char) {
                    return &title[..pos];
                }
            }
        }
    }
    // seasonN（`Season 1` 这种带空白的形态已经在 strip_tv_suffix 里处理）
    if let Some(pos) = title.rfind("season") {
        let tail = &title[pos + "season".len()..];
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            return &title[..pos];
        }
    }
    title
}

fn is_number_char(ch: char) -> bool {
    ch.is_ascii_digit()
        || matches!(
            ch,
            '零' | '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十' | '两'
        )
}

/// 候选打分，`None` = 「不是同一部」。
///
/// 只在「规范化后相等」或「多出 4 个字符以内」的尾缀关系上给分，保守优先：
/// 匹配错一部作品的代价（详情页挂错海报/简介）比漏匹配大得多。
/// 分数取值是行为约定的一部分（测试按它断言）：
/// 完全相同 100 > 候选多了尾缀 90 > 查询多了尾缀 85。
pub fn title_score(query: &str, candidate: &str) -> Option<u32> {
    let query = normalize_title(query);
    let candidate = normalize_title(candidate);
    if query.is_empty() || candidate.is_empty() {
        return None;
    }
    if query == candidate {
        return Some(100);
    }
    let query_len = query.chars().count();
    let candidate_len = candidate.chars().count();
    if candidate.starts_with(&query) && candidate_len - query_len <= 4 {
        return Some(90);
    }
    if query.starts_with(&candidate) && query_len - candidate_len <= 4 && candidate_len >= 2 {
        return Some(85);
    }
    None
}

fn year_bonus(wanted: Option<&str>, candidate: &str) -> i64 {
    let Some(wanted) = wanted.and_then(|raw| raw.trim().parse::<i64>().ok()) else {
        return 0;
    };
    let Ok(found) = candidate.trim().parse::<i64>() else {
        return 0;
    };
    match (found - wanted).abs() {
        0 => 20,
        1 => 10,
        _ => 0,
    }
}

/// 在候选里挑最像的一条：标题分 + 年份加成，同分保留先出现的
/// （`subject_suggest` 自己按相关度排过序）。
pub fn pick_candidate<'a>(
    items: &'a [SuggestItem],
    title: &str,
    year: Option<&str>,
) -> Option<&'a SuggestItem> {
    let mut best: Option<(i64, &SuggestItem)> = None;
    for item in items {
        let Some(score) = title_score(title, item.display_title()) else {
            continue;
        };
        let total = score as i64 + year_bonus(year, &item.year);
        // `Option::is_none_or` 要 1.82，仓库 MSRV 是 1.77.2，这里用 match。
        let better = match best {
            None => true,
            Some((top, _)) => total > top,
        };
        if better {
            best = Some((total, item));
        }
    }
    best.map(|(_, item)| item)
}

// ---- 抓取 -----------------------------------------------------------------

fn douban_error(message: impl Into<String>, cause: impl Into<String>) -> AppError {
    AppError::new(code::CONFIG_FETCH_FAIL, message).with_cause(cause)
}

async fn get_text(
    kind: ProxyKind,
    prefix: &str,
    target: &str,
    referer: &str,
    accept: &str,
) -> Result<String, AppError> {
    let url = proxy_url(kind, prefix, target)?;
    let client = crate::http::shared_client()?;
    let mut request = client
        .get(&url)
        .timeout(REQUEST_TIMEOUT)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::ACCEPT, accept)
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9");
    if kind == ProxyKind::CorsZwei {
        // ciao-cors 拿不到浏览器自动加的 CORS 头就直接 403，这里手工补一个。
        request = request.header(reqwest::header::ORIGIN, "https://movie.douban.com");
    }
    let response = request
        .send()
        .await
        .map_err(|err| douban_error("豆瓣请求失败", err.to_string()))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|err| douban_error("豆瓣响应读取失败", err.to_string()))?;
    // 外部字节一律先洗成 UTF-8 再解析（反爬页可能是 GBK）。
    let body = crate::textio::decode(&bytes);
    if !status.is_success() {
        let preview: String = body.chars().take(300).collect();
        return Err(douban_error(
            format!("豆瓣返回 HTTP {}", status.as_u16()),
            preview.trim().to_string(),
        ));
    }
    Ok(body)
}

async fn get_json(kind: ProxyKind, prefix: &str, target: &str) -> Result<Value, AppError> {
    let body = get_text(
        kind,
        prefix,
        target,
        DOUBAN_REFERER,
        "application/json, text/plain, */*",
    )
    .await?;
    serde_json::from_str(&body).map_err(|err| {
        douban_error(
            "豆瓣返回的不是 JSON",
            format!("{} | {}", err, body.chars().take(300).collect::<String>()),
        )
    })
}

fn json_str(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn json_f32(value: &Value) -> Option<f32> {
    match value {
        Value::Number(number) => number.as_f64().map(|found| found as f32),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn json_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_f64().map(|found| found.max(0.0) as u64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// `["孙皓"]`（abstract）与 `[{"name":"孙皓"}]`（rexxar）两种形态都要吃。
fn names_of(value: &Value, key: &str) -> Vec<String> {
    let Some(rows) = value.get(key).and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| match row {
            Value::String(name) => Some(name.trim().to_string()),
            Value::Object(_) => json_str(row, "name").map(|name| name.trim().to_string()),
            _ => None,
        })
        .filter(|name| !name.is_empty())
        .collect()
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.as_str().map(|text| text.trim().to_string()))
                .filter(|text| !text.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn pic_of(value: &Value) -> Option<String> {
    let pic = value.get("pic")?;
    for key in ["large", "normal", "small"] {
        if let Some(url) = json_str(pic, key) {
            if !url.trim().is_empty() {
                return Some(url);
            }
        }
    }
    None
}

/// abstract 的 `title` 形如 `庆余年 第一季‎ (2019)`（带 U+200E），rexxar 的是干净的。
fn clean_detail_title(raw: &str) -> String {
    let mut title = trim_invisible(raw);
    if title.ends_with(')') {
        if let Some(open) = title[..title.len() - 1].rfind('(') {
            let inner = &title[open + 1..title.len() - 1];
            if inner.len() == 4 && inner.chars().all(|ch| ch.is_ascii_digit()) {
                title = trim_invisible(&title[..open]);
            }
        }
    }
    title.to_string()
}

/// 去掉首尾空白与不可见的排版标记（豆瓣标题里会混 U+200E）。
fn trim_invisible(raw: &str) -> &str {
    raw.trim_matches(|ch: char| {
        ch.is_whitespace() || matches!(ch, '\u{200e}' | '\u{200f}' | '\u{200b}' | '\u{feff}')
    })
}

fn apply_detail(meta: &mut DoubanMeta, detail: &Value) {
    if let Some(title) = json_str(detail, "title") {
        let cleaned = clean_detail_title(&title);
        if !cleaned.is_empty() {
            meta.title = cleaned;
        }
    }
    if let Some(year) = json_str(detail, "year").or_else(|| json_str(detail, "release_year")) {
        if !year.trim().is_empty() {
            meta.year = year.trim().to_string();
        }
    }
    if let Some(rating) = detail.get("rating").and_then(|value| value.get("value")) {
        if let Some(found) = json_f32(rating) {
            meta.rating = found;
        }
    } else if let Some(rate) = json_str(detail, "rate") {
        // abstract 只有字符串 `rate`（"7.9"）。
        if let Ok(found) = rate.trim().parse::<f32>() {
            meta.rating = found;
        }
    }
    if let Some(count) = detail
        .get("rating")
        .and_then(|value| value.get("count"))
        .and_then(json_u64)
    {
        meta.rating_count = count;
    }
    if let Some(intro) = json_str(detail, "intro") {
        meta.intro = intro.trim().to_string();
    }
    let directors = names_of(detail, "directors");
    if !directors.is_empty() {
        meta.directors = directors;
    }
    let actors = names_of(detail, "actors");
    if !actors.is_empty() {
        meta.actors = actors;
    }
    // rexxar 用 `genres`，abstract 用 `types`。
    let mut genres = string_list(detail, "genres");
    if genres.is_empty() {
        genres = string_list(detail, "types");
    }
    if !genres.is_empty() {
        meta.genres = genres;
    }
    if let Some(pic) = pic_of(detail) {
        meta.pic = pic;
    }
    if let Some(url) = json_str(detail, "url") {
        if !url.trim().is_empty() {
            meta.url = url.trim().to_string();
        }
    }
}

fn parse_suggest(body: &Value) -> Vec<SuggestItem> {
    body.as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| serde_json::from_value::<SuggestItem>(row.clone()).ok())
                .filter(|item| !item.id.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 移动端搜索接口的候选：`{"subjects":{"items":[{"target":{...}}]}}`。
///
/// 这是 2026-11-15 之后实际还能用的入口 —— `j/subject_suggest` 对没有 cookie
/// 的请求一律返回 `[]`（HTTP 200 但空数组），候选主路径因此换成这里。
fn parse_search_subjects(body: &Value) -> Vec<SuggestItem> {
    body.get("subjects")
        .and_then(|subjects| subjects.get("items"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let target = row.get("target")?;
                    let id = json_str(target, "id")?;
                    if id.trim().is_empty() {
                        return None;
                    }
                    Some(SuggestItem {
                        id,
                        title: json_str(target, "title").unwrap_or_default(),
                        sub_title: String::new(),
                        year: json_str(target, "year").unwrap_or_default(),
                        img: json_str(target, "cover_url").unwrap_or_default(),
                        url: String::new(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 搜索页 HTML 里内嵌的 `window.__DATA__ = {...}`。
///
/// `movie.douban.com/subject_search?search_text=<片名>` 至今仍是明文 JSON（不像
/// 部分豆瓣页面会加密成 `__DATA__ = "..."`），所以直接做括号配对取出对象，
/// 不做整页 HTML 解析。
fn search_page_data(html: &str) -> Option<Value> {
    let marker = "__DATA__ = ";
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let first = rest.find('{')?;
    let body = &rest[first..];
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in body.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return serde_json::from_str(&body[..=index]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

/// 搜索页候选：`__DATA__` 里的 `items[]`，字段是 `id`（数字）/`title`（含年份）/`cover_url`。
#[cfg(test)]
fn parse_search_page(html: &str) -> Vec<SuggestItem> {
    let Some(data) = search_page_data(html) else {
        return Vec::new();
    };
    parse_search_data(&data)
}

fn parse_search_data(data: &Value) -> Vec<SuggestItem> {
    let Some(rows) = data.get("items").and_then(Value::as_array) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row
                .get("id")
                .and_then(|value| match value {
                    Value::String(text) => Some(text.clone()),
                    Value::Number(number) => Some(number.to_string()),
                    _ => None,
                })?;
            if id.trim().is_empty() {
                return None;
            }
            let title = json_str(row, "title").unwrap_or_default();
            Some(SuggestItem {
                id,
                year: trailing_year(&title),
                title,
                sub_title: String::new(),
                img: json_str(row, "cover_url").unwrap_or_default(),
                url: json_str(row, "url").unwrap_or_default(),
            })
        })
        .collect()
}

/// 从 `后会友期‎ (2026)` 这种标题尾巴取年份；取不到返回空串。
fn trailing_year(title: &str) -> String {
    let trimmed = title.trim_end();
    if !trimmed.ends_with(')') {
        return String::new();
    }
    let Some(open) = trimmed[..trimmed.len() - 1].rfind('(') else {
        return String::new();
    };
    let inner = &trimmed[open + 1..trimmed.len() - 1];
    if inner.len() == 4 && inner.chars().all(|ch| ch.is_ascii_digit()) {
        inner.to_string()
    } else {
        String::new()
    }
}

static DOUBAN_GATE: OnceLock<tokio::sync::Mutex<Instant>> = OnceLock::new();
static DOUBAN_COOLDOWN: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

/// 所有豆瓣搜索串行发送，且两次之间至少间隔 `SEARCH_MIN_GAP`。
async fn pace_douban() {
    let gate = DOUBAN_GATE
        .get_or_init(|| tokio::sync::Mutex::new(Instant::now() - SEARCH_MIN_GAP));
    let mut last = gate.lock().await;
    let wait = (*last + SEARCH_MIN_GAP).saturating_duration_since(Instant::now());
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    *last = Instant::now();
}

/// 豆瓣已经在限流窗口里：这期间不再发搜索，直接回退到源站数据。
fn douban_cooling() -> bool {
    let cooldown = DOUBAN_COOLDOWN.get_or_init(|| Mutex::new(None));
    match cooldown.lock() {
        Ok(guard) => guard.is_some_and(|until| until > Instant::now()),
        Err(_) => false,
    }
}

fn cool_down_douban() {
    let cooldown = DOUBAN_COOLDOWN.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cooldown.lock() {
        *guard = Some(Instant::now() + THROTTLE_COOLDOWN);
    }
}

/// 候选搜索：老接口 `subject_suggest` → 搜索页 `__DATA__` → 移动端搜索接口。
///
/// 2026-11-15 实测：`subject_suggest` 对无 cookie 请求恒返回 `[]`；
/// `m.douban.com/rexxar/api/v2/search/subjects` 很快会变成 `need_login` 403；
/// 搜索页 `subject_search` 仍稳定返回明文结果，因此放在第二顺位。
async fn search_candidates(kind: ProxyKind, prefix: &str, title: &str) -> Vec<SuggestItem> {
    if douban_cooling() {
        tracing::debug!(title, "douban search skipped during cooldown");
        return Vec::new();
    }
    pace_douban().await;

    let target = format!(
        "https://movie.douban.com/j/subject_suggest?q={}",
        percent_encode(title)
    );
    match get_json(kind, prefix, &target).await {
        Ok(body) => {
            let items = parse_suggest(&body);
            if !items.is_empty() {
                return items;
            }
            tracing::warn!(title, "douban suggest returned no subjects");
        }
        Err(err) => {
            tracing::warn!(code = %err.code, error = %err.message, "douban suggest failed");
        }
    }

    let target = format!(
        "https://movie.douban.com/subject_search?search_text={}",
        percent_encode(title)
    );
    match get_text(kind, prefix, &target, DOUBAN_REFERER, "text/html, */*").await {
        Ok(html) => {
            match search_page_data(&html) {
                Some(data) => {
                    let error = data
                        .get("error_info")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    if !error.is_empty() {
                        tracing::warn!(title, error, "douban search throttled, cooling down");
                        cool_down_douban();
                        return Vec::new();
                    }
                    let items = parse_search_data(&data);
                    if !items.is_empty() {
                        return items;
                    }
                    tracing::warn!(title, "douban search page returned no subjects");
                }
                None => tracing::warn!(title, "douban search page had no embedded data"),
            }
        }
        Err(err) => {
            tracing::warn!(code = %err.code, error = %err.message, "douban search page failed");
        }
    }

    let target = format!(
        "https://m.douban.com/rexxar/api/v2/search/subjects?q={}",
        percent_encode(title)
    );
    match get_json(kind, prefix, &target).await {
        Ok(body) => parse_search_subjects(&body),
        Err(err) => {
            tracing::warn!(code = %err.code, error = %err.message, "douban mobile search failed");
            Vec::new()
        }
    }
}

/// 详情：先 `tv` 再 `movie`，都不行退到 `subject_abstract`。
async fn fetch_detail(kind: ProxyKind, prefix: &str, id: &str) -> Option<Value> {
    if douban_cooling() {
        tracing::debug!(id, "douban detail skipped during cooldown");
        return None;
    }
    for path in ["tv", "movie"] {
        pace_douban().await;
        let target = format!(
            "https://m.douban.com/rexxar/api/v2/{path}/{}?ck=&for_mobile=1",
            percent_encode(id)
        );
        match get_json(kind, prefix, &target).await {
            Ok(value) => {
                if value.get("title").is_some() {
                    return Some(value);
                }
                tracing::warn!(id, path, "douban rexxar returned an empty subject");
            }
            Err(err) => {
                tracing::warn!(id, path, code = %err.code, error = %err.message, "douban rexxar failed");
            }
        }
    }
    let target = format!(
        "https://movie.douban.com/j/subject_abstract?subject_id={}",
        percent_encode(id)
    );
    match get_json(kind, prefix, &target).await {
        Ok(value) => value.get("subject").cloned(),
        Err(err) => {
            tracing::warn!(id, code = %err.code, error = %err.message, "douban abstract failed");
            None
        }
    }
}

async fn build_meta(
    kind: ProxyKind,
    prefix: &str,
    item: &SuggestItem,
    year: Option<&str>,
) -> DoubanMeta {
    let mut meta = DoubanMeta {
        id: item.id.trim().to_string(),
        title: item.display_title().to_string(),
        year: item.year.trim().to_string(),
        rating: 0.0,
        rating_count: 0,
        intro: String::new(),
        directors: Vec::new(),
        actors: Vec::new(),
        genres: Vec::new(),
        pic: String::new(),
        url: format!("https://movie.douban.com/subject/{}/", item.id.trim()),
    };
    if let Some(detail) = fetch_detail(kind, prefix, &item.id).await {
        apply_detail(&mut meta, &detail);
    }
    if meta.year.is_empty() {
        // 详情和 suggest 都没给年份时，退回调用方给的那一年（至少入口一致）。
        if let Some(year) = year {
            meta.year = year.to_string();
        }
    }
    let pic = if meta.pic.trim().is_empty() {
        item.img.as_str()
    } else {
        meta.pic.as_str()
    };
    meta.pic = with_pic_referer(pic);
    meta
}

/// 一次补全：suggest 选优 → rexxar/abstract 补详情。
///
/// 网络层失败一律 `Ok(None)`（前端静默回退），参数错误才 `Err`。
pub async fn fetch(req: &DoubanMetaRequest) -> Result<Option<DoubanMeta>, AppError> {
    let title = req.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "豆瓣查询需要片名"));
    }
    let kind = ProxyKind::parse(req.proxy_type.as_deref());
    let prefix = req.proxy_prefix.as_deref().unwrap_or("").trim().to_string();
    if kind == ProxyKind::Custom && prefix.is_empty() {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "自定义豆瓣代理缺少前缀",
        ));
    }
    let year = req
        .year
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    let key = cache_key(&title, year.as_deref());
    if let Some(hit) = cache_get(&key) {
        return Ok(Some(hit));
    }
    if douban_cooling() {
        tracing::debug!(title, "douban meta skipped during cooldown");
        return Ok(None);
    }

    let items = search_candidates(kind, &prefix, &title).await;
    let Some(item) = pick_candidate(&items, &title, year.as_deref()) else {
        tracing::info!(title = %title, candidates = items.len(), "douban: no matching subject");
        return Ok(None);
    };
    let meta = build_meta(kind, &prefix, item, year.as_deref()).await;
    cache_put(key, &meta);
    Ok(Some(meta))
}

/// 详情页自动补全。参数扁平（camelCase：`proxyType` / `proxyPrefix`），
/// 与 `src/lib/douban.ts` 的 `invoke("douban_meta", {...})` 对齐。
#[tauri::command]
pub async fn douban_meta(
    title: String,
    year: Option<String>,
    proxy_type: Option<String>,
    proxy_prefix: Option<String>,
) -> Result<Option<DoubanMeta>, AppError> {
    let req = DoubanMetaRequest {
        title,
        year,
        proxy_type,
        proxy_prefix,
    };
    fetch(&req).await
}

// ---- 缓存 -----------------------------------------------------------------

struct Cached {
    at: Instant,
    meta: DoubanMeta,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(title: &str, year: Option<&str>) -> String {
    format!("{}|{}", normalize_title(title), year.unwrap_or(""))
}

fn cache_get(key: &str) -> Option<DoubanMeta> {
    let guard = cache().lock().ok()?;
    let hit = guard.get(key)?;
    if hit.at.elapsed() > CACHE_TTL {
        return None;
    }
    Some(hit.meta.clone())
}

fn cache_put(key: String, meta: &DoubanMeta) {
    let Ok(mut guard) = cache().lock() else {
        return;
    };
    if guard.len() >= CACHE_CAP {
        guard.retain(|_, entry| entry.at.elapsed() <= CACHE_TTL);
    }
    guard.insert(
        key,
        Cached {
            at: Instant::now(),
            meta: meta.clone(),
        },
    );
}

#[cfg(test)]
fn clear_cache() {
    if let Ok(mut guard) = cache().lock() {
        guard.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn suggest(id: &str, title: &str, year: &str) -> SuggestItem {
        SuggestItem {
            id: id.into(),
            title: title.into(),
            year: year.into(),
            ..SuggestItem::default()
        }
    }

    fn meta() -> DoubanMeta {
        DoubanMeta {
            id: "25853071".into(),
            title: "庆余年 第一季".into(),
            year: "2019".into(),
            rating: 7.9,
            rating_count: 1_176_890,
            intro: "某大学文学史专业的学生张庆熟读古典名著".into(),
            directors: vec!["孙皓".into()],
            actors: vec!["张若昀".into(), "李沁".into()],
            genres: vec!["剧情".into(), "古装".into()],
            pic: "https://img3.doubanio.com/p.jpg@Referer=https://movie.douban.com/".into(),
            url: "https://movie.douban.com/subject/25853071/".into(),
        }
    }

    #[test]
    fn normalize_collapses_title_variants() {
        // 空格、全角括号年份、季尾缀、LTR 标记都该被抹平。
        for raw in [
            "庆余年",
            "庆余年 第一季",
            "庆余年 第一季‎ (2019)",
            "庆余年（第二季）",
            "庆余年 第2季",
            "  庆余年  ",
        ] {
            assert_eq!(normalize_title(raw), "庆余年", "raw={raw}");
        }
        assert_eq!(normalize_title("THE LAST OF US Season 1"), "thelastofus");
        assert_eq!(normalize_title("Loki S2"), "loki");
        // 只含年份的括号被去掉，其他括号原样保留。
        assert_eq!(normalize_title("沙丘(2021)"), "沙丘");
        assert_eq!(normalize_title("沙丘(TV版)"), "沙丘tv版");
    }

    #[test]
    fn title_score_orders_by_similarity() {
        assert_eq!(title_score("庆余年 第一季", "庆余年 第二季"), Some(100));
        assert_eq!(title_score("庆余年", "庆余年 第一季"), Some(100));
        assert_eq!(title_score("开心超人", "开心超人联盟"), Some(90));
        assert_eq!(title_score("开心超人联盟", "开心超人"), Some(85));
        assert_eq!(title_score("爱情公寓", "爱情公寓5 电视剧"), Some(90));
        assert_eq!(title_score("爱情公寓5", "爱情公寓"), Some(85));
        assert_eq!(title_score("流浪地球", "流浪"), Some(85));
        assert_eq!(title_score("流浪地球", "三体"), None);
        assert_eq!(title_score("", "三体"), None);
        assert_eq!(title_score("庆余年", "庆余年 番外篇"), Some(90));
        // 超出 4 个字符的尾缀不当成同一部。
        assert_eq!(title_score("三体", "三体 动画版 全三季合集"), None);
    }

    #[test]
    fn pick_candidate_prefers_matching_year() {
        let items = vec![
            suggest("34937650", "庆余年 第二季", "2024"),
            suggest("25853071", "庆余年 第一季", "2019"),
        ];
        let picked = pick_candidate(&items, "庆余年", Some("2019")).expect("match");
        assert_eq!(picked.id, "25853071", "年份相同的那一季优先");
        let picked = pick_candidate(&items, "庆余年", Some("2024")).expect("match");
        assert_eq!(picked.id, "34937650");
        // 没有年份线索时保留 suggest 的原顺序（豆瓣已按相关度排过）。
        let picked = pick_candidate(&items, "庆余年", None).expect("match");
        assert_eq!(picked.id, "34937650");
    }

    #[test]
    fn pick_candidate_returns_none_when_nothing_matches() {
        let items = vec![suggest("1", "三体", "2023")];
        assert!(pick_candidate(&items, "庆余年", Some("2019")).is_none());
        assert!(pick_candidate(&[], "庆余年", None).is_none());
        // 空 id 的候选在 parse 阶段就被丢掉，这里再确认不 panic。
        let items = vec![suggest("", "庆余年", "2019")];
        assert!(pick_candidate(&items, "庆余年", None).is_some());
    }

    #[test]
    fn proxy_url_direct_keeps_target() {
        let target = "https://movie.douban.com/j/subject_suggest?q=%E5%BA%86";
        assert_eq!(
            proxy_url(ProxyKind::Direct, "", target).expect("direct"),
            target
        );
        assert_eq!(
            proxy_url(ProxyKind::parse(None), "", target).expect("default"),
            target
        );
        // 认不出的模式退回直连，不报错。
        assert_eq!(
            proxy_url(ProxyKind::parse(Some("no-such-proxy")), "", target).expect("unknown"),
            target
        );
    }

    #[test]
    fn proxy_url_cdn_rewrites_douban_hosts() {
        let suggest = "https://movie.douban.com/j/subject_suggest?q=%E5%BA%86";
        assert_eq!(
            proxy_url(ProxyKind::CdnTencent, "", suggest).expect("tencent"),
            "https://movie.douban.cmliussss.net/j/subject_suggest?q=%E5%BA%86"
        );
        assert_eq!(
            proxy_url(ProxyKind::CdnAli, "", suggest).expect("ali"),
            "https://movie.douban.cmliussss.com/j/subject_suggest?q=%E5%BA%86"
        );
        let rexxar = "https://m.douban.com/rexxar/api/v2/tv/25853071?ck=&for_mobile=1";
        assert_eq!(
            proxy_url(ProxyKind::CdnTencent, "", rexxar).expect("rexxar"),
            "https://m.douban.cmliussss.net/rexxar/api/v2/tv/25853071?ck=&for_mobile=1"
        );
        // 不是豆瓣主机就原样放行。
        let other = "https://example.com/x";
        assert_eq!(
            proxy_url(ProxyKind::CdnAli, "", other).expect("other"),
            other
        );
    }

    #[test]
    fn proxy_url_cors_zwei_percent_encodes_target() {
        let target = "https://movie.douban.com/j/subject_suggest?q=庆余年";
        let built = proxy_url(ProxyKind::CorsZwei, "", target).expect("cors");
        assert!(built.starts_with("https://ciao-cors.is-an.org/"));
        // 目标 URL 必须整体编码：前缀之后不该再出现裸的 `https://`。
        let tail = &built["https://ciao-cors.is-an.org/".len()..];
        assert!(!tail.contains("https://"));
        assert!(tail.contains("%3A%2F%2F"));
        assert!(tail.contains("%E5%BA%86%E4%BD%99%E5%B9%B4"));
        assert!(!tail.contains(' '));
    }

    #[test]
    fn proxy_url_custom_supports_query_and_concat_forms() {
        let target = "https://movie.douban.com/j/subject_suggest?q=庆余年";
        let query_form = proxy_url(ProxyKind::Custom, "https://p.example/fetch?url=", target)
            .expect("query form");
        assert!(query_form.starts_with("https://p.example/fetch?url=https%3A%2F%2F"));
        assert!(query_form.contains("%E5%BA%86%E4%BD%99%E5%B9%B4"));

        let bare_query =
            proxy_url(ProxyKind::Custom, "https://p.example/fetch", target).expect("bare query");
        assert!(bare_query.starts_with("https://p.example/fetch?url=https%3A%2F%2F"));

        let concat = proxy_url(ProxyKind::Custom, "https://p.example/", target).expect("concat");
        assert_eq!(concat, format!("https://p.example/{target}"));

        // 选了自定义却没填前缀 = 本地参数错误。
        let err = proxy_url(ProxyKind::Custom, "   ", target).expect_err("empty prefix");
        assert_eq!(err.code, code::INVALID_ARGUMENT);
    }

    #[test]
    fn pic_gets_referer_suffix_once() {
        assert_eq!(
            with_pic_referer("https://img3.doubanio.com/p.jpg"),
            "https://img3.doubanio.com/p.jpg@Referer=https://movie.douban.com/"
        );
        let already = "https://img3.doubanio.com/p.jpg@Referer=https://api.douban.com/";
        assert_eq!(with_pic_referer(already), already);
        assert_eq!(with_pic_referer("   "), "");
    }

    #[test]
    fn apply_detail_reads_rexxar_shape() {
        let detail = json!({
            "title": "庆余年 第一季",
            "year": "2019",
            "rating": { "value": 7.9, "count": 1176890 },
            "intro": "  某大学文学史专业的学生张庆熟读古典名著  ",
            "directors": [{ "name": "孙皓" }],
            "actors": [{ "name": "张若昀" }, { "name": "李沁" }],
            "genres": ["剧情", "古装"],
            "pic": { "large": "https://img3.doubanio.com/l.jpg", "normal": "https://img3.doubanio.com/n.jpg" },
            "url": "https://movie.douban.com/subject/25853071/"
        });
        let mut out = DoubanMeta {
            id: "25853071".into(),
            title: String::new(),
            year: String::new(),
            rating: 0.0,
            rating_count: 0,
            intro: String::new(),
            directors: Vec::new(),
            actors: Vec::new(),
            genres: Vec::new(),
            pic: String::new(),
            url: String::new(),
        };
        apply_detail(&mut out, &detail);
        assert_eq!(out.title, "庆余年 第一季");
        assert_eq!(out.year, "2019");
        assert_eq!(out.rating, 7.9);
        assert_eq!(out.rating_count, 1_176_890);
        assert_eq!(out.intro, "某大学文学史专业的学生张庆熟读古典名著");
        assert_eq!(out.directors, vec!["孙皓".to_string()]);
        assert_eq!(out.actors, vec!["张若昀".to_string(), "李沁".to_string()]);
        assert_eq!(out.genres, vec!["剧情".to_string(), "古装".to_string()]);
        assert_eq!(out.pic, "https://img3.doubanio.com/l.jpg");
        assert_eq!(out.url, "https://movie.douban.com/subject/25853071/");
    }

    #[test]
    fn apply_detail_reads_abstract_shape() {
        // subject_abstract 的降级形态：字符串 rate、字符串数组、types、带年份的标题、无简介。
        let detail = json!({
            "title": "庆余年 第一季‎ (2019)",
            "star": 4.0,
            "rate": "7.9",
            "directors": ["孙皓", "温若寒"],
            "actors": ["张若昀", "李沁"],
            "types": ["剧情", "古装"],
            "release_year": "2019",
            "url": "https://movie.douban.com/subject/25853071/"
        });
        let mut out = DoubanMeta {
            id: "25853071".into(),
            title: String::new(),
            year: String::new(),
            rating: 0.0,
            rating_count: 0,
            intro: String::new(),
            directors: Vec::new(),
            actors: Vec::new(),
            genres: Vec::new(),
            pic: String::new(),
            url: String::new(),
        };
        apply_detail(&mut out, &detail);
        assert_eq!(out.title, "庆余年 第一季");
        assert_eq!(out.rating, 7.9);
        assert_eq!(out.rating_count, 0, "abstract 没有评价人数");
        assert_eq!(
            out.directors,
            vec!["孙皓".to_string(), "温若寒".to_string()]
        );
        assert_eq!(out.genres, vec!["剧情".to_string(), "古装".to_string()]);
        assert_eq!(out.year, "2019");
        assert!(out.intro.is_empty());
        assert!(out.pic.is_empty());
    }

    #[test]
    fn parse_suggest_skips_entries_without_id() {
        let body = json!([
            { "id": "25853071", "title": "庆余年 第一季", "year": "2019", "img": "https://img3.doubanio.com/p.jpg" },
            { "title": "没有 id", "year": "2019" },
            { "id": "", "title": "空 id" }
        ]);
        let items = parse_suggest(&body);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "25853071");
        // 非数组（比如 html 错误页被当成 200）不 panic。
        assert!(parse_suggest(&json!({ "per_page": 1 })).is_empty());
    }

    #[test]
    fn parse_search_subjects_reads_rexxar_shape() {
        // 2026-11-15 之后 subject_suggest 对无 cookie 请求返回空数组，
        // 候选改由移动端搜索接口提供，形状是 subjects.items[].target。
        let body = json!({
            "subjects": {
                "items": [
                    {
                        "layout": "subject",
                        "target": {
                            "id": "25853071",
                            "title": "庆余年 第一季",
                            "year": "2019",
                            "cover_url": "https://img3.doubanio.com/p.jpg"
                        }
                    },
                    { "layout": "subject", "target": { "title": "没有 id" } }
                ]
            }
        });
        let items = parse_search_subjects(&body);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "25853071");
        assert_eq!(items[0].title, "庆余年 第一季");
        assert_eq!(items[0].year, "2019");
        assert_eq!(items[0].img, "https://img3.doubanio.com/p.jpg");
        // 错误页/空结构不 panic。
        assert!(parse_search_subjects(&json!({})).is_empty());
        assert!(parse_search_subjects(&json!({ "subjects": { "items": [] } })).is_empty());
    }

    #[test]
    fn parse_search_page_reads_embedded_data() {
        // 搜索页至今仍把结果明文塞在 window.__DATA__ 里；标题带 U+200E 和年份。
        let html = r#"<html><script>
      window.__DATA__ = {"count": 1, "items": [{"id": 37100984, "title": "后会友期‎ (2026)", "cover_url": "https://img3.doubanio.com/p.jpg", "url": "https://movie.douban.com/subject/37100984/", "abstract": "中国大陆 / 真人秀"}], "total": 1};
      window.__USER__ = { }
  </script></html>"#;
        let items = parse_search_page(html);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "37100984");
        assert_eq!(items[0].title, "后会友期‎ (2026)");
        assert_eq!(items[0].year, "2026");
        assert_eq!(items[0].img, "https://img3.doubanio.com/p.jpg");
        // 没匹配到条目的搜索页 / 没有 __DATA__ 的页面不 panic。
        assert!(parse_search_page("<html>no data</html>").is_empty());
        assert!(parse_search_page(r#"<script>window.__DATA__ = {"items": []};</script>"#).is_empty());
        assert_eq!(trailing_year("庆余年 第二季"), "");
        assert_eq!(trailing_year("沙丘(2021)"), "2021");
    }

    #[test]
    fn cache_roundtrip_uses_normalized_key() {
        clear_cache();
        let key = cache_key("庆余年 第一季", Some("2019"));
        assert_eq!(
            key,
            cache_key("庆余年（第二季）", Some("2019")),
            "同剧不同季共用一个键"
        );
        cache_put(key.clone(), &meta());
        assert_eq!(cache_get(&key).expect("hit"), meta());
        assert!(cache_get(&cache_key("三体", Some("2023"))).is_none());
        clear_cache();
    }

    #[tokio::test]
    async fn empty_title_is_an_argument_error() {
        let err = fetch(&DoubanMetaRequest {
            title: "   ".into(),
            ..DoubanMetaRequest::default()
        })
        .await
        .expect_err("empty title");
        assert_eq!(err.code, code::INVALID_ARGUMENT);
    }

    #[tokio::test]
    async fn custom_proxy_without_prefix_is_an_argument_error() {
        let err = fetch(&DoubanMetaRequest {
            title: "庆余年".into(),
            proxy_type: Some("custom".into()),
            proxy_prefix: Some("  ".into()),
            ..DoubanMetaRequest::default()
        })
        .await
        .expect_err("empty prefix");
        assert_eq!(err.code, code::INVALID_ARGUMENT);
    }

    /// 真实豆瓣（联网）回归。默认 `cargo test` 不跑：
    /// `cargo test --lib douban -- --ignored --nocapture`。
    #[tokio::test]
    #[ignore = "联网：真实请求豆瓣，默认跳过"]
    async fn live_douban_meta_qingyu_nian() {
        let req = DoubanMetaRequest {
            title: "庆余年".into(),
            year: Some("2019".into()),
            proxy_type: None,
            proxy_prefix: None,
        };
        let found = fetch(&req).await.expect("fetch").expect("subject");
        println!("{}", serde_json::to_string(&found).expect("json"));
        assert!(!found.id.is_empty());
        assert!(found.rating > 0.0);
        assert!(found.pic.ends_with(PIC_REFERER_SUFFIX));
    }
}
