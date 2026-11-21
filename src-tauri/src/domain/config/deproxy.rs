//! 还原「本机代理 URL」里嵌着的真实地址。
//!
//! 规则来自源码，不来自某一份订阅的样本：
//!
//! - TVBox（q215613905/TVBoxOS）`com.github.catvod.Proxy#getUrl` 只产出
//!   `http://127.0.0.1:<port>/proxy`；`RemoteServer` 是 NanoHTTPD，端口默认
//!   9978，`/proxy` 把请求参数交给 `ApiConfig.proxyLocal`。
//! - FongMi `BaseLoader#proxy(params)` 按参数分派：`siteKey` → 站点 spider，
//!   `do=js|py` → JS/Python loader，其余 → jar loader。也就是说官方 `/proxy`
//!   是**参数驱动**的，语义由 spider 决定，不能一律当成透明转发。
//! - TVBox 生成直播源时也写 `http://127.0.0.1:9978/proxy?do=live&type=txt&ext=…`。
//!
//! 结论：两家官方都只有 `/proxy`，**没有 `/p/` 或 `/c/`**。订阅里出现的
//! `/p/0/proxy/…`、`/c/…` 属于第三方壳的私有路径。为它们逐个枚举前缀，等于把
//! 某一份订阅的私有约定写进产品，换个壳就失效。这些写法只有一个共同点：
//! **把完整的目标 URL 原样嵌在路径里**。所以这里统一按「在 loopback 代理 URL
//! 中提取内嵌的绝对地址」处理，与具体前缀无关。
//!
//! 两条硬约束：
//! 1. 带 `do=` / `siteKey=` 的是 spider 回调（包括 Luma 自己的 `?do=py`），语义
//!    不是转发，一律不动；
//! 2. 提取出的地址必须是公网 http(s)。直播的 `/c/…` 剥掉外壳后内层仍是本机转码
//!    服务（如 `127.0.0.1:35456` 的 m3u），还原出来也没用，直接判为不可还原。

use std::net::IpAddr;

/// 一层壳剥一次；嵌套代理存在，但不会有更深的。
const MAX_UNWRAP: usize = 4;

/// 若地址指向本机代理且能还原出公网目标，返回还原后的地址；否则 `None`。
pub(crate) fn restore(url: &str) -> Option<String> {
    let mut current = url.trim().to_string();
    let mut changed = false;

    // 先剥到底再统一校验终点：中途判断会把「第二层仍是本机转发的合法嵌套」
    // 误判成不可拆。
    for _ in 0..MAX_UNWRAP {
        let Some(target) = unwrap_once(&current) else {
            break;
        };
        current = target;
        changed = true;
    }

    (changed && is_direct_target(&current)).then_some(current)
}

fn unwrap_once(url: &str) -> Option<String> {
    let rest = loopback_path(url)?;
    // spider 回调靠参数认领，里面的地址是「交给爬虫处理」而不是「转发」。
    if is_spider_callback(rest) {
        return None;
    }

    // 多数私有壳直接拼原文；TVBox 的 `?url=` 是 percent-encoded，解得动再试一次。
    if let Some(target) = embedded_url(rest) {
        return Some(target.to_string());
    }
    let decoded = percent_decode(rest)?;
    if decoded != rest {
        if let Some(target) = embedded_url(&decoded) {
            return Some(target.to_string());
        }
    }
    None
}

/// `http://<loopback>:<port>/...` → 从第一个 `/` 起的剩余部分。
fn loopback_path(url: &str) -> Option<&str> {
    let offset = scheme_len(url)?;
    // `get` 而不是直接切片：路径里可能有中文，必须落在字符边界上。
    let after = url.get(offset..)?;
    let slash = after.find('/')?;
    if !is_loopback_authority(&after[..slash]) {
        return None;
    }
    after.get(slash..)
}

/// 只认 `http://` / `https://`，按字节比较（大小写不敏感）。
fn scheme_len(url: &str) -> Option<usize> {
    let bytes = url.as_bytes();
    for scheme in [b"http://".as_slice(), b"https://".as_slice()] {
        if bytes.len() >= scheme.len() && bytes[..scheme.len()].eq_ignore_ascii_case(scheme) {
            return Some(scheme.len());
        }
    }
    None
}

/// `127.0.0.1:10079` / `localhost:9978` / `[::1]:8080`。
fn is_loopback_authority(authority: &str) -> bool {
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        authority
            .rsplit_once(':')
            .map_or(authority, |(host, _)| host)
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

/// 在路径/查询里找第一个**非开头**的绝对地址。
///
/// 开头的位置留给 URL 自己的 scheme（`/p/0/proxy/https://…` 里第一个 `http`
/// 出现在 `/` 之后，所以从索引 0 排除即可）。
fn embedded_url(text: &str) -> Option<&str> {
    for (index, _) in text.match_indices("http") {
        if index == 0 {
            continue;
        }
        let tail = text.get(index..)?;
        if tail.starts_with("http://") || tail.starts_with("https://") {
            return Some(tail);
        }
    }
    None
}

/// `do=` / `siteKey=` 是 spider 回调的认领参数，出现任何一个都不还原。
fn is_spider_callback(rest: &str) -> bool {
    let Some((_, query)) = rest.split_once('?') else {
        return false;
    };
    url::form_urlencoded::parse(query.as_bytes())
        .any(|(key, _)| key == "do" || key.eq_ignore_ascii_case("siteKey"))
}

fn percent_decode(text: &str) -> Option<String> {
    percent_encoding::percent_decode_str(text)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}

/// 还原后的目标必须能直连：http(s) + 非 loopback / 私有 / 保留地址。
fn is_direct_target(url: &str) -> bool {
    let Some(offset) = scheme_len(url) else {
        return false;
    };
    let Some(after) = url.get(offset..) else {
        return false;
    };
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let authority = after.get(..end).unwrap_or_default();
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        authority
            .rsplit_once(':')
            .map_or(authority, |(host, _)| host)
    };

    if host.eq_ignore_ascii_case("localhost") {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) => !is_unroutable(ip),
        Err(_) => !host.is_empty(),
    }
}

fn is_unroutable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_private_prefixes_without_knowing_them() {
        // 这些前缀都不在 TVBox/FongMi 源码里，属于第三方壳；靠「提取内嵌地址」而不是枚举。
        for url in [
            "http://127.0.0.1:10079/p/0/proxy/https://ikunzyapi.com/api.php/provide/vod/?ac=list&pg=2",
            "http://127.0.0.1:10079/whatever/deep/path/https://a.com/x?y=1",
            "http://localhost:8080/proxy/https://b.com/z",
        ] {
            let restored = restore(url).unwrap_or_else(|| panic!("{url} 应能还原"));
            assert!(restored.starts_with("https://"), "{url} → {restored}");
        }
        assert_eq!(
            restore(
                "http://127.0.0.1:10079/p/0/proxy/https://ikunzyapi.com/api.php/provide/vod/?ac=list&pg=2"
            )
            .as_deref(),
            Some("https://ikunzyapi.com/api.php/provide/vod/?ac=list&pg=2")
        );
    }

    #[test]
    fn unwraps_official_query_form() {
        // TVBox `Proxy.getUrl` 产出 `/proxy`，参数 percent-encoded。
        let inner = "https%3A%2F%2Fexample.com%2Flive.m3u8%3Ftoken%3D1";
        assert_eq!(
            restore(&format!("http://127.0.0.1:9978/proxy?url={inner}")).as_deref(),
            Some("https://example.com/live.m3u8?token=1")
        );
    }

    #[test]
    fn leaves_spider_callbacks_alone() {
        // BaseLoader 按 do / siteKey 分派，这些不是转发。
        for url in [
            "http://127.0.0.1:9978/proxy?do=py&x=1",
            "http://127.0.0.1:9978/proxy?do=live&type=txt&ext=http://a.com/live.m3u",
            "http://127.0.0.1:9978/proxy?siteKey=abc&url=https://a.com/x",
        ] {
            assert_eq!(restore(url), None, "{url} 是 spider 回调，不该被改写");
        }
    }

    #[test]
    fn leaves_public_and_relative_addresses_alone() {
        for url in [
            "https://suoniapi.com/api.php/provide/vod/",
            "http://cj.ffzyapi.com/api.php/provide/vod",
            "./lib/iptv.m3u",
            "csp_Douban",
        ] {
            assert_eq!(restore(url), None, "{url} 不该被改写");
        }
    }

    #[test]
    fn refuses_non_public_targets() {
        // 剥完还是本机/私网/非 http：不是可直连的透明代理，别把后门开回来。
        for url in [
            // FongMi/TVBox 直播里真实存在的转码路径：内层是另一个本机服务。
            "http://127.0.0.1:10079/c/3600/null/http://127.0.0.1:35456/all.m3u",
            "http://127.0.0.1:10079/p/0/proxy/http://192.168.1.9/x.m3u",
            "http://127.0.0.1:10079/p/0/proxy/file:///etc/passwd",
            "http://127.0.0.1:10079/p/0/proxy/ftp://a.com/x",
        ] {
            assert_eq!(restore(url), None, "{url} 不该被还原");
        }
    }

    #[test]
    fn handles_non_ascii_without_panic() {
        // 与 normalize 里那个字节切片崩溃同源：带中文的地址必须落在字符边界。
        assert_eq!(
            restore("http://127.0.0.1:10079/p/0/proxy/https://饭太硬.top/深色壁纸/api.php")
                .as_deref(),
            Some("https://饭太硬.top/深色壁纸/api.php")
        );
        assert_eq!(restore("https://饭太硬.top/深色壁纸/api.php"), None);
        assert_eq!(restore("http://127.0.0.1:10079/p/0/proxy/https://a.com/中文"), Some("https://a.com/中文".to_string()));
    }

    #[test]
    fn unwraps_nested_layers() {
        let url = "http://127.0.0.1:10079/p/0/proxy/http://127.0.0.1:9978/proxy/https://a.com/x";
        assert_eq!(restore(url).as_deref(), Some("https://a.com/x"));
    }

    #[test]
    fn rejects_invalid_utf8_after_decoding() {
        // 破坏的 percent 序列不能 panic，只能放弃还原。
        assert_eq!(restore("http://127.0.0.1:9978/proxy?url=%FF%FE"), None);
    }
}
