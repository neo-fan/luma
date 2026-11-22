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

/// 默认代理。
///
/// 2026-11-22 复测：原默认 `gh-proxy.com` 对 raw / m3u / EPG 一律 403
/// （`Access to proxy rules is forbidden on this hostname`），继续拿它当默认等于
/// 让每个新用户的 py 源和直播列表直接失效。改到实测最快的 `fastgit.cc`
/// （小文件 1.4s、957KB m3u 1.0s、6.3MB XMLTV 1.1s / 5.7MB/s），它也是内置竞速名单的成员。
pub const DEFAULT_PROXY: &str = "https://fastgit.cc/";

/// 内置加速代理：订阅地址 / GitHub 资源拉取时并发竞速，谁先成功用谁。
///
/// 只放实测三项（小文件 raw / 957KB m3u / 6.3MB XMLTV）都通过的节点，按吞吐排序，
/// 且来自不同运营方——同源节点一起挂的情况很常见。2026-11-22 实测：
/// 5.7MB/s / 4.0MB/s / 1.9MB/s。
pub const BUILTIN_PREFIXES: [&str; 3] = [
    "https://fastgit.cc/",
    "https://gh.acmsz.top/",
    "https://git.yylx.win/",
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
            "jsdelivr",
            "jsDelivr CDN",
            JSDELIVR_PREFIX,
            "正规 CDN，最不容易失效；只加速仓库单文件（≤20MB），release 附件与压缩包会自动退回直连",
        ),
        row(
            "fastgit",
            "fastgit.cc",
            "https://fastgit.cc/",
            "默认。实测最快：6.3MB XMLTV 5.7MB/s，raw / m3u 均通过",
        ),
        row(
            "gh-acmsz",
            "gh.acmsz.top",
            "https://gh.acmsz.top/",
            "实测 4.0MB/s；raw / m3u / 大文件均通过",
        ),
        row(
            "git-yylx",
            "git.yylx.win",
            "https://git.yylx.win/",
            "实测 1.9MB/s；raw / m3u / 大文件均通过",
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
    // 必须有主机名。否则 `https://` 这种「只有协议」的前缀会拼出
    // `https://https://raw.githubusercontent.com/...`——表面上像笔误，实际是
    // 我们自己制造的死链（2026-11-22 从日志 `config url repaired` 里发现）。
    match host_of(text) {
        Some(host) if !host.is_empty() => {}
        _ => {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                "代理地址缺少主机名（例如 https://ghfast.top/）",
            ))
        }
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

/// jsDelivr 的默认接入点。
///
/// 它和「前缀拼接」类代理不是一种东西：jsDelivr 只认自己的路径形状
/// `https://cdn.jsdelivr.net/gh/用户/仓库@ref/路径`，所以这里既是一个可选前缀，
/// 也要求 `apply` / `strip_proxy` 会做形态转换。
///
/// 优点：正规 CDN（npm / GitHub 官方合作），国内有节点，不会像公益节点一样突然
/// 跑路。限制：只服务仓库里的**单个文件**（≤20MB），release 附件与 archive
/// 不支持——那些链接会退回直连。
pub const JSDELIVR_PREFIX: &str = "https://cdn.jsdelivr.net/gh/";

/// jsDelivr 的三个官方接入点（同一套 API，差别只在 CDN 线路）。
const JSDELIVR_HOSTS: [&str; 3] = ["cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net"];

pub fn is_jsdelivr_prefix(prefix: &str) -> bool {
    let lower = prefix.trim().trim_end_matches('/').to_ascii_lowercase();
    JSDELIVR_HOSTS
        .iter()
        .any(|host| lower == format!("https://{host}/gh"))
}

/// jsDelivr 形态 → 裸 raw 地址；不是这个形态时 None。
///
/// `https://cdn.jsdelivr.net/gh/u/r@main/py/x.py`
///   → `https://raw.githubusercontent.com/u/r/main/py/x.py`
///
/// 有了这条反向映射，切换前缀、重复导入、`count_github` 才能把 jsDelivr 地址
/// 当成普通 GitHub 地址处理，不会「换成别的代理后旧地址还挂在 jsDelivr 上」。
fn jsdelivr_to_raw(url: &str) -> Option<String> {
    let host = host_of(url)?.to_ascii_lowercase();
    if !JSDELIVR_HOSTS.contains(&host.as_str()) {
        return None;
    }
    let (_, rest) = url.split_once("://")?;
    let path = rest.split_once('/')?.1;
    let path = path.strip_prefix("gh/")?;
    let (user, rest) = path.split_once('/')?;
    let (repo_ref, file) = rest.split_once('/')?;
    let (repo, reference) = repo_ref.rsplit_once('@')?;
    if [user, repo, reference, file].iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(format!(
        "https://raw.githubusercontent.com/{user}/{repo}/{reference}/{file}"
    ))
}

/// 裸 GitHub 文件地址 → jsDelivr 形态；不是「仓库单文件」时 None。
///
/// release 附件（`/releases/download/...`）与 archive 压缩包 jsDelivr 不服务，
/// 返回 None 让调用方退回直连，而不是拼出一个 404 地址。
///
/// 已知限制：分支名里带 `/`（`feature/x`）时 raw 路径本身就有歧义，这里按第一段
/// 当 ref 处理。配置里绝大多数是 `main` / `master` / commit hash，属于可接受范围；
/// 真遇到斜杠分支，用户切回前缀代理即可。
fn raw_to_jsdelivr(raw: &str, prefix: &str) -> Option<String> {
    let host = host_of(raw)?.to_ascii_lowercase();
    let (_, rest) = raw.split_once("://")?;
    let path = &rest[rest.find('/')? + 1..];
    let path = path.split(['?', '#']).next()?;
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let (user, repo, reference, file) = match (host.as_str(), segments.len()) {
        // raw.githubusercontent.com/{user}/{repo}/{ref}/{path}
        ("raw.githubusercontent.com", len) if len >= 4 => {
            (segments[0], segments[1], segments[2], segments[3..].join("/"))
        }
        // github.com/{user}/{repo}/raw/{ref}/{path}
        ("github.com", len) if len >= 5 && segments[2] == "raw" => {
            (segments[0], segments[1], segments[3], segments[4..].join("/"))
        }
        _ => return None,
    };
    Some(format!(
        "{prefix}{user}/{repo}@{reference}/{file}"
    ))
}

/// `prefix + http(s)://...` → (前缀, 裸地址)；没有代理前缀时 None。
///
/// 返回 owned 字符串：jsDelivr 形态的「裸地址」不是原 URL 的子串（要转换形态），
/// 借用切片表达不了。调用点只在导入/归一化这类低频路径上，多一次分配无妨。
pub fn split_proxy(url: &str) -> Option<(String, String)> {
    if let Some(raw) = jsdelivr_to_raw(url) {
        let host = host_of(url)?;
        return Some((format!("https://{host}/gh/"), raw));
    }
    let bare = strip_proxy(url);
    if bare.len() == url.len() {
        None
    } else {
        Some((
            url[..url.len() - bare.len()].to_string(),
            bare.to_string(),
        ))
    }
}


/// 该前缀是否属于「app 自己的加速方式」（内置竞速节点 + jsDelivr）。
/// 这些前缀在导入时会被剥成裸地址，再由 app 按当前选择重新套。
pub fn is_builtin_prefix(prefix: &str) -> bool {
    if is_jsdelivr_prefix(prefix) {
        return true;
    }
    let lower = prefix.to_ascii_lowercase();
    BUILTIN_PREFIXES
        .iter()
        .any(|known| lower.starts_with(known))
}

/// 剥掉（可能多段的）代理前缀后是否落在 GitHub 系主机上。
pub fn is_github_url(url: &str) -> bool {
    if jsdelivr_to_raw(url).is_some() {
        return true;
    }
    host_of(strip_proxy(url))
        .map(is_github_host)
        .unwrap_or(false)
}

/// 是否是 jsDelivr 形态的地址（供导入路径决定「先直取 jsDelivr」还是走竞速）。
pub fn is_jsdelivr_url(url: &str) -> bool {
    jsdelivr_to_raw(url).is_some()
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
    // jsDelivr 形态先还原成裸地址：否则下面的「已指向当前代理就原样返回」和
    // 前缀剥离都认不出它，切走之后旧地址会一直挂在 jsDelivr 上。
    let restored = jsdelivr_to_raw(url);
    let bare = restored.as_deref().unwrap_or_else(|| strip_proxy(url));
    if !host_of(bare).map(is_github_host).unwrap_or(false) {
        return Cow::Borrowed(url);
    }
    if prefix.is_empty() {
        return if restored.is_none() && bare.len() == url.len() {
            Cow::Borrowed(url)
        } else {
            Cow::Owned(bare.to_string())
        };
    }
    if is_jsdelivr_prefix(prefix) {
        return match raw_to_jsdelivr(bare, prefix) {
            // 已经是同一个地址：保持原样，不做无意义的往返。
            Some(next) if next == url => Cow::Borrowed(url),
            Some(next) => Cow::Owned(next),
            // release 附件 / archive：jsDelivr 不服务，保留裸地址直连。
            None => {
                if restored.is_some() {
                    Cow::Owned(bare.to_string())
                } else {
                    Cow::Borrowed(url)
                }
            }
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
    fn collect(value: &Value, out: &mut std::collections::BTreeSet<String>) {
        match value {
            Value::String(text) => {
                // jsDelivr 形态要先还原成裸地址再判：否则同一份文件在「jsDelivr」
                // 与「前缀代理」两种写法下会被算成两条链接。
                let bare = jsdelivr_to_raw(text)
                    .unwrap_or_else(|| strip_proxy(text).to_string());
                if host_of(&bare).map(is_github_host).unwrap_or(false) {
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

/// 测速目标地址。不能简单 `prefix + PROBE_TARGET`：jsDelivr 不是前缀拼接，
/// 那样会拼出一条 404 的链，设置页会把它标成「不可用」。
fn probe_url(prefix: &str) -> String {
    apply(PROBE_TARGET, prefix).into_owned()
}

/// 测速：取目标文件的前若干字节即可确认通道可用（不下载整个文件）。
pub async fn probe(choice: &ProxyChoice) -> ProbeResult {
    let started = Instant::now();
    let url = probe_url(&choice.prefix);
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
    fn jsdelivr_rewrites_raw_files_and_round_trips() {
        let raw = "https://raw.githubusercontent.com/cluntop/tvbox/main/py/douban.py";
        let jd = apply(raw, JSDELIVR_PREFIX);
        assert_eq!(
            jd,
            "https://cdn.jsdelivr.net/gh/cluntop/tvbox@main/py/douban.py"
        );
        // 再套一次不叠加（重复导入 / 重复切换都是幂等的）
        assert_eq!(apply(jd.as_ref(), JSDELIVR_PREFIX), jd);
        // 切回前缀代理：必须能从 jsDelivr 形态还原成裸地址，不能把 jsDelivr
        // 地址整个塞进新前缀里（那会得到一条永远 404 的链）
        assert_eq!(
            apply(jd.as_ref(), "https://fastgit.cc/"),
            "https://fastgit.cc/https://raw.githubusercontent.com/cluntop/tvbox/main/py/douban.py"
        );
        // 关掉加速 = 回到裸地址
        assert_eq!(apply(jd.as_ref(), ""), raw);
        assert!(is_github_url(jd.as_ref()));
        // 设置页把前缀原样存库，归一化不能把它当非法地址或改写形态。
        assert_eq!(normalize_prefix(JSDELIVR_PREFIX).unwrap(), JSDELIVR_PREFIX);
        assert_eq!(
            split_proxy(jd.as_ref()).map(|(prefix, _)| prefix),
            Some("https://cdn.jsdelivr.net/gh/".to_string())
        );
    }

    #[test]
    fn jsdelivr_leaves_release_assets_to_direct() {
        // jsDelivr 不服务 release 附件与 archive 压缩包。拼上去只会造出一条 404，
        // 不如保留裸地址直连（用户至少还有机会下载）。
        let apk = "https://github.com/a/b/releases/download/v1/x.apk";
        assert_eq!(apply(apk, JSDELIVR_PREFIX), apk);
        let zip = "https://github.com/a/b/archive/refs/heads/main.zip";
        assert_eq!(apply(zip, JSDELIVR_PREFIX), zip);
        // 但 github.com/.../raw/... 是单文件，应该被转换
        assert_eq!(
            apply("https://github.com/a/b/raw/main/x.py", JSDELIVR_PREFIX),
            "https://cdn.jsdelivr.net/gh/a/b@main/x.py"
        );
    }

    #[test]
    fn probe_url_understands_jsdelivr() {
        // 探测地址必须走 apply 的形态转换，否则设置页会把 jsDelivr 标成不可用。
        assert_eq!(
            probe_url(JSDELIVR_PREFIX),
            "https://cdn.jsdelivr.net/gh/hunshcn/gh-proxy@master/README.md"
        );
        assert_eq!(
            probe_url("https://fastgit.cc/"),
            format!("https://fastgit.cc/{PROBE_TARGET}")
        );
        assert_eq!(probe_url(""), PROBE_TARGET);
    }

    #[test]
    fn builtin_prefixes_are_usable_proxies() {
        // 名单是手写的，最容易出的错是「少个斜杠」或「把 GitHub 自己写进去」，
        // 两者都会把 URL 拼成死链。默认值必须在名单里（否则竞速时少了首选节点）。
        assert!(
            BUILTIN_PREFIXES.contains(&DEFAULT_PROXY),
            "默认前缀 {DEFAULT_PROXY} 不在内置名单里"
        );
        for prefix in BUILTIN_PREFIXES {
            assert!(prefix.ends_with('/'), "{prefix} 必须以 / 结尾");
            assert_eq!(
                normalize_prefix(prefix).unwrap(),
                prefix,
                "{prefix} 归一化后应该不变"
            );
        }
    }

    #[test]
    fn choices_are_unique_and_consistent() {
        // 设置页按这个顺序渲染；重复的前缀会让「当前选中」对不上，重复的 id 会让
        // React key 冲突。
        let list = choices();
        let mut ids = std::collections::HashSet::new();
        let mut prefixes = std::collections::HashSet::new();
        for choice in &list {
            assert!(ids.insert(choice.id.clone()), "重复的 id: {}", choice.id);
            assert!(
                prefixes.insert(choice.prefix.clone()),
                "重复的前缀: {}",
                choice.prefix
            );
            assert!(
                !choice.label.is_empty() && !choice.note.is_empty(),
                "{}",
                choice.id
            );
        }
        assert!(
            prefixes.contains(DEFAULT_PROXY),
            "设置页必须能选到默认前缀 {DEFAULT_PROXY}"
        );
    }

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
            // jsDelivr 不在这里：它是 app 支持的镜像形态，会被还原成裸 GitHub
            // 地址再套当前前缀（见 jsdelivr_rewrites_raw_files_and_round_trips）。
            "https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js",
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
        // 只有协议没有主机：接受它就会把每条地址拼成 `https://https://...`。
        assert!(normalize_prefix("https://").is_err());
        assert!(normalize_prefix("https:///").is_err());
        // 带路径的接入点（jsDelivr）是合法的
        assert_eq!(
            normalize_prefix("https://cdn.jsdelivr.net/gh").unwrap(),
            "https://cdn.jsdelivr.net/gh/"
        );
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
