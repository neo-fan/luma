use super::*;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;

/// 校验通过的 host → IP 登记处。
///
/// 一石二鸟：
/// 1. `check_target` 解析并审查通过后把结果登记在这里；
/// 2. 反代所有 reqwest 客户端挂着 `PinnedResolver`（见下），**建连时的
///    解析直接复用这份已审查的结果**——校验与建连之间不再有第二次 DNS
///    解析，短 TTL / 轮询 DNS 的重绑定（校验时公网、建连时 127.0.0.1）
///    就此关死；条目过期后的下一次建连会重新解析并重新审查（不再是
///    check-then-connect 的二次解析，而是同一处审查）。
///
/// TTL 取 60s：媒体会话里分片请求密集复用条目，省 DNS；过期成本只有一次
/// 解析，且审查跟每一次过期重建走。
pub(super) const PIN_TTL: Duration = Duration::from_secs(60);

/// 钉住表容量上限：超限即整表清空（反正条目是纯缓存，清空=重新解析+重新
/// 审查，安全语义不变）。
const PINNED_MAP_CAP: usize = 256;

#[derive(Clone)]
pub(super) struct Pinned {
    pub(super) ips: Arc<[IpAddr]>,
    pub(super) expires: std::time::Instant,
}

static VALIDATED: OnceLock<Mutex<HashMap<String, Pinned>>> = OnceLock::new();

fn validated() -> &'static Mutex<HashMap<String, Pinned>> {
    VALIDATED.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn pin(host: &str, ips: &[IpAddr], ttl: Duration) {
    let mut map = validated()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if map.len() >= PINNED_MAP_CAP {
        map.clear();
    }
    map.insert(
        host.to_string(),
        Pinned {
            ips: ips.to_vec().into(),
            expires: std::time::Instant::now() + ttl,
        },
    );
}

/// 取仍在有效期内的钉住结果；过期条目顺手删除。
pub(super) fn pinned(host: &str) -> Option<Pinned> {
    let mut map = validated()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match map.get(host) {
        Some(entry) if entry.expires > std::time::Instant::now() => Some(entry.clone()),
        Some(_) => {
            map.remove(host);
            None
        }
        None => None,
    }
}

fn blocked_err(ip: IpAddr) -> String {
    format!("target {ip} is not allowed")
}

/// 对一组已解析地址逐条审查（`check_target` 与 `PinnedResolver` 共用）。
fn audit_addrs(host: &str, ips: &[IpAddr]) -> Result<(), String> {
    if ips.is_empty() {
        return Err(format!("resolve {host} returned no addresses"));
    }
    for ip in ips {
        if is_blocked(*ip) {
            return Err(format!("target {host} resolves to blocked address {ip}"));
        }
    }
    Ok(())
}

/// scheme + host（IP 字面量）的同步校验；域名 host 交回调用方解析
/// （`check_target` 用 tokio 解析、`PinnedResolver` 用阻塞解析）。
fn check_literal(scheme: &str, host: Option<&str>) -> Result<Option<IpAddr>, String> {
    if !matches!(scheme, "http" | "https") {
        return Err(format!("scheme {scheme} not allowed"));
    }
    let host = host.ok_or_else(|| "url has no host".to_string())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked(ip) {
            return Err(blocked_err(ip));
        }
        return Ok(Some(ip));
    }
    Ok(None)
}

/// reqwest 自定义 DNS：命中已审查登记 → 直接复用；未命中/过期 → 当场解析
/// 并**审查后再放行**，绝不让被禁地址进入建连。
///
/// 这是「校验-建连同址」的关键一环：`check_target` 的 tokio 解析与 reqwest
/// 建连解析不再是两次独立查询——重绑定型 DNS 在校验时给公网、建连时给
/// 127.0.0.1 的把戏没有第二次机会；每一跳重定向的目标域名也在这条通道上
/// 被同一标准审查。过期重建走 `spawn_blocking`（阻塞解析不卡 tokio worker），
/// 每个 host 至多每 60s 一次，成本可忽略。
pub(super) struct PinnedResolver;

impl reqwest::dns::Resolve for PinnedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        if let Some(pinned) = pinned(&host) {
            let addrs: Vec<std::net::SocketAddr> = pinned
                .ips
                .iter()
                .map(|ip| std::net::SocketAddr::new(*ip, 0))
                .collect();
            return Box::pin(async move { Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs) });
        }
        let blocking_host = host.clone();
        let join = tokio::task::spawn_blocking(move || -> Result<Vec<IpAddr>, String> {
            std::net::ToSocketAddrs::to_socket_addrs(&(blocking_host.as_str(), 443u16))
                .map(|iter| iter.map(|addr| addr.ip()).collect::<Vec<IpAddr>>())
                .map_err(|err| format!("resolve {blocking_host} failed: {err}"))
        });
        Box::pin(async move {
            let ips = join
                .await
                .map_err(|err| format!("dns task failed: {err}"))??;
            audit_addrs(&host, &ips)?;
            pin(&host, &ips, PIN_TTL);
            let addrs: Vec<std::net::SocketAddr> = ips
                .iter()
                .map(|ip| std::net::SocketAddr::new(*ip, 0))
                .collect();
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub(super) fn pinned_resolver() -> Arc<PinnedResolver> {
    Arc::new(PinnedResolver)
}

/// 每一跳重定向的同步校验（`reqwest::redirect::Policy` 的回调运行在请求
/// 线程上，不能 `await`）。
///
/// 反代此前只在**初始 URL** 上跑 `check_target`，而 reqwest 默认自动跟随
/// ≤10 次 30x——一个过审的外网地址可以用 `302 → http://127.0.0.1:9222/…`
/// 把宿主打到任何仅监听 loopback 的服务（dev 的 CDP、本机 HTTP），再把
/// 响应以 `access-control-allow-origin: *` 流回网页。scheme/IP 字面量在这一
/// 层拦下；域名跳点由 `PinnedResolver` 在建连时审查（同一标准、无二次解析）。
/// 用 `error`（而非 `stop`）失败——`stop` 会把裸 302 透给播放器，hls.js
/// 对重定向响应没有处理能力。
pub(super) fn redirect_guard(allow_local: bool) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        let url = attempt.url();
        if allow_local {
            return attempt.follow();
        }
        match check_literal(url.scheme(), url.host_str()) {
            Ok(_) => attempt.follow(),
            Err(reason) => attempt.error(format!("redirect refused: {reason}")),
        }
    })
}

pub(super) async fn check_target(url: &Url, allow_local: bool) -> Result<(), String> {
    if allow_local {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!("scheme {} not allowed", url.scheme()));
        }
        return Ok(());
    }
    if let Some(_ip) = check_literal(url.scheme(), url.host_str())? {
        return Ok(());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "url has no host".to_string())?;
    // 已审查且仍在 TTL 内的 host 直接放行：HLS 分片/封面是逐请求过这条路的，
    // 每次重解析 DNS 纯属浪费，而钉住项本身就是「审查通过」的产物——建连时
    // `PinnedResolver` 只用这批已审 IP，重绑定拿不到第二次机会。
    if pinned(host).is_some() {
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|err| format!("resolve {host} failed: {err}"))?;
    let ips: Vec<IpAddr> = addrs.map(|addr| addr.ip()).collect();
    audit_addrs(host, &ips)?;
    pin(host, &ips, PIN_TTL);
    Ok(())
}

pub(super) fn is_blocked(ip: IpAddr) -> bool {
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

pub(super) fn deny(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("access-control-allow-origin", "*")
        .body(Body::from(message.to_string()))
        .unwrap_or_else(|_| status.into_response())
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn literal_loopback_is_blocked() {
        let err = check_literal("http", Some("127.0.0.1")).unwrap_err();
        assert!(err.contains("not allowed"), "{err}");
    }

    #[test]
    fn literal_public_passes_and_hostname_defers_to_resolver() {
        assert_eq!(
            check_literal("http", Some("8.8.8.8")).unwrap(),
            Some("8.8.8.8".parse().unwrap())
        );
        assert!(check_literal("http", Some("example.com"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn audit_flags_rebinding_answer_and_empty_answer() {
        let err = audit_addrs("flippy.example", &["127.0.0.1".parse().unwrap()]).unwrap_err();
        assert!(err.contains("blocked address 127.0.0.1"), "{err}");
        let err = audit_addrs("none.example", &[]).unwrap_err();
        assert!(err.contains("no addresses"), "{err}");
        assert!(audit_addrs("ok.example", &["93.184.216.34".parse().unwrap()]).is_ok());
    }

    #[test]
    fn scheme_rejected_for_non_http() {
        assert!(check_literal("ftp", Some("example.com")).is_err());
    }

    #[test]
    fn pinned_registry_roundtrip_and_expiry() {
        let host = "pin.roundtrip.example";
        let ips = vec!["93.184.216.34".parse().unwrap()];
        pin(host, &ips, PIN_TTL);
        let got = pinned(host).expect("fresh pin");
        assert_eq!(&*got.ips, ips.as_slice());
        pin(host, &ips, Duration::ZERO);
        assert!(pinned(host).is_none(), "expired pin must drop");
    }

    #[test]
    fn allow_local_short_circuits_before_literal_audit() {
        // allow_local（stub / 联调）下 loopback 初跳必须放行——这是
        // `LUMA_PROXY_ALLOW_LOCAL=1` 的全部意义。短路在 check_target /
        // redirect_guard 入口；check_literal 本身不感知开关，这里直接验证
        // 「同一无关 URL 在开关开时走 Ok 分支」的入口语义由 async 测试覆盖，
        // 此处守住字面量层的判定。
        let url = Url::parse("http://127.0.0.1:8787/cms/json").unwrap();
        assert!(check_literal("http", url.host_str()).is_err());
    }

    #[tokio::test]
    async fn allow_local_admits_loopback_target() {
        let url = Url::parse("http://127.0.0.1:8787/cms/json").unwrap();
        check_target(&url, true)
            .await
            .expect("allow_local admits loopback");
        check_target(&url, false)
            .await
            .expect_err("guard denies loopback");
    }
}
