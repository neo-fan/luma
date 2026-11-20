//! GitHub 资源加速（raw / release / archive 统一用前缀拼接）。
//!
//! 配置里大量 `ext` / `jar` / `spider` / `logo` 指向 GitHub，国内直连经常超时
//! 到整站不可用。这里在**导入落库前**把 GitHub 系 URL 改写成加速地址，播放和
//! 抓取链路照旧，不需要在请求层再做一次判断。
//!
//! 三条硬约束：
//!   1. 只碰 GitHub 系主机。用户自己的 API、图床、直播地址一律原样，否则
//!      「加速」会变成「改坏」。
//!   2. 先剥后套。`ghfast.top/gh-proxy.com/https://github.com/...` 这种多段
//!      前缀能一次拆干净，所以切换代理、重复导入都是幂等的。
//!   3. 空前缀 = 直连（用户主动关掉加速），不是「没配置」。

use crate::error::{code, AppError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};

/// meta 键：存前缀字符串，空串表示直连。键不存在 = 从未选过 → 用内置默认。
pub const META_KEY: &str = "github_proxy";

/// 默认代理：2026-11-14 实测三家里 raw/archive 延时最低（0.14~0.33s）。
pub const DEFAULT_PROXY: &str = "https://gh-proxy.com/";

/// 内置三家加速代理：订阅地址 / GitHub 资源拉取时并发竞速，谁先成功用谁。
pub const BUILTIN_PREFIXES: [&str; 3] = [
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://ghproxy.net/",
];

/// 探测目标：一个长期存在的小文件，三家的 raw 通道都能取到。
/// 用 GitHub 官方 raw 而不是某个具体源的 ext —— 探针要能长期活着。
const PROBE_TARGET: &str = "https://raw.githubusercontent.com/hunshcn/gh-proxy/master/README.md";

/// GitHub 系主机。子域按后缀匹配（`objects.githubusercontent.com` 等）。
const GITHUB_HOSTS: &[&str] = &[
    "github.com",
    "www.github.com",
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
    "avatars.githubusercontent.com",
    "user-images.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyChoice {
    pub id: String,
    pub label: String,
    /// 空串 = 直连。
    pub prefix: String,
    pub note: String,
}

/// 设置页的候选列表。顺序即推荐顺序，第一个是内置默认。
pub fn choices() -> Vec<ProxyChoice> {
    let row = |id: &str, label: &str, prefix: &str, note: &str| ProxyChoice {
        id: id.into(),
        label: label.into(),
        prefix: prefix.into(),
        note: note.into(),
    };
    vec![
        row(
            "gh-proxy",
            "gh-proxy.com",
            "https://gh-proxy.com/",
            "实测最快（0.1~0.3s），raw / release / archive 全通",
        ),
        row(
            "ghfast",
            "ghfast.top",
            "https://ghfast.top/",
            "老牌公益节点（1~3s），支持 git clone 与 release",
        ),
        row(
            "ghproxy-net",
            "ghproxy.net",
            "https://ghproxy.net/",
            "备用节点（1~18s 波动），大文件优先用前两个",
        ),
        row(
            "direct",
            "直连 GitHub",
            "",
            "不走代理，网络能直连 GitHub 时选这个",
        ),
    ]
}

/// 归一化用户输入的前缀：补尾斜杠、拒绝非 http(s)。
/// 传空串 / `direct` 视为「关掉加速」，返回空串。
pub fn normalize_prefix(raw: &str) -> Result<String, AppError> {
    let text = raw.trim();
    if text.is_empty() || text.eq_ignore_ascii_case("direct") {
        return Ok(String::new());
    }
    let lower = text.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "代理地址必须以 http(s):// 开头",
        ));
    }
    // 前缀自身就是 GitHub 地址时直接拒绝：那会把 URL 拼成 A/B 的死链。
    if host_of(text).map(is_github_host).unwrap_or(false) {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "代理地址不能是 GitHub 自身",
        ));
    }
    Ok(format!("{}/", text.trim_end_matches('/')))
}

fn host_of(url: &str) -> Option<&str> {
    let (_, rest) = url.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    // 去掉 userinfo 与端口：`user@host:443`
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    Some(host)
}

fn is_github_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.ends_with(".githubusercontent.com") {
        return true;
    }
    GITHUB_HOSTS.iter().any(|known| host == *known)
}

/// `prefix + http(s)://...` → (前缀, 裸地址)；没有代理前缀时 None。
pub fn split_proxy(url: &str) -> Option<(&str, &str)> {
    let bare = strip_proxy(url);
    if bare.len() == url.len() {
        None
    } else {
        Some((&url[..url.len() - bare.len()], bare))
    }
}

/// 该前缀是否属于 app 内置三家（内置前缀视为「app 加速」，剥掉存裸并参与竞速）。
pub fn is_builtin_prefix(prefix: &str) -> bool {
    let lower = prefix.to_ascii_lowercase();
    BUILTIN_PREFIXES
        .iter()
        .any(|known| lower.starts_with(known))
}

/// 剥掉（可能多段的）代理前缀后是否落在 GitHub 系主机上。
pub fn is_github_url(url: &str) -> bool {
    host_of(strip_proxy(url))
        .map(is_github_host)
        .unwrap_or(false)
}

/// `https://any.proxy/https://github.com/x` → `https://github.com/x`。
///
/// 只看「第一段路径本身是不是一个 http(s) URL」，不看它指向哪：多段前缀
/// （`ghfast.top/gh-proxy.com/https://github.com/...`）必须一次剥到底。
/// 正常地址的第一段是 owner 名，永远不以 `http` 开头，所以不会误伤；
/// `?url=https://github.com/...` 这种查询参数也不匹配（要求是路径段）。
/// 剥完由调用方判定底层是否 GitHub，非 GitHub 的多段地址会原样返回。
pub fn strip_proxy(url: &str) -> &str {
    let mut current = url.trim();
    while let Some(inner) = nested_target(current) {
        current = inner;
    }
    current
}

/// `https://proxy/<http(s) URL>` → 内层 URL；不是这个形状时返回 None。
fn nested_target(url: &str) -> Option<&str> {
    let (_, rest) = url.split_once("://")?;
    let slash = rest.find('/')?;
    let inner = &rest[slash + 1..];
    let head = inner.get(..8).unwrap_or(inner).to_ascii_lowercase();
    if head.starts_with("http://") || head.starts_with("https://") {
        Some(inner)
    } else {
        None
    }
}

/// 改写单条 URL。非 GitHub 地址原样返回（借 Cow 避免整棵配置树克隆字符串）。
pub fn apply<'a>(url: &'a str, prefix: &str) -> std::borrow::Cow<'a, str> {
    use std::borrow::Cow;
    if !url.contains("://") {
        return Cow::Borrowed(url);
    }
    let bare = strip_proxy(url);
    if !host_of(bare).map(is_github_host).unwrap_or(false) {
        return Cow::Borrowed(url);
    }
    if prefix.is_empty() {
        return if bare.len() == url.len() {
            Cow::Borrowed(url)
        } else {
            Cow::Owned(bare.to_string())
        };
    }
    if let Some(tail) = url.strip_prefix(prefix) {
        // 已经指向当前代理：保留原有写法，不做无意义的往返。
        let _ = tail;
        return Cow::Borrowed(url);
    }
    Cow::Owned(format!("{prefix}{bare}"))
}

/// 递归改写一个 JSON 子树，返回改动条数。
pub fn rewrite_value(value: &mut Value, prefix: &str) -> usize {
    match value {
        Value::String(text) => {
            let next = apply(text, prefix);
            if next.as_ref() != text {
                *text = next.into_owned();
                1
            } else {
                0
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .map(|item| rewrite_value(item, prefix))
            .sum(),
        Value::Object(map) => map
            .values_mut()
            .map(|item| rewrite_value(item, prefix))
            .sum(),
        _ => 0,
    }
}

/// 对整份配置做改写。`_raw` 也要动：它保留的是原始 JSON，前端「查看原始配置」
/// 与重新归一化都会读它，留着未加速的地址等于留个后门。
pub fn rewrite_snapshot(snapshot: &mut crate::config::ConfigSnapshot, prefix: &str) -> usize {
    let mut changed = 0;
    for site in snapshot.sites.iter_mut() {
        changed += rewrite_value(site, prefix);
    }
    for item in snapshot.lives.iter_mut() {
        changed += rewrite_value(item, prefix);
    }
    for item in snapshot.parses.iter_mut() {
        changed += rewrite_value(item, prefix);
    }
    for item in snapshot.headers.iter_mut() {
        changed += rewrite_value(item, prefix);
    }
    for item in snapshot.flags.iter_mut() {
        changed += rewrite_value(item, prefix);
    }
    if let Some(spider) = snapshot.spider.as_mut() {
        let next = apply(spider, prefix);
        if next.as_ref() != spider.as_str() {
            *spider = next.into_owned();
            changed += 1;
        }
    }
    if let Some(wallpaper) = snapshot.wallpaper.as_mut() {
        let next = apply(wallpaper, prefix);
        if next.as_ref() != wallpaper.as_str() {
            *wallpaper = next.into_owned();
            changed += 1;
        }
    }
    changed + rewrite_value(&mut snapshot.raw, prefix)
}

/// 统计一份配置里有多少条**不重复**的 GitHub 链接（已加前缀的也会剥完再判）。
/// UI 拿它显示「N 处链接走加速」，比「本次改了几处」稳定：切到同一个前缀
/// 不会突然显示 0。`_raw` 与结构化字段会重叠，所以用集合去重。
pub fn count_github(snapshot: &crate::config::ConfigSnapshot) -> usize {
    fn collect<'a>(value: &'a Value, out: &mut std::collections::BTreeSet<&'a str>) {
        match value {
            Value::String(text) => {
                let bare = strip_proxy(text);
                if host_of(bare).map(is_github_host).unwrap_or(false) {
                    out.insert(bare);
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect(item, out);
                }
            }
            Value::Object(map) => {
                for item in map.values() {
                    collect(item, out);
                }
            }
            _ => {}
        }
    }
    let mut set = std::collections::BTreeSet::new();
    for site in &snapshot.sites {
        collect(site, &mut set);
    }
    for item in snapshot
        .lives
        .iter()
        .chain(snapshot.parses.iter())
        .chain(snapshot.headers.iter())
        .chain(snapshot.flags.iter())
    {
        collect(item, &mut set);
    }
    collect(&snapshot.raw, &mut set);
    set.len()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub id: String,
    pub prefix: String,
    pub ok: bool,
    /// HTTP 状态；网络层失败时为 0。
    pub status: u16,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 测速：取目标文件的前若干字节即可确认通道可用（不下载整个文件）。
pub async fn probe(choice: &ProxyChoice) -> ProbeResult {
    let started = Instant::now();
    let url = if choice.prefix.is_empty() {
        PROBE_TARGET.to_string()
    } else {
        format!("{}{}", choice.prefix, PROBE_TARGET)
    };
    let outcome = async {
        let client = crate::http::shared_client().map_err(|err| err.message.clone())?;
        let response = client
            .get(&url)
            .timeout(Duration::from_secs(15))
            .header(reqwest::header::USER_AGENT, crate::netrules::DEFAULT_UA)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status().as_u16();
        // 只读一小段：有的镜像对 range 不支持，chunk 读到即算通道通。
        let _ = response.bytes().await.map_err(|err| err.to_string())?;
        Ok::<u16, String>(status)
    }
    .await;
    match outcome {
        Ok(status) => ProbeResult {
            id: choice.id.clone(),
            prefix: choice.prefix.clone(),
            ok: (200..400).contains(&status),
            status,
            ms: started.elapsed().as_millis() as u64,
            error: None,
        },
        Err(error) => ProbeResult {
            id: choice.id.clone(),
            prefix: choice.prefix.clone(),
            ok: false,
            status: 0,
            ms: started.elapsed().as_millis() as u64,
            error: Some(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_github_urls_get_prefixed() {
        let prefix = "https://gh-proxy.com/";
        assert_eq!(
            apply("https://raw.githubusercontent.com/a/b/master/c.js", prefix),
            "https://gh-proxy.com/https://raw.githubusercontent.com/a/b/master/c.js"
        );
        assert_eq!(
            apply("https://github.com/a/b/releases/download/v1/x.apk", prefix),
            "https://gh-proxy.com/https://github.com/a/b/releases/download/v1/x.apk"
        );
        // TVBox 的 jar 常带 md5 后缀，拼接不能吃掉它
        assert_eq!(
            apply("https://github.com/a/b.jar;md5;abc123", prefix),
            "https://gh-proxy.com/https://github.com/a/b.jar;md5;abc123"
        );
    }

    #[test]
    fn foreign_hosts_are_untouched() {
        let prefix = "https://ghfast.top/";
        for url in [
            "https://api.example.com/v1/list",
            "http://192.168.1.2:8080/index.php",
            "https://cdn.jsdelivr.net/gh/a/b@main/c.js",
            "js/drpy2.js",
            "csp_Config",
        ] {
            assert_eq!(apply(url, prefix), url, "不该改写 {url}");
        }
    }

    #[test]
    fn proxy_prefix_is_stripped_before_reapplying() {
        let nested = "https://ghfast.top/https://gh-proxy.com/https://github.com/a/b";
        assert_eq!(strip_proxy(nested), "https://github.com/a/b");
        assert_eq!(
            apply(nested, "https://ghproxy.net/"),
            "https://ghproxy.net/https://github.com/a/b"
        );
    }

    #[test]
    fn direct_mode_strips_existing_prefix() {
        assert_eq!(
            apply("https://ghfast.top/https://github.com/a/b", ""),
            "https://github.com/a/b"
        );
        // 已经是裸地址时借原字符串
        assert!(matches!(
            apply("https://github.com/a/b", ""),
            std::borrow::Cow::Borrowed(_)
        ));
    }

    #[test]
    fn applying_twice_is_idempotent() {
        let prefix = "https://gh-proxy.com/";
        let once = apply("https://raw.githubusercontent.com/a/b/c.js", prefix).into_owned();
        let twice = apply(&once, prefix).into_owned();
        assert_eq!(once, twice);
    }

    #[test]
    fn prefix_normalization() {
        assert_eq!(normalize_prefix("  ").unwrap(), "");
        assert_eq!(normalize_prefix("direct").unwrap(), "");
        assert_eq!(
            normalize_prefix("https://ghfast.top").unwrap(),
            "https://ghfast.top/"
        );
        assert!(normalize_prefix("ghfast.top").is_err());
        assert!(normalize_prefix("https://github.com/a").is_err());
    }

    #[test]
    fn snapshot_rewrite_covers_nested_fields() {
        let mut snapshot: crate::config::ConfigSnapshot =
            serde_json::from_value(serde_json::json!({
                "id": "c1",
                "name": "demo",
                "importedAt": "2026-11-14T00:00:00Z",
                "sites": [{
                    "key": "a",
                    "api": "https://github.com/x/y/raw/main/a.py",
                    "ext": "https://raw.githubusercontent.com/x/y/main/e.js",
                    "logo": "https://img.example.com/logo.png"
                }],
                "parses": [{ "url": "https://github.com/p/q/releases/download/v1/jar" }],
                "wallpaper": "https://github.com/w/wall/raw/main/1.jpg"
            }))
            .unwrap();
        let changed = rewrite_snapshot(&mut snapshot, "https://gh-proxy.com/");
        assert_eq!(changed, 4, "sites.api/ext + parses.url + wallpaper");
        assert_eq!(
            snapshot.sites[0]["api"],
            "https://gh-proxy.com/https://github.com/x/y/raw/main/a.py"
        );
        // 非 GitHub 字段保持原样
        assert_eq!(
            snapshot.sites[0]["logo"],
            "https://img.example.com/logo.png"
        );
    }
}
