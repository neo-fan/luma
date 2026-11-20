//! 豆瓣元数据（详情页自动补全）。
//!
//! 详情页拿到片名后调 `douban_meta`，这里把「片名 + 可选年份」换成豆瓣条目：
//! 标题、年份、评分、评价人数、简介、导演、演员、类型、海报。前端取不到就按
//! `null` 静默回退 —— 补全只是锦上添花，不能挡住用户看片，所以网络失败一律
//! `Ok(None)`，只有**本地参数错误**（空片名、自定义代理缺前缀）才返回 `Err`。
//!
//! ## 数据来源（2026-11-15 实测）
//!
//! 1. `https://movie.douban.com/subject_search?search_text=<片名>`：搜索页
//!    内嵌 `__DATA__`，候选主源（带 `id` / `title` / `year` / 海报）。
//!    `subject_suggest` 对无 cookie 请求恒返回 `[]`，只作兜底。
//! 2. `https://m.douban.com/rexxar/api/v2/{tv|movie}/<id>?ck=&for_mobile=1`：
//!    详情主源（简介 / 评分 / 评价人数 / 海报 / 导演 / 演员 / 类型）。TV 条目只
//!    能用 `tv` 路径：`movie` 对 TV 会 301 到 `tv`（多一次往返），而 `tv` 对电影
//!    直接 404。首次先试 `tv` 再回落 `movie`，命中路径按 id 记忆 1 小时。
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
use moka::future::Cache;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BinaryHeap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
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
/// 负结果（查无此片）缓存：比成功短，但必须显著长于前端轮询节奏，
/// 否则头图轮播会把同一个查不到的片名每圈重跑一条完整搜索链。
const NEG_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const CACHE_CAP: usize = 128;

/// 豆瓣搜索有频率限制：几十张海报同时进视口会一次性发出几十个搜索请求，
/// 命中「搜索访问太频繁」之后所有搜索都返回空。用全局令牌桶限速（不是
/// 每个请求都机械地睡到上一个请求之后），并在被限流时整体冷却。
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
/// 唯一实现住在 `infra::pct`，与反代 / CMS 同一口径。
fn percent_encode(raw: &str) -> String {
    crate::pct::percent_encode(raw)
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

/// 汉字区（含扩展 A/B 与兼容表意文字）：出现即说明尾缀可能是**另一部作品**的名字。
fn is_cjk_ideograph(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x2ebef
    )
}

/// 尾缀是否只是「原文名别名」。
///
/// 豆瓣对非中文作品的标题格式是 `中文名 原文名 (年份)`，规范化剥掉年份后多出来的
/// 那一段是谚文 / 拉丁 / 假名，不是第二个作品名——「我的有罪之人 나의 유죄인간」
/// 曾被 4 字尾缀上限整批拒掉。含数字或汉字就不算别名（「美版」「第二季」「2024」
/// 都可能是另一部），这条放宽因此只对外语别名开口子。
fn is_original_alias_tail(tail: &str) -> bool {
    let mut saw_letter = false;
    for ch in tail.chars() {
        if ch.is_numeric() || is_cjk_ideograph(ch) {
            return false;
        }
        if ch.is_alphabetic() {
            saw_letter = true;
        }
    }
    saw_letter
}

/// 候选打分，`None` = 「不是同一部」。
///
/// 只在「规范化后相等」或「尾缀关系」上给分，保守优先：匹配错一部作品的代价
/// （详情页挂错海报/简介）比漏匹配大得多。分数取值是行为约定的一部分（测试按它
/// 断言）：完全相同 100 > 候选多了尾缀 90 > 查询多了尾缀 85。尾缀长度上限 4 个
/// 字符，纯外语别名不受它限制（见 `is_original_alias_tail`）。
pub fn title_score(query: &str, candidate: &str) -> Option<u32> {
    let query = normalize_title(query);
    let candidate = normalize_title(candidate);
    if query.is_empty() || candidate.is_empty() {
        return None;
    }
    if query == candidate {
        return Some(100);
    }
    let candidate_len = candidate.chars().count();
    if let Some(tail) = candidate.strip_prefix(&query) {
        if tail.chars().count() <= 4 || is_original_alias_tail(tail) {
            return Some(90);
        }
    }
    if let Some(tail) = query.strip_prefix(&candidate) {
        if candidate_len >= 2 && (tail.chars().count() <= 4 || is_original_alias_tail(tail)) {
            return Some(85);
        }
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

/// 实际请求 URL 的 `scheme://host`，用于日志标明「豆瓣走的是哪个域名」。
/// 解析失败退回去掉 query 的原文——取不到 host 也不该 panic。query 里有片名 /
/// `subject_id`，这里只截 host，与落盘闸 `redact_url` 的口径一致。
fn request_host(raw: &str) -> String {
    Url::parse(raw)
        .ok()
        .and_then(|parsed| {
            parsed
                .host_str()
                .map(|host| format!("{}://{}", parsed.scheme(), host))
        })
        .unwrap_or_else(|| crate::logging::redact_url(raw))
}

/// 同一代理模式进程内只 INFO 一次「豆瓣走哪个通道」。默认 INFO 级别下让「配了
/// 代理到底生效没、被改写成哪个域名」可查，又不随首页轮播 / 详情逐请求刷屏；
/// 用户中途切换代理模式后，新模式首次成功会再播报一次。锁中毒时照常写入
/// （best-effort 日志，不值得为它让整个豆瓣取数 panic）。
fn announce_douban_channel(kind: ProxyKind, host: &str) {
    static ANNOUNCED: OnceLock<Mutex<std::collections::HashSet<&'static str>>> = OnceLock::new();
    let seen = ANNOUNCED.get_or_init(Mutex::default);
    let mut guard = match seen.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.insert(kind.as_str()) {
        tracing::info!(proxy = kind.as_str(), host, "豆瓣元数据请求通道已启用");
    }
}

async fn get_text(
    kind: ProxyKind,
    prefix: &str,
    target: &str,
    referer: &str,
    accept: &str,
) -> Result<String, AppError> {
    let url = proxy_url(kind, prefix, target)?;
    let host = request_host(&url);
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
    let response = request.send().await.map_err(|err| {
        // 连接层失败（DNS 挂 / 超时 / 拒连）才是「代理没生效或镜像挂了」的
        // 关键信号，这里唯一地带 actual host 告警；HTTP 非 2xx（含 rexxar
        // path 探测的预期 404）交给外层各 step 的 warn，不在此翻倍。
        tracing::warn!(proxy = kind.as_str(), host = %host, error = %err, "豆瓣请求发送失败");
        douban_error("豆瓣请求失败", err.to_string())
    })?;
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
        )
        // 把实际走的代理模式与 host 挂进 details：外层各 step 的 warn 不带 host，
        // 而 404 多是 rexxar path 探测的预期降级、不宜再叠一条 warn；诊断导出
        // 读 error.details，能看出「是哪个镜像域名答的 404」。
        .with_details(serde_json::json!({ "proxy": kind.as_str(), "host": host })));
    }
    announce_douban_channel(kind, &host);
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
            let id = row.get("id").and_then(|value| match value {
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

/// 令牌桶：容量 4，每 350ms 补 1 个（平均约 2.9 次/秒）。
///
/// 为什么不继续用「每个请求都 sleep 到上一个 + 1.2s」：一次详情页要发
/// 搜索 + 详情 + 摘要三四个请求，机械串行就是 3.6s 起步，用户看到的就是
/// 「豆瓣很慢」。桶允许一次页面加载的几个请求立刻发出，只有持续刷首页
/// 那种真的高频场景才排队等补充，限流风险不变。
const DOUBAN_BURST: f64 = 4.0;
const DOUBAN_REFILL: Duration = Duration::from_millis(350);

struct DoubanBucket {
    tokens: f64,
    last: Instant,
}

static DOUBAN_GATE: OnceLock<Mutex<DoubanBucket>> = OnceLock::new();
static DOUBAN_COOLDOWN: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

fn douban_bucket() -> &'static Mutex<DoubanBucket> {
    DOUBAN_GATE.get_or_init(|| {
        Mutex::new(DoubanBucket {
            tokens: DOUBAN_BURST,
            last: Instant::now(),
        })
    })
}

/// 取一个令牌；取不到返回还要等多久。锁只覆盖记账，不覆盖 sleep。
fn take_token(bucket: &mut DoubanBucket, now: Instant) -> Option<Duration> {
    let elapsed = now.saturating_duration_since(bucket.last);
    let refill = elapsed.as_secs_f64() / DOUBAN_REFILL.as_secs_f64();
    bucket.tokens = (bucket.tokens + refill).min(DOUBAN_BURST);
    bucket.last = now;
    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        None
    } else {
        Some(DOUBAN_REFILL.mul_f64(1.0 - bucket.tokens))
    }
}

/// 拿到一个令牌再发请求：桶里还有就直接过，没有才等补满这一个。
///
/// `now` 目前只用于测试：注入网络桩时传一个「每次调用前进 ≥350ms」的时钟，
/// 桶恒满，桩请求不消耗（也不受罚于）真实豆瓣的令牌预算。`take_token`
/// 的桶逻辑不变。
async fn pace_douban(now: fn() -> Instant) {
    loop {
        let wait = {
            let mut bucket = douban_bucket()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            take_token(&mut bucket, now())
        };
        match wait {
            None => return,
            Some(wait) => tokio::time::sleep(wait).await,
        }
    }
}

/// 限流冷却槽：全局单值 `Mutex<Option<Instant>>`，**刻意不进 moka**。
///
/// 这不是缓存，是限流状态机的一个槽：语义是「until 之前对所有请求禁用搜索」，
/// 读写都是对同一格的覆盖检查，没有 key、没有并发合并需求（`try_get_with`
/// 之类都用不上）、也不靠容量淘汰。换成 moka 只会把一次 `lock + 比较` 包成
/// 一个单条目缓存 + 后台淘汰任务，还引入「淘汰跑没跑」这种这里不需要的
/// 不确定性。仓库允许这种有理由的手搓：单槽状态不是缓存。
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

/// 测试复位冷却槽（限流逻辑本身不动，见上方「刻意不进 moka」的注释）。
/// 429 用例会打开一个 180s 的全局窗口，不清掉会淹死其他走网络路径的用例。
#[cfg(test)]
fn reset_cooldown() {
    let cooldown = DOUBAN_COOLDOWN.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cooldown.lock() {
        *guard = None;
    }
}

/// 候选搜索的结论性质。旧版直接返回 `Vec`，把「全部端点传输失败」和
/// 「豆瓣答复了但确实没有这部剧」压成同一个空数组，调用方只能把两者都
/// 负缓存 —— 这里拆开：只有 `Conclusive` 才允许写正/负缓存。
enum SearchOutcome {
    /// 至少一个端点正常应答（哪怕候选是空的）：「找到/没找到」是可信结论。
    Conclusive(Vec<SuggestItem>),
    /// 冷却跳过 / 被限流（error_info）/ 所有端点都没能正常应答：不下结论，
    /// 不进任何缓存，下次照常重试（429/5xx/超时可重试的约束就在这里兑现）。
    Inconclusive,
}

/// 候选搜索：搜索页 `__DATA__` → 老接口 `subject_suggest` → 移动端搜索接口。
///
/// 2026-11-15 实测：`subject_suggest` 对无 cookie 请求恒返回 `[]`，放在首跳
/// 等于每条补全链白跑一次往返，因此降为兜底；`subject_search` 稳定返回明文
/// 结果，作主源。`m.douban.com/rexxar/api/v2/search/subjects` 很快会变成
/// `need_login` 403，只作最后兜底。
///
/// `now` 目前不参与判定，只是测试注入网络桩后让 `pace_douban` 的令牌等待
/// 保持瞬时：注入的 HTTP 请求不该消耗真实豆瓣的令牌预算，测试里它必须恒为
/// 「有令牌」。
async fn search_candidates(
    kind: ProxyKind,
    prefix: &str,
    title: &str,
    now: fn() -> Instant,
) -> SearchOutcome {
    if douban_cooling() {
        tracing::debug!(title, "douban search skipped during cooldown");
        return SearchOutcome::Inconclusive;
    }
    pace_douban(now).await;

    // 本轮链路里是否有端点正常应答过（拿到符合契约的响应）。
    let mut responded = false;

    let target = format!(
        "https://movie.douban.com/subject_search?search_text={}",
        percent_encode(title)
    );
    match get_text(kind, prefix, &target, DOUBAN_REFERER, "text/html, */*").await {
        Ok(html) => match search_page_data(&html) {
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
                    return SearchOutcome::Inconclusive;
                }
                responded = true;
                let items = parse_search_data(&data);
                if !items.is_empty() {
                    return SearchOutcome::Conclusive(items);
                }
                tracing::warn!(title, "douban search page returned no subjects");
            }
            None => tracing::warn!(title, "douban search page had no embedded data"),
        },
        Err(err) => {
            tracing::warn!(code = %err.code, error = %err.message, "douban search page failed");
        }
    }

    let target = format!(
        "https://movie.douban.com/j/subject_suggest?q={}",
        percent_encode(title)
    );
    match get_json(kind, prefix, &target).await {
        Ok(body) if body.is_array() => {
            responded = true;
            let items = parse_suggest(&body);
            if !items.is_empty() {
                return SearchOutcome::Conclusive(items);
            }
            tracing::warn!(title, "douban suggest returned no subjects");
        }
        Ok(body) => {
            tracing::warn!(title, shape = %body, "douban suggest returned a non-array body");
        }
        Err(err) => {
            tracing::warn!(code = %err.code, error = %err.message, "douban suggest failed");
        }
    }

    let target = format!(
        "https://m.douban.com/rexxar/api/v2/search/subjects?q={}",
        percent_encode(title)
    );
    match get_json(kind, prefix, &target).await {
        Ok(body) => {
            // 2xx 不等于「确认无此片」：限流 / 未登录时接口照样回 200，body 是
            // `{"msg":"need_login"}` 之类的错误体。当成 Conclusive 会写 5 分钟负缓存，
            // 把一部明明存在的片判死（与 `cold_epg_raw` 的「非成功状态不缓存」同口径）。
            let error = body
                .get("msg")
                .or_else(|| body.get("error_info"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if !error.is_empty() {
                tracing::warn!(title, error, "douban mobile search rejected, cooling down");
                cool_down_douban();
                return SearchOutcome::Inconclusive;
            }
            // 形状：`{ "subjects": { "items": [...] } }`（也有返回数组的变体）。
            // 缺 `subjects`（`{}` / `{"msg":"need_login"}` / 代理注入的 HTML）一律
            // 不算「确认无结果」——否则会写 5 分钟负缓存，把存在的片判死。
            let shaped = body
                .get("subjects")
                .map(|subjects| subjects.is_object() || subjects.is_array())
                .unwrap_or(false);
            if !shaped {
                tracing::warn!(title, shape = %body, "douban mobile search had no subjects");
                return if responded {
                    SearchOutcome::Conclusive(Vec::new())
                } else {
                    SearchOutcome::Inconclusive
                };
            }
            SearchOutcome::Conclusive(parse_search_subjects(&body))
        }
        Err(err) => {
            tracing::warn!(code = %err.code, error = %err.message, "douban mobile search failed");
            if responded {
                SearchOutcome::Conclusive(Vec::new())
            } else {
                SearchOutcome::Inconclusive
            }
        }
    }
}

/// rexxar 路径记忆：电影条目 `tv` 必 404、TV 条目 `movie` 会 301，首次探测
/// 后记住正确路径，同一 id 的后续补全直奔命中路径；双路径都明确 404 的记
/// 「无详情」，直接走 abstract。只记明确结论，网络失败/限流不入记忆。
const DETAIL_PATH_TTL: Duration = Duration::from_secs(60 * 60);
const DETAIL_PATH_CAP: u64 = 256;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DetailPath {
    Tv,
    Movie,
    Unavailable,
}

/// 路径记忆分两个表：`Unavailable` 是否定结论（等价负缓存），单独一张更短
/// 生命周期的表反而不合理——它和正结论共享同一条 TTL 约定（1 小时后重新
/// 探测），差别只在读侧语义：正路径要取出变体，否定路径只要「存在即生效」。
/// 所以正/负各一个 moka 实例：`Cache<String, DetailPath>` 只存 Tv/Movie，
/// `Cache<String, ()>` 存 Unavailable，取代原先同一 HashMap 里混着
/// `DetailPath::Unavailable` 加手工 `retain` 清扫的写法。
static DETAIL_PATH_CACHE: OnceLock<Cache<String, DetailPath>> = OnceLock::new();
static DETAIL_UNAVAILABLE_CACHE: OnceLock<Cache<String, ()>> = OnceLock::new();

fn detail_path_cache() -> &'static Cache<String, DetailPath> {
    DETAIL_PATH_CACHE.get_or_init(|| {
        Cache::builder()
            .max_capacity(DETAIL_PATH_CAP)
            .time_to_live(DETAIL_PATH_TTL)
            .build()
    })
}

fn detail_unavailable_cache() -> &'static Cache<String, ()> {
    DETAIL_UNAVAILABLE_CACHE.get_or_init(|| {
        Cache::builder()
            .max_capacity(DETAIL_PATH_CAP)
            .time_to_live(DETAIL_PATH_TTL)
            .build()
    })
}

async fn remember_detail_path(id: &str, path: DetailPath) {
    // 容量/过期由 moka 后台任务管，写入不再需要手工 `retain` 清扫。
    // `future::Cache` 的 insert 是 async：必须 await 才完成写入。
    let key = id.to_string();
    match path {
        DetailPath::Unavailable => {
            detail_unavailable_cache().insert(key, ()).await;
        }
        _ => {
            detail_path_cache().insert(key, path).await;
        }
    }
}

async fn forget_detail_path(id: &str) {
    detail_path_cache().invalidate(id).await;
    detail_unavailable_cache().invalidate(id).await;
}

/// 详情：按路径记忆直奔 `tv` / `movie`（未探测过则先 tv 后 movie），
/// 都不行退到 `subject_abstract`。
async fn fetch_detail(
    kind: ProxyKind,
    prefix: &str,
    id: &str,
    now: fn() -> Instant,
) -> Option<Value> {
    if douban_cooling() {
        tracing::debug!(id, "douban detail skipped during cooldown");
        return None;
    }
    // 用 `get` 读否定表：过期条目按 TTL 立即不可见，不依赖后台淘汰时序。
    let hint = if detail_unavailable_cache().get(id).await.is_some() {
        Some(DetailPath::Unavailable)
    } else {
        detail_path_cache().get(id).await
    };
    let paths: &[&str] = match hint {
        Some(DetailPath::Tv) => &["tv"],
        Some(DetailPath::Movie) => &["movie"],
        Some(DetailPath::Unavailable) => &[],
        None => &["tv", "movie"],
    };
    let mut not_found = 0usize;
    for path in paths {
        pace_douban(now).await;
        let target = format!(
            "https://m.douban.com/rexxar/api/v2/{path}/{}?ck=&for_mobile=1",
            percent_encode(id)
        );
        match get_json(kind, prefix, &target).await {
            Ok(value) => {
                if value.get("title").is_some() {
                    remember_detail_path(
                        id,
                        if *path == "tv" {
                            DetailPath::Tv
                        } else {
                            DetailPath::Movie
                        },
                    )
                    .await;
                    return Some(value);
                }
                tracing::warn!(id, path, "douban rexxar returned an empty subject");
            }
            Err(err) => {
                if err.message.contains("HTTP 404") {
                    // 探测 tv / movie 两条路径时，另一条必然 404：那是探测机制本身，
                    // 不是故障。记进 not_found 计数，日志降到 debug。
                    not_found += 1;
                    tracing::debug!(id, path, error = %err.message, "douban rexxar path not found");
                } else {
                    tracing::warn!(id, path, code = %err.code, error = %err.message, "douban rexxar failed");
                }
            }
        }
    }
    if hint.is_none() && not_found == 2 {
        // 双路径都明确 404：这个 id 没有 rexxar 详情，下次直接 abstract。
        remember_detail_path(id, DetailPath::Unavailable).await;
    } else if hint.is_some() && not_found == paths.len() && !paths.is_empty() {
        // 记住的路径失效（条目变更等）：清掉记忆，下次重新双路径探测。
        forget_detail_path(id).await;
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

/// 返回 `(meta, detail_ok)`：`detail_ok` = 是否真的取到并应用了详情。
///
/// `subject_id` 直取分支依赖这个标志：详情失败时 `build_meta` 的种子标题就是
/// 源标题本身，弱校验会「源标题 vs 源标题」满分通过，把无评分/简介/海报的空壳
/// 当完整结果推送并写正缓存。调用方必须据 `detail_ok` 判断是否可当 full 落地。
async fn build_meta(
    kind: ProxyKind,
    prefix: &str,
    item: &SuggestItem,
    year: Option<&str>,
    now: fn() -> Instant,
) -> (DoubanMeta, bool) {
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
    let detail_ok = match fetch_detail(kind, prefix, &item.id, now).await {
        Some(detail) => {
            apply_detail(&mut meta, &detail);
            true
        }
        None => false,
    };
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
    (meta, detail_ok)
}

/// 一次补全：suggest 选优 → rexxar/abstract 补详情。
///
/// 网络层失败一律 `Ok(None)`（前端静默回退），参数错误才 `Err`。
pub async fn fetch(req: &DoubanMetaRequest) -> Result<Option<DoubanMeta>, AppError> {
    fetch_with(req, Instant::now).await
}

/// 真实入口的薄壳：生产路径固定用 `Instant::now` 和真网络；`now` 只是
/// 测试注入桩请求不消耗真实令牌桶的缝（见 `pace_douban` / `search_candidates`）。
async fn fetch_with(
    req: &DoubanMetaRequest,
    now: fn() -> Instant,
) -> Result<Option<DoubanMeta>, AppError> {
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
    let key = cache_key(&title, year.as_deref(), &prefix);
    // 负缓存命中：查过、确认没有，TTL 内不再跑搜索链（轮播每圈都会重问）。
    // 用 `get` 而不是 `contains_key`：前者确定会按 TTL 过滤过期条目。
    if negative_cache().get(&key).await.is_some() {
        return Ok(None);
    }
    if douban_cooling() {
        tracing::debug!(title, "douban meta skipped during cooldown");
        return Ok(None);
    }
    // 冷 key 去重：首页一屏几十张卡片、详情页与头图同时问同一个片名时，
    // 缓存里还没有条目，每个调用者都会跑一遍完整搜索链（候选搜索 + 摘要 +
    // rexxar 详情）。令牌桶只限速、不去重，所以放大仍然发生——moka
    // `try_get_with` 让同 key 并发共享同一次执行：求值 Ok 进正缓存，
    // Err 不进缓存（取代原先 `HashMap + Instant` 表和自研 flights 两套手搓）。
    let outcome = positive_cache()
        .try_get_with(key, cold_fetch(kind, prefix, title, year, now))
        .await;
    match outcome {
        Ok(meta) => Ok(Some(meta)),
        Err(fail) => match &*fail {
            ColdFail::NotFound => Ok(None),
            // 对外口径不变：网络层失败一律 Ok(None)（前端静默回退）。
            // Transient 只在冷路径内部区分「要不要写负缓存」，错误本身
            // 留给日志，不抛给前端。
            ColdFail::Transient(err) => {
                tracing::debug!(code = %err.code, error = %err.message, "douban cold fetch transient");
                Ok(None)
            }
        },
    }
}

/// 冷路径的两种失败。`try_get_with` 的 Ok/Err 只二分「进不进正缓存」，
/// 「确认无结果」和「查询失败」都是 Err，但只有前者要写负缓存 —— 用
/// 错误类型把它们区分开。与旧 `Cached { meta: Option<DoubanMeta> }` 的
/// 三态一一对应：正缓存 Ok ↔ `Some(Some(meta))`；`NotFound` ↔
/// `Some(None)`（查过、确认没有）；`Transient` ↔ 外层 `None`（没查过/
/// 没查出结论）。失败连负缓存都不进是旧实现没有、约束要求的修正：旧表
/// 会把一次断网也「确认无结果」5 分钟。
#[derive(Debug, Clone)]
enum ColdFail {
    /// 搜索链跑通了但没有任何匹配条目：负缓存（`NEG_CACHE_TTL`）压制重复查询。
    NotFound,
    /// 传输层失败 / 冷却跳过（429、5xx、超时）：什么缓存都不进，下次照常重试。
    Transient(AppError),
}

impl std::fmt::Display for ColdFail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "豆瓣无匹配条目"),
            Self::Transient(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for ColdFail {}

/// `fetch_with` 的实际取数链（只在 moka 正缓存没有有效条目时被跑到）：
/// 搜索选优 → 详情补全。搜索这一步与 `douban_cover` 共用 `search_cache`，
/// 所以头图「先出封面、后补详情」不会增加豆瓣请求量。
async fn cold_fetch(
    kind: ProxyKind,
    prefix: String,
    title: String,
    year: Option<String>,
    now: fn() -> Instant,
) -> Result<DoubanMeta, ColdFail> {
    let item = resolve_candidate(kind, &prefix, &title, year.as_deref(), now).await?;
    let (meta, detail_ok) = build_meta(kind, &prefix, &item, year.as_deref(), now).await;
    if !detail_ok {
        // 详情没取到（限流 / 验证页 / 缺字段）时 meta 只是「搜索页字段 + 源标题」的
        // 空壳：评分 0、简介与类型为空。`try_get_with` 只有 Err 才不缓存，所以这里
        // 必须走 Transient —— 否则这个空壳会在正缓存里活 10 分钟，期间所有调用方
        // 都拿不到真数据。不抛给前端（`fetch_with` 仍把它翻成 Ok(None)）。
        return Err(ColdFail::Transient(AppError::new(
            code::INTERNAL,
            format!("douban detail unavailable for {title}"),
        )));
    }
    Ok(meta)
}

/// 搜索 + 选优，按 title+year 合并并发并缓存结果（粗/细两路共用）。
/// `Ok(item)` 选中；`NotFound` 确认无匹配（已写负缓存）；`Transient` 传输失败 /
/// 冷却——不进任何缓存、下次照常重试。取代原先粗/细各跑一遍搜索。
async fn resolve_candidate(
    kind: ProxyKind,
    prefix: &str,
    title: &str,
    year: Option<&str>,
    now: fn() -> Instant,
) -> Result<SuggestItem, ColdFail> {
    let key = cache_key(title, year, prefix);
    let prefix = prefix.to_string();
    let title_owned = title.to_string();
    let year_owned = year.map(str::to_string);
    let found = search_cache()
        .try_get_with(key.clone(), async move {
            if douban_cooling() {
                tracing::debug!(title = %title_owned, "douban meta skipped during cooldown");
                return Err(ColdFail::Transient(AppError::new(
                    code::CONFIG_FETCH_FAIL,
                    "豆瓣冷却中",
                )));
            }
            match search_candidates(kind, &prefix, &title_owned, now).await {
                SearchOutcome::Conclusive(items) => {
                    let picked = pick_candidate(&items, &title_owned, year_owned.as_deref());
                    if picked.is_none() {
                        // 判成「不是同一部」时，光有 candidates=N 答不了「为什么」：
                        // 把候选标题一起留下，才能看出是打分太保守，还是豆瓣那边
                        // 本来就挂的是别名（韩剧 / 港剧常见）。
                        let samples = items
                            .iter()
                            .map(|item| item.display_title().trim())
                            .take(6)
                            .collect::<Vec<_>>()
                            .join(" | ");
                        tracing::info!(
                            title = %title_owned,
                            candidates = items.len(),
                            samples = %samples,
                            "douban: no matching subject"
                        );
                        // 确认无匹配：写负缓存压制重复查询（粗/细都靠它短路）。
                        negative_cache().insert(key.clone(), ()).await;
                    }
                    Ok(picked.cloned())
                }
                SearchOutcome::Inconclusive => Err(ColdFail::Transient(AppError::new(
                    code::CONFIG_FETCH_FAIL,
                    "豆瓣搜索链未能正常应答",
                ))),
            }
        })
        .await
        .map_err(|arc| (*arc).clone())?;
    found.ok_or(ColdFail::NotFound)
}

/// 粗结果：只用搜索候选的 `cover_url` 当海报，不跑详情。字段形状与 `DoubanMeta`
/// 一致，rating/intro 留空，由随后的细结果补全。
fn coarse_meta(item: &SuggestItem) -> DoubanMeta {
    DoubanMeta {
        id: item.id.trim().to_string(),
        title: item.display_title().to_string(),
        year: item.year.trim().to_string(),
        rating: 0.0,
        rating_count: 0,
        intro: String::new(),
        directors: Vec::new(),
        actors: Vec::new(),
        genres: Vec::new(),
        pic: with_pic_referer(item.img.as_str()),
        url: format!("https://movie.douban.com/subject/{}/", item.id.trim()),
    }
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

// ---- 后端主动推：豆瓣富化调度器 ------------------------------------------------
//
// 取代「前端发 cover+meta 两个请求、自己合并」的两段式 pull：前端只发一个
// `douban_request`，后端把结果用 `douban-meta` 事件分两段推回（搜索到货推 cover、
// 详情到货推 full），与全站搜索的 `search-chunk` 同一套推送模型。
//
// 为什么这么设计：并发/限流收口到后端一处（固定 worker + 全局令牌桶），不再靠前端
// 队列；同 key 去重（active 集 + moka try_get_with）；用户正在看（priority）排到
// 可见卡片预取前面。

/// worker 数 = 同时在途的豆瓣富化链上限（对齐旧前端 `MAX_PARALLEL=2`，不增豆瓣压力）。
const ENRICH_WORKERS: usize = 2;

/// 推给前端的富化事件。`key` 是前端传入的 store 槽位标识，后端原样回带（同
/// `search-chunk` 的 `streamId`），前端据此路由；`meta` 与 `douban_meta` 的
/// `DoubanMeta` 完全同构，前端复用同一套 normalize。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoubanMetaEvent<'a> {
    key: &'a str,
    /// "cover" | "full" | "none" | "error"
    phase: &'a str,
    meta: Option<&'a DoubanMeta>,
}

fn emit_douban(app: &tauri::AppHandle, key: &str, phase: &str, meta: Option<&DoubanMeta>) {
    let payload = DoubanMetaEvent { key, phase, meta };
    if let Err(err) = tauri::Emitter::emit(app, "douban-meta", &payload) {
        tracing::debug!(%err, key, phase, "douban-meta emit failed");
    }
}

struct Pending {
    priority: bool,
    seq: u64,
    app: tauri::AppHandle,
    kind: ProxyKind,
    prefix: String,
    title: String,
    year: Option<String>,
    /// 前端 store 槽位标识（回带用）。
    key: String,
    /// 后端归一缓存键（正/负/搜索表用）。
    ckey: String,
    /// 采集库自带的豆瓣 subject id（`vod_douban_id`，已归一：没填是空）。
    subject_id: Option<String>,
}

// 手写比较：只按排序相关字段（priority/seq）比，避免对 AppHandle 派生 Eq。
impl PartialEq for Pending {
    fn eq(&self, other: &Self) -> bool {
        self.priority == other.priority && self.seq == other.seq
    }
}
impl Eq for Pending {}
impl PartialOrd for Pending {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Pending {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // 最大堆：priority 先出；同优先级按 seq 先进先出（故 seq 反向比较）。
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}

struct EnrichQueue {
    heap: BinaryHeap<Pending>,
    active: HashSet<String>,
    seq: AtomicU64,
}

static ENRICH: OnceLock<Mutex<EnrichQueue>> = OnceLock::new();
static ENRICH_WAKE: OnceLock<Notify> = OnceLock::new();
static ENRICH_STARTED: OnceLock<()> = OnceLock::new();

fn enrich_queue() -> &'static Mutex<EnrichQueue> {
    ENRICH.get_or_init(|| {
        Mutex::new(EnrichQueue {
            heap: BinaryHeap::new(),
            active: HashSet::new(),
            seq: AtomicU64::new(0),
        })
    })
}

fn enrich_wake() -> &'static Notify {
    ENRICH_WAKE.get_or_init(Notify::new)
}

/// 入队一个富化请求；`active` 命中则跳过（已有同 key 在排队/执行）。首次调用惰性
/// 拉起固定数量 worker。返回是否真正入队。
fn enqueue_enrichment(item: Pending) -> bool {
    let mut guard = match enrich_queue().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if !guard.active.insert(item.key.clone()) {
        return false;
    }
    let seq = guard.seq.fetch_add(1, AtomicOrdering::Relaxed);
    let mut item = item;
    item.seq = seq;
    guard.heap.push(item);
    drop(guard);
    ENRICH_STARTED.get_or_init(|| {
        for _ in 0..ENRICH_WORKERS {
            tauri::async_runtime::spawn(enrich_worker());
        }
    });
    enrich_wake().notify_one();
    true
}

async fn enrich_worker() {
    loop {
        // 先登记唤醒订阅，再判空——避免「判空后、await 前」入队的项错过通知。
        let notified = enrich_wake().notified();
        let next = {
            let mut guard = match enrich_queue().lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.heap.pop()
        };
        let Some(item) = next else {
            notified.await;
            continue;
        };
        let Pending {
            app,
            kind,
            prefix,
            title,
            year,
            key,
            ckey,
            subject_id,
            ..
        } = item;
        run_enrichment(
            &app,
            kind,
            &prefix,
            &title,
            year.as_deref(),
            subject_id.as_deref(),
            &key,
            &ckey,
        )
        .await;
        let mut guard = match enrich_queue().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.active.remove(&key);
        drop(guard);
        // 还有排队项就唤醒别的 worker。
        enrich_wake().notify_one();
    }
}

/// 取字符串开头的四位年份（源的 `vod_year` 常是「2026韩国」这种脏值）。
fn first_year(raw: &str) -> Option<i32> {
    let digits: String = raw.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.len() == 4 {
        digits.parse().ok()
    } else {
        None
    }
}

/// id 反查到的条目与源给的信息是否还是同一部作品。
///
/// 存在的理由：62% 的条目带 id 且抽检全对，但仍可能有整库乱填（同一个 id、填 0）
/// 这种脏数据，形态检查发现不了。标题判据直接复用 `title_score`（含原文别名规则）；
/// 年份允许 ±1（跨地区上映年份常差一年）。任一边拿不到年份就不否决——宁可用 id，
/// 也不因缺年份退回更弱的标题匹配。
fn id_matches_source(meta: &DoubanMeta, title: &str, year: Option<&str>) -> bool {
    if meta.title.trim().is_empty() || title_score(title, &meta.title).is_none() {
        return false;
    }
    match (year.and_then(first_year), first_year(&meta.year)) {
        (Some(wanted), Some(found)) => (wanted - found).abs() <= 1,
        _ => true,
    }
}

/// 单条富化链：搜索到货推 cover，详情到货推 full；无匹配推 none，传输失败推 error
/// （error 不写负缓存，前端可据 phase 决定是否再试）。`key` 回带给前端路由，
/// `ckey` 是后端归一缓存键。
///
/// `subject_id` 来自采集库自带的 `vod_douban_id`：有值时先按 id 直取详情（一次请求，
/// 省掉搜索那一跳），取到后仍过一遍弱校验；对不上就回退标题匹配路径。
async fn run_enrichment(
    app: &tauri::AppHandle,
    kind: ProxyKind,
    prefix: &str,
    title: &str,
    year: Option<&str>,
    subject_id: Option<&str>,
    key: &str,
    ckey: &str,
) {
    if let Some(id) = subject_id {
        // 这两条 INFO 用来区分「id 分支没被执行」与「执行了但回退」：只靠回退时
        // 的 WARN 无法证明入口到过这里（限流、队列、前端没传都会表现为静默）。
        tracing::info!(id, title, "douban: 走 subject_id 直取");
        let item = SuggestItem {
            id: id.to_string(),
            title: title.to_string(),
            sub_title: String::new(),
            year: year.unwrap_or_default().to_string(),
            img: String::new(),
            url: format!("https://movie.douban.com/subject/{}/", id),
        };
        let (meta, detail_ok) = build_meta(kind, prefix, &item, year, Instant::now).await;
        // 详情没取到时 meta 的种子标题=源标题，弱校验会满分通过；必须要求
        // detail_ok，否则空壳被当 full 推送并写正缓存 10 分钟，污染后续请求。
        let matched = detail_ok && id_matches_source(&meta, title, year);
        tracing::info!(
            id,
            title,
            matched,
            detail_ok,
            douban_title = %meta.title,
            douban_year = %meta.year,
            "douban: subject_id 直取校验结果"
        );
        if matched {
            positive_cache()
                .insert(ckey.to_string(), meta.clone())
                .await;
            emit_douban(app, key, "full", Some(&meta));
            return;
        }
        tracing::warn!(
            id,
            title,
            douban_title = %meta.title,
            douban_year = %meta.year,
            "douban: subject_id 与源给的名字/年份对不上，回退标题匹配"
        );
    }
    match resolve_candidate(kind, prefix, title, year, Instant::now).await {
        Ok(item) => {
            let coarse = coarse_meta(&item);
            emit_douban(app, key, "cover", Some(&coarse));
            let (full, detail_ok) = build_meta(kind, prefix, &item, year, Instant::now).await;
            if detail_ok {
                positive_cache()
                    .insert(ckey.to_string(), full.clone())
                    .await;
                emit_douban(app, key, "full", Some(&full));
            } else {
                // 详情未取到的空壳不能当 full 落地：前端把 full 视为终态，写进正缓存
                // 后 10 分钟内不会再重试，用户看到的是「评分/简介全空」。发 error
                // 保留已推送的封面，并允许下次重新请求（与 id 直取分支同一契约）。
                tracing::warn!(title, "douban: 详情未取到，保留封面并允许重试");
                emit_douban(app, key, "error", None);
            }
        }
        Err(ColdFail::NotFound) => emit_douban(app, key, "none", None),
        Err(ColdFail::Transient(err)) => {
            tracing::debug!(code = %err.code, error = %err.message, title, "douban enrich transient");
            emit_douban(app, key, "error", None);
        }
    }
}

/// 前端触发豆瓣富化的唯一入口：立即返回，结果走 `douban-meta` 事件。
/// `key` 是前端 store 槽位标识，后端原样回带用于路由；缓存按归一的 title+year。
#[tauri::command]
pub async fn douban_request(
    app: tauri::AppHandle,
    title: String,
    year: Option<String>,
    proxy_type: Option<String>,
    proxy_prefix: Option<String>,
    priority: bool,
    key: String,
    // 采集库自带的豆瓣 subject id；有值时富化按 id 直取，跳过搜索与标题匹配。
    subject_id: Option<String>,
) -> Result<(), AppError> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "豆瓣查询需要片名"));
    }
    let kind = ProxyKind::parse(proxy_type.as_deref());
    let prefix = proxy_prefix.unwrap_or_default().trim().to_string();
    if kind == ProxyKind::Custom && prefix.is_empty() {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "自定义豆瓣代理缺少前缀",
        ));
    }
    let year = year
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let subject_id = subject_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "0");
    // 缓存键分槽：按 id 取与按标题取是两条不同证据链，不能让标题路径写下的
    // 「无匹配」负缓存把 id 直取也压掉（反之亦然，id 填错的库也不该污染标题路径）。
    let ckey = match &subject_id {
        Some(id) => format!("id:{id}"),
        None => cache_key(&title, year.as_deref(), &prefix),
    };

    // 已有完整结果 → 直接推，省一次排队。
    if let Some(meta) = positive_cache().get(&ckey).await {
        emit_douban(&app, &key, "full", Some(&meta));
        return Ok(());
    }
    // 确认无匹配 → 推 none（负缓存已写，前端停止等待）。
    if negative_cache().get(&ckey).await.is_some() {
        emit_douban(&app, &key, "none", None);
        return Ok(());
    }

    enqueue_enrichment(Pending {
        priority,
        seq: 0,
        app,
        kind,
        prefix,
        title,
        year,
        key,
        ckey,
        subject_id,
    });
    Ok(())
}

// ---- 缓存 -----------------------------------------------------------------

/// 正/负缓存分两个 moka 实例：TTL 不同（10min vs 5min），moka 的
/// `time_to_live` 是表级属性，一张表装不下两种寿命 —— 这也正好让
/// 「命中 / 确认无结果 / 没查过」三态各归其表：正表有值 = 命中，负表有值 =
/// 确认无结果（`cache_get` 的 `Some(None)`），两表皆空 = 未查过（外层
/// `None`）。取代原先一张 HashMap 用 `Option<DoubanMeta>` 的嵌套表达。
///
/// 淘汰行为差异（相对旧的「`CACHE_CAP` 超限整表 `retain`」）：旧实现超限才
/// 清扫一次过期项、清扫后仍可能超限（没有真正的容量上限），也没有限制
/// 活跃条目数；现在是 `max_capacity`（近似 LRU/W-TinyLFU 逐出）+ 后台按
/// TTL 逐出，活跃条目也有硬上限，不再有「写线程持锁扫全表」的毛刺。
static META_POSITIVE: OnceLock<Cache<String, DoubanMeta>> = OnceLock::new();
static META_NEGATIVE: OnceLock<Cache<String, ()>> = OnceLock::new();

fn positive_cache() -> &'static Cache<String, DoubanMeta> {
    META_POSITIVE.get_or_init(|| {
        Cache::builder()
            .max_capacity(CACHE_CAP as u64)
            .time_to_live(CACHE_TTL)
            .build()
    })
}

fn negative_cache() -> &'static Cache<String, ()> {
    META_NEGATIVE.get_or_init(|| {
        Cache::builder()
            .max_capacity(CACHE_CAP as u64)
            .time_to_live(NEG_CACHE_TTL)
            .build()
    })
}

/// 搜索选优结果缓存：`Some(item)` 选中、`None` 确认无匹配。粗（`douban_cover`）
/// 与细（`douban_meta`）两路共用，`try_get_with` 顺带合并同 key 并发——一条 title
/// 的搜索链只跑一次，这是「两段式不增加豆瓣请求量」的关键。寿命随正缓存。
static META_SEARCH: OnceLock<Cache<String, Option<SuggestItem>>> = OnceLock::new();

fn search_cache() -> &'static Cache<String, Option<SuggestItem>> {
    META_SEARCH.get_or_init(|| {
        Cache::builder()
            .max_capacity(CACHE_CAP as u64)
            .time_to_live(CACHE_TTL)
            .build()
    })
}

/// 缓存键：片名 + 年份 + **代理前缀**。
///
/// 前缀必须进键：用户「直连不行 → 换加速前缀」是最常见的自救动作，而正/负
/// 缓存各活 10/5 分钟——键里没有代理维度时，换完代理仍然命中旧结果，看起来
/// 像「换代理完全没用」。前端 store 的键也含代理模式，两侧维度保持一致。
fn cache_key(title: &str, year: Option<&str>, prefix: &str) -> String {
    format!(
        "{}|{}|{}",
        cache_title_key(title),
        year.unwrap_or(""),
        prefix.trim()
    )
}

/// 缓存键专用的片名归一：与 `normalize_title` 同法（去年份括号、半角、去噪声、
/// 小写），但**保留季/部标记**（第一季 / 第二季 / Season 2）。
///
/// 关键区别：`normalize_title` 剥季是给 `pick_candidate` 打分用的（选季在打分
/// 阶段做）；但缓存是在打分**之前**查的——键若也剥季，无年份时「庆余年 第一季」
/// 与「庆余年 第二季」会撞成同一个键，后查的一季直接命中前一季的条目（拿错数据）。
/// 年份仍是首选区分，季标记是无年份/同年份多季时的兜底。
fn cache_title_key(raw: &str) -> String {
    let stripped = drop_year_brackets(raw);
    let half_width = to_half_width(&stripped);
    half_width
        .chars()
        .filter(|ch| !is_title_noise(*ch))
        .collect::<String>()
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    #[test]
    fn token_bucket_allows_burst_then_waits() {
        let start = Instant::now();
        let mut bucket = DoubanBucket {
            tokens: DOUBAN_BURST,
            last: start,
        };
        // 一次页面加载的几个请求可以立刻发出。
        for _ in 0..4 {
            assert!(take_token(&mut bucket, start).is_none());
        }
        // 桶空了才等，且等待不超过补一个令牌的时间。
        let wait = take_token(&mut bucket, start).expect("burst 用完后应等待");
        assert!(wait > Duration::ZERO && wait <= DOUBAN_REFILL);
        // 补满一个令牌后又能立刻过。
        assert!(take_token(&mut bucket, start + DOUBAN_REFILL).is_none());
    }

    use super::*;
    use axum::body::Body;
    use axum::http::{Response, StatusCode};
    use axum::routing::get;
    use futures_util::FutureExt;
    use serde_json::json;
    use std::future::Future;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;

    // ---- 网络桩与缓存行为测试 ----------------------------------------------
    //
    // 计数一律用调用方持有的 `Arc<AtomicUsize>` 闭包捕获；全局静态计数器
    // 会被并行用例互相污染（spider/python.rs 的第一版就栽过）。每个用例用
    // 自己独占的片名当缓存 key，谁也不碰谁的条目。

    /// 桩时钟：每次调用前进一个完整补充周期，`take_token` 的 `elapsed` 恒
    /// ≥ 350ms → 桶永远是满的。桩流量因此既不消耗也不受罚于真实豆瓣的
    /// 限流预算（测试里没有任何 sleep）。这是时钟不是计数器：没有断言
    /// 读它，跨用例单调递增无害。
    fn stub_clock() -> Instant {
        static BASE: OnceLock<Instant> = OnceLock::new();
        static TICK: AtomicU64 = AtomicU64::new(0);
        let tick = TICK.fetch_add(1, Ordering::SeqCst);
        *BASE.get_or_init(Instant::now) + DOUBAN_REFILL * (tick as u32 + 1)
    }

    /// 冷却槽与共享路径记忆是全局状态：走网络的用例串行跑，进入时复位
    /// 冷却。锁的是状态，不是被禁止的计数静态量。
    fn network_guard() -> &'static tokio::sync::Mutex<()> {
        static GUARD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        GUARD.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    /// 起一个豆瓣形状的本地桩：按请求路径（含 query）选响应体，请求数记在
    /// 调用方传入的闭包里。
    async fn douban_site<F, Fut>(handler: F) -> String
    where
        F: Fn(String) -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = (StatusCode, String)> + Send + 'static,
    {
        let router = axum::Router::new().route(
            "/{*path}",
            get(move |parts: axum::http::request::Parts, query: String| {
                let handler = handler.clone();
                async move {
                    let full = if query.is_empty() {
                        parts.uri.path().to_string()
                    } else {
                        format!("{}?{}", parts.uri.path(), query)
                    };
                    let (status, body) = handler(full).await;
                    Response::builder()
                        .status(status)
                        .header("content-type", "text/plain; charset=utf-8")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("http://{addr}/")
    }

    fn search_endpoint(url: &str) -> bool {
        url.contains("subject_search")
            || url.contains("subject_suggest")
            || url.contains("search/subjects")
    }

    fn search_page_with(title: &str) -> String {
        format!(
            r#"<html><script>window.__DATA__ = {{"count": 1, "items": [{{"id": 25853071, "title": "{title}", "cover_url": "https://img3.doubanio.com/p.jpg"}}]}};</script></html>"#
        )
    }

    fn empty_search_page() -> String {
        r#"<html><script>window.__DATA__ = {"count": 0, "items": []};</script></html>"#.to_string()
    }

    /// 搜索链三腿都给「正常应答但没有结果」的形状。
    fn empty_search_chain(url: &str) -> (StatusCode, String) {
        if url.contains("subject_search") {
            (StatusCode::OK, empty_search_page())
        } else if url.contains("subject_suggest") {
            (StatusCode::OK, "[]".to_string())
        } else {
            (StatusCode::OK, r#"{"subjects": {"items": []}}"#.to_string())
        }
    }

    fn rexxar_detail() -> String {
        json!({
            "title": "庆余年 第一季",
            "year": "2019",
            "rating": { "value": 7.9, "count": 1176890 },
            "intro": "测试简介",
            "directors": [{ "name": "孙皓" }],
            "actors": [{ "name": "张若昀" }],
            "genres": ["剧情"],
            "pic": { "large": "https://img3.doubanio.com/l.jpg" },
            "url": "https://movie.douban.com/subject/25853071/"
        })
        .to_string()
    }

    fn stubbed_request(base: String, title: &str, year: Option<&str>) -> DoubanMetaRequest {
        DoubanMetaRequest {
            title: title.into(),
            year: year.map(str::to_string),
            proxy_type: Some("custom".into()),
            proxy_prefix: Some(base),
        }
    }

    /// (a) 正缓存 TTL 内二次命中：不再跑搜索链，返回同一份元数据。
    #[tokio::test(flavor = "multi_thread")]
    async fn positive_cache_hit_skips_search_chain() {
        let _serial = network_guard().lock().await;
        reset_cooldown();
        let hits = Arc::new(AtomicUsize::new(0));
        let chain = hits.clone();
        let base = douban_site(move |url: String| {
            let chain = chain.clone();
            async move {
                if search_endpoint(&url) {
                    chain.fetch_add(1, Ordering::SeqCst);
                    if url.contains("subject_search") {
                        (StatusCode::OK, search_page_with("正缓存甲"))
                    } else {
                        empty_search_chain(&url)
                    }
                } else if url.contains("rexxar") {
                    (StatusCode::OK, rexxar_detail())
                } else {
                    (StatusCode::NOT_FOUND, String::new())
                }
            }
        })
        .await;
        let req = stubbed_request(base, "正缓存甲", Some("2019"));
        let first = fetch_with(&req, stub_clock)
            .await
            .expect("fetch")
            .expect("meta");
        assert_eq!(first.id, "25853071");
        let after_first = hits.load(Ordering::SeqCst);
        assert!(after_first >= 1, "first call must run the search chain");
        let second = fetch_with(&req, stub_clock)
            .await
            .expect("fetch")
            .expect("meta");
        assert_eq!(second, first);
        assert_eq!(
            hits.load(Ordering::SeqCst),
            after_first,
            "TTL 内的第二次命中不能再走搜索链"
        );
    }

    /// (b) 负缓存压制「确认无结果」；(b+) 搜索链返回限流页（error_info，
    /// 即 429 的页面形态）→ 触发全局冷却，冷却窗口内不再发任何搜索。
    #[tokio::test(flavor = "multi_thread")]
    async fn negative_cache_suppresses_not_found_then_429_cools_down() {
        let _serial = network_guard().lock().await;
        reset_cooldown();
        let hits = Arc::new(AtomicUsize::new(0));
        let chain = hits.clone();
        let base = douban_site(move |url: String| {
            let chain = chain.clone();
            async move {
                if !search_endpoint(&url) {
                    return (StatusCode::NOT_FOUND, String::new());
                }
                chain.fetch_add(1, Ordering::SeqCst);
                empty_search_chain(&url)
            }
        })
        .await;
        // 键含代理前缀：换代理必须落到新键，否则旧的负缓存会继续压掉重试。
        let prefix = base.clone();
        let req = stubbed_request(base, "查无此片负缓存乙", None);
        assert!(fetch_with(&req, stub_clock).await.expect("fetch").is_none());
        let after_first = hits.load(Ordering::SeqCst);
        assert!(after_first >= 1, "first call must run the search chain");
        assert!(fetch_with(&req, stub_clock).await.expect("fetch").is_none());
        assert_eq!(
            hits.load(Ordering::SeqCst),
            after_first,
            "负缓存 TTL 内「确认无结果」不得重跑搜索链"
        );
        // 「确认无结果」是命中态 Some(None)，不是「没查过」的 None。
        // multi_thread runtime 会驱动 moka 后台维护，async 读直接可见。
        let key = cache_key("查无此片负缓存乙", None, &prefix);
        assert_eq!(negative_cache().get(&key).await, Some(()));
        assert_eq!(cache_get(&key).await, Some(None));

        // 限流页（429 的页面形态，error_info）→ 触发 THROTTLE_COOLDOWN，
        // 此后搜索被冷却闸整体掐掉。
        let throttle_hits = Arc::new(AtomicUsize::new(0));
        let counter = throttle_hits.clone();
        let base = douban_site(move |_url: String| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::OK,
                    r#"<html><script>window.__DATA__ = {"error_info": "搜索访问太频繁.", "items": []};</script></html>"#
                        .to_string(),
                )
            }
        })
        .await;
        let req = stubbed_request(base, "限流冷却丙", None);
        assert!(fetch_with(&req, stub_clock).await.expect("fetch").is_none());
        assert_eq!(throttle_hits.load(Ordering::SeqCst), 1);
        assert!(douban_cooling(), "429 之后应处于冷却窗口");
        assert!(fetch_with(&req, stub_clock).await.expect("fetch").is_none());
        assert_eq!(
            throttle_hits.load(Ordering::SeqCst),
            1,
            "冷却期间不得再发搜索请求（限流状态机语义不变）"
        );
        reset_cooldown();
    }

    /// (c) 查失败（5xx）不进任何缓存：第二次调用照常重跑搜索链。
    #[tokio::test(flavor = "multi_thread")]
    async fn transport_failure_is_not_cached_and_retries() {
        let _serial = network_guard().lock().await;
        reset_cooldown();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let base = douban_site(move |_url: String| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::SERVICE_UNAVAILABLE, "douban down".to_string())
            }
        })
        .await;
        let req = stubbed_request(base, "失败不缓存丁", Some("2019"));
        assert!(
            fetch_with(&req, stub_clock)
                .await
                .expect("网络失败对外仍是 Ok(None)")
                .is_none(),
            "查失败不能伪装成确认无结果"
        );
        let after_first = hits.load(Ordering::SeqCst);
        assert!(after_first >= 1);
        assert!(fetch_with(&req, stub_clock).await.expect("fetch").is_none());
        assert!(
            hits.load(Ordering::SeqCst) > after_first,
            "失败后第二次必须重新回源（失败不进任何缓存）"
        );
    }

    /// (d) 同 title/year 并发首次查询只跑一次完整搜索链（moka `try_get_with`）。
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_same_key_runs_chain_once() {
        let _serial = network_guard().lock().await;
        reset_cooldown();
        let main_hits = Arc::new(AtomicUsize::new(0));
        let counter = main_hits.clone();
        let base = douban_site(move |url: String| {
            let counter = counter.clone();
            async move {
                if url.contains("subject_search") {
                    counter.fetch_add(1, Ordering::SeqCst);
                    // 主源挂起一小会，确保并发调用者都赶在同一次 init 完成之前。
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    (StatusCode::OK, search_page_with("并发去重戊"))
                } else if search_endpoint(&url) {
                    empty_search_chain(&url)
                } else if url.contains("rexxar") {
                    (StatusCode::OK, rexxar_detail())
                } else {
                    (StatusCode::NOT_FOUND, String::new())
                }
            }
        })
        .await;
        let req = Arc::new(stubbed_request(base, "并发去重戊", Some("2019")));
        let mut joins = Vec::new();
        for _ in 0..4 {
            let req = req.clone();
            joins.push(tokio::spawn(
                async move { fetch_with(&req, stub_clock).await },
            ));
        }
        let mut results = Vec::new();
        for join in joins {
            results.push(
                join.await
                    .expect("join")
                    .expect("fetch")
                    .expect("四个并发调用都要拿到元数据"),
            );
        }
        assert!(
            results.windows(2).all(|w| w[0] == w[1]),
            "并发返回必须是同一份元数据"
        );
        assert_eq!(
            main_hits.load(Ordering::SeqCst),
            1,
            "同 key 并发首次只跑一次搜索链"
        );
    }

    /// detail_paths moka 化：Tv/Movie 路径记忆、直奔命中路径、失效后重探测。
    #[tokio::test(flavor = "multi_thread")]
    async fn detail_path_memory_guides_rexxar_probing() {
        let _serial = network_guard().lock().await;
        reset_cooldown();
        let probed = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = probed.clone();
        let base = douban_site(move |url: String| {
            let seen = seen.clone();
            async move {
                if search_endpoint(&url) {
                    if url.contains("subject_search") {
                        (StatusCode::OK, search_page_with("路径记忆己"))
                    } else {
                        empty_search_chain(&url)
                    }
                } else if url.contains("/rexxar/") {
                    let path = if url.contains("/tv/") { "tv" } else { "movie" };
                    if let Ok(mut guard) = seen.lock() {
                        guard.push(path.to_string());
                    }
                    if path == "tv" {
                        // 电影条目：tv 必 404（与模块注释一致）。
                        return (StatusCode::NOT_FOUND, String::new());
                    }
                    (StatusCode::OK, rexxar_detail())
                } else {
                    (StatusCode::NOT_FOUND, String::new())
                }
            }
        })
        .await;
        let id = "25853071";
        forget_detail_path(id).await;
        // 每个阶段用不同 year → 不同的元数据缓存键，强制各跑一条冷链，
        // 但候选 id 同为 25853071，观察的是共享的「路径记忆」表。
        let req = stubbed_request(base.clone(), "路径记忆己", Some("2019"));
        let first = fetch_with(&req, stub_clock)
            .await
            .expect("fetch")
            .expect("meta");
        assert_eq!(first.title, "庆余年 第一季", "detail 走 movie 路径命中");
        assert_eq!(probed_paths(&probed), vec!["tv", "movie"]);
        assert_eq!(detail_path_cache().get(id).await, Some(DetailPath::Movie));
        // 记忆生效后，同 id 的新查询直奔 movie，不再试 tv。
        let second_req = stubbed_request(base.clone(), "路径记忆己", None);
        let second = fetch_with(&second_req, stub_clock)
            .await
            .expect("fetch")
            .expect("meta");
        assert_eq!(second.title, "庆余年 第一季");
        assert_eq!(probed_paths(&probed), vec!["tv", "movie", "movie"]);
        // 记住的路径失效（条目变更）：清掉记忆后重新双路径探测。
        forget_detail_path(id).await;
        let third_req = stubbed_request(base, "路径记忆己", Some("2020"));
        assert!(fetch_with(&third_req, stub_clock)
            .await
            .expect("fetch")
            .is_some());
        assert_eq!(
            probed_paths(&probed),
            vec!["tv", "movie", "movie", "tv", "movie"]
        );
    }

    fn probed_paths(probed: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        probed.lock().expect("probed paths").clone()
    }

    /// 测试组装用的同步写入：真实查询路径走 `try_get_with` / async `insert`，
    /// 不经这里。moka future Cache 的 `insert` future 首次 poll 即完成记账
    /// （`now_or_never` 只跳过后台维护），读取一律 async、由 runtime 驱动。
    fn cache_put(key: String, meta: Option<DoubanMeta>) {
        match meta {
            Some(meta) => {
                let _ = positive_cache().insert(key, meta).now_or_never();
            }
            None => {
                let _ = negative_cache().insert(key, ()).now_or_never();
            }
        }
    }

    /// 同 `cache_put`：旧版是同步函数，测试直接调；moka 读取是 async，这里
    /// 改成 async，外层/内层 `Option` 的三态语义与旧版逐一对应
    /// （`Some(Some)` 正命中 / `Some(None)` 确认无结果 / `None` 没查过）。
    async fn cache_get(key: &str) -> Option<Option<DoubanMeta>> {
        if let Some(meta) = positive_cache().get(key).await {
            return Some(Some(meta));
        }
        if negative_cache().get(key).await.is_some() {
            return Some(None);
        }
        None
    }

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
    fn subject_id_result_is_weakly_validated_against_source() {
        let meta = |title: &str, year: &str| {
            coarse_meta(&SuggestItem {
                id: "36344548".into(),
                title: title.into(),
                sub_title: String::new(),
                year: year.into(),
                img: String::new(),
                url: String::new(),
            })
        };
        // 实测样本：源名「童年阴影」+ 豆瓣「童年阴影 Long Shadows (2025)」，年份同为 2025。
        assert!(id_matches_source(
            &meta("童年阴影 Long Shadows‎ (2025)", "2025"),
            "童年阴影",
            Some("2025")
        ));
        // 脏值年份（源常给「2026韩国」）只要开头年份能对上就放行。
        assert!(id_matches_source(
            &meta("谷雨", "2026"),
            "谷雨",
            Some("2026韩国")
        ));
        // 年份差 2 年：不是同一部，回退标题匹配。
        assert!(!id_matches_source(
            &meta("谷雨", "2024"),
            "谷雨",
            Some("2026")
        ));
        // 标题毫无交集 / id 反查空返回：都判不通过。
        assert!(!id_matches_source(
            &meta("流浪地球", "2019"),
            "三体",
            Some("2019")
        ));
        assert!(!id_matches_source(&meta("", ""), "三体", Some("2019")));
        // 缺年份不否决：宁可用 id，也不退回更弱的标题匹配。
        assert!(id_matches_source(&meta("谷雨", ""), "谷雨", None));
        assert_eq!(first_year("2026韩国"), Some(2026));
        assert_eq!(first_year("韩国2026"), None);
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
        // 豆瓣对非中文作品的标题格式是「中文名 原文名 (年份)」：多出来的一段是
        // 原文别名，不是第二部作品。《我的有罪之人》曾因 4 字上限整批漏匹配。
        assert_eq!(
            title_score("我的有罪之人", "我的有罪之人 나의 유죄인간‎ (2026)"),
            Some(90),
            "谚文别名尾缀不该被长度上限拒掉"
        );
        assert_eq!(
            title_score("我的有罪之人 나의 유죄인간", "我的有罪之人"),
            Some(85),
            "反方向同理：查询带原文别名、豆瓣只给中文名也能认回"
        );
        assert_eq!(
            title_score("玲子", "玲子 Reiko (1995)"),
            Some(90),
            "拉丁别名同样放行"
        );
        // 尾缀里混进数字就不是「原文别名」，不能靠这条放宽放行。
        // （长汉字尾缀的拒绝已由上面「三体 动画版 全三季合集」那条守着；
        // 「第二季」这类季/部尾缀在规范化阶段就被剥掉，不参与这里。）
        assert_eq!(title_score("玲子", "玲子 Reiko 2"), None);
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
    fn request_host_keeps_scheme_host_and_drops_query() {
        // 直连：记豆瓣真实主机，query 里的片名 / token 不落进这个字段。
        assert_eq!(
            request_host("https://movie.douban.com/j/subject_abstract?subject_id=1&token=x"),
            "https://movie.douban.com"
        );
        // 走 CDN 改写后：记的是实际命中的镜像域名——这正是排障要确认的「代理生效没」。
        let via_tencent = proxy_url(
            ProxyKind::CdnTencent,
            "",
            "https://m.douban.com/rexxar/api/v2/tv/1?ck=&for_mobile=1",
        )
        .expect("rewrite");
        assert_eq!(request_host(&via_tencent), "https://m.douban.cmliussss.net");
        // 非 URL 的极端串不该 panic，退回去 query 的原文。
        assert!(!request_host("not a url ?x=1").contains("?x=1"));
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
    fn coarse_meta_uses_search_cover_without_detail() {
        let item = SuggestItem {
            id: "25853071".into(),
            title: "庆余年 第一季".into(),
            year: "2019".into(),
            img: "https://img3.doubanio.com/search.jpg".into(),
            ..Default::default()
        };
        let meta = coarse_meta(&item);
        assert_eq!(meta.id, "25853071");
        assert_eq!(meta.title, "庆余年 第一季");
        assert_eq!(meta.year, "2019");
        // 粗结果不跑详情：评分 / 简介 / 类型留空，由细结果补。
        assert_eq!(meta.rating, 0.0);
        assert!(meta.intro.is_empty());
        assert!(meta.genres.is_empty());
        // 海报来自搜索候选 cover_url，并补 Referer（豆瓣图床 418 约束）。
        assert_eq!(
            meta.pic,
            "https://img3.doubanio.com/search.jpg@Referer=https://movie.douban.com/"
        );
        assert_eq!(meta.url, "https://movie.douban.com/subject/25853071/");
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
        assert!(
            parse_search_page(r#"<script>window.__DATA__ = {"items": []};</script>"#).is_empty()
        );
        assert_eq!(trailing_year("庆余年 第二季"), "");
        assert_eq!(trailing_year("沙丘(2021)"), "2021");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cache_roundtrip_uses_normalized_key() {
        // moka 读取是 async：本测试只碰自己的三个 key（全局缓存、并行用例，
        // 不能再用整表清空/随机 key 断言 miss）。
        // 同季的不同写法共用一个键（空格/全角括号差异）。
        assert_eq!(
            cache_key("庆余年 第一季", Some("2019"), ""),
            cache_key("庆余年第一季", Some("2019"), ""),
            "同季不同写法共用一个键"
        );
        // 不同季必须分开：缓存早于 pick_candidate 打分命中，键若剥季，无年份时
        // 第二季会拿到第一季的条目。
        assert_ne!(
            cache_key("庆余年 第一季", Some("2019"), ""),
            cache_key("庆余年（第二季）", Some("2019"), ""),
            "同剧不同季必须分键"
        );
        // 代理前缀必须进键：换完代理还命中旧结果，用户会以为「换代理没用」。
        assert_ne!(
            cache_key("庆余年 第一季", Some("2019"), ""),
            cache_key("庆余年 第一季", Some("2019"), "https://ghproxy.example/"),
            "不同代理前缀必须分键"
        );
        let key = cache_key("庆余年 第一季", Some("2019"), "");
        cache_put(key.clone(), Some(meta()));
        assert_eq!(
            cache_get(&key).await.expect("hit").expect("positive"),
            meta()
        );
        assert!(cache_get("roundtrip-missing-key|").await.is_none());
        // 负结果同样入缓存：轮播/详情页重复问同一个查不到的片名不再走网络。
        let neg_key = cache_key("查无此片roundtrip", None, "");
        cache_put(neg_key.clone(), None);
        assert_eq!(cache_get(&neg_key).await.expect("negative hit"), None);
        // 三态各归其表：「确认无结果」是 Some(None)，不是「没查过」的 None。
        assert_eq!(cache_get(&key).await, Some(Some(meta())));
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
