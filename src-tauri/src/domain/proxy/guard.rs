use super::*;

pub(super) async fn check_target(url: &Url, allow_local: bool) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("scheme {} not allowed", url.scheme()));
    }
    let host = url.host_str().ok_or_else(|| "url has no host".to_string())?;
    if allow_local {
        return Ok(());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if is_blocked(ip) {
            Err(format!("target {ip} is not allowed"))
        } else {
            Ok(())
        };
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|err| format!("resolve {host} failed: {err}"))?;
    for addr in addrs {
        if is_blocked(addr.ip()) {
            return Err(format!("target {host} resolves to blocked address {}", addr.ip()));
        }
    }
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
