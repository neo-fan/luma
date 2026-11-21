use super::*;
use futures_util::Stream;
use std::collections::HashSet;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

/// 记住已经记过 warn 的图床域名，返回「这是本机第一次失败」。
///
/// 一次聚合搜索能同时拉 200+ 张封面，逐条 `warn` 会把日志窗口冲干净，真正
/// 需要的信号（哪个图床连不上、原因是什么）反而看不见。同一 host 只记一条
/// warn，后续降级成 debug。
fn first_image_failure(host: &str) -> bool {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let mut seen = match SEEN.get_or_init(|| Mutex::new(HashSet::new())).lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if host.is_empty() {
        return false;
    }
    seen.insert(host.to_string())
}

/// 封面代理的所有失败出口都从这里过：带 host + 分类原因落一条日志。
///
/// `kind` 是排查的第一现场：`tls` / `dns` 是本机网络（或 Clash fake-IP）的
/// 问题，`status` / `not-image` 才是上游内容的问题，别混成一句 502。
fn log_image_failure(
    target: &Url,
    kind: ImageFailure,
    reason: &str,
    first_kind: Option<ImageFailure>,
) {
    let host = target.host_str().unwrap_or("");
    // 有第二次尝试时，最终分类只是「第二次怎么失败的」；第一次的 tls/dns 才是
    // 判断「本机网络问题」的关键，所以两条都留在同一行里。
    let first_kind = first_kind.map(ImageFailure::as_str).unwrap_or("-");
    if first_image_failure(host) {
        tracing::warn!(host, url = %target, kind = kind.as_str(), first_kind, reason, "poster fetch failed");
    } else {
        tracing::debug!(host, url = %target, kind = kind.as_str(), first_kind, reason, "poster fetch failed again");
    }
}

/// 从文件头认图片格式。
///
/// 不少图床对 `.jpg` 回 `application/octet-stream` / `binary/octet-stream`
/// （实测 `pic.drleao.cn`、`pic.cdn.drama.9ddm.com`、`xjimg.cdn-xj.cc`）。
/// 只看 `content-type` 会把真图当「不是图片」拒掉，聚合搜索一屏十几张黑卡。
pub(super) fn image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") {
        return Some("image/avif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    None
}

/// 浏览器味的 UA / Accept，给 `/image` 的第二次尝试用。
///
/// 默认头是 `okhttp/3.15`（TVBox 生态的约定），但相当一部分国内图床 / CDN
/// 对非浏览器 UA 直接回 403、防盗链空页或 `text/html`。封面不是播放，换一套
/// 浏览器头没有副作用，命中率明显更高。
pub(super) const IMAGE_BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IMAGE_ACCEPT: &str =
    "image/avif,image/webp,image/apng,image/png,image/svg+xml,image/*,*/*;q=0.8";
/// 单次上游请求上限。`ProxyState::client` 的 20s 是给 m3u8 的；一屏封面动辄
/// 几十上百张，20s 会把整面卡片墙拖到超时，8s 足够区分「慢」与「死」。
const IMAGE_TIMEOUT: Duration = Duration::from_secs(8);
/// 非 `image/*` 响应最多攒这么多字节再嗅探，超过不往内存里读。
const MAX_SNIFF_BYTES: usize = 8 * 1024 * 1024;
/// m3u8 清单的读取上限。正常清单几十 KB；给 8 MB 是防「CDN 错误页 / 重定向到
/// 视频文件」时把整条响应吃进内存（此前这里是 `bytes()`，没有上限）。
const MAX_PLAYLIST_BYTES: usize = 8 * 1024 * 1024;

/// 流式读 body，最多收集 `cap + 1` 字节：多留的 1 字节只用于判断「确实超限」。
///
/// 不能用 `bytes()` 先整条收进内存（上限对内存峰值形同虚设），也不能用
/// `StreamExt::take(n)`——它按 **chunk 个数** 计数，而一个 chunk 可能就是一整条 body。
async fn read_capped(upstream: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let mut out: Vec<u8> = Vec::new();
    let mut stream = upstream.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|err| format!("body read failed: {err}"))?;
        let room = cap + 1 - out.len();
        if bytes.len() >= room {
            out.extend_from_slice(&bytes[..room]);
            break;
        }
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

/// 封面失败的分类。日志与重试策略都只看它：必须把「本机网络 / TLS」和
/// 「上游真不是图片」分开，否则 502 全被当成一个原因，排查时毫无信息量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ImageFailure {
    Timeout,
    Dns,
    Tls,
    Connect,
    /// 上游给了非 2xx。
    Status,
    /// 2xx 但响应体不是图片（空 body / 防盗链 HTML / 播放列表）。
    NotImage,
    Other,
}

impl ImageFailure {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Dns => "dns",
            Self::Tls => "tls",
            Self::Connect => "connect",
            Self::Status => "status",
            Self::NotImage => "not-image",
            Self::Other => "other",
        }
    }

    /// 换浏览器 UA 再试一次是否可能有效。
    ///
    /// `dns` 换 UA 不会改变解析结果；`timeout` 再等 8s 只会让封面墙更慢；
    /// `tls` 走 http 回退（见 `next_image_attempt`），换 UA 没用。
    pub(super) fn retry_with_browser(self) -> bool {
        !matches!(self, Self::Dns | Self::Timeout | Self::Tls)
    }
}

/// 封面的第几次尝试 / 换什么再试。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ImageAttempt {
    /// 第一次：spider / 配置里的头 + TVBox 默认头（`okhttp/3.15`）。
    Source,
    /// 第二次：同 URL，浏览器 UA + `Accept: image/*`（其余头保留）。
    Browser,
    /// 第二次的另一种形态：https 握手失败时降级到 http（仍用浏览器头）。
    HttpFallback,
}

/// 生成某次尝试实际发送的头。
///
/// `Source` 原样使用（默认头由 `netrules::with_defaults` 在调用方补齐）；
/// `Browser` / `HttpFallback` 只覆盖 `User-Agent`、补一个缺失的 `Accept`，
/// 绝不覆盖调用方显式给的 Referer / Cookie —— 防盗链靠的正是它们。
pub(super) fn image_attempt_headers(
    base: &[(String, String)],
    attempt: ImageAttempt,
) -> Vec<(String, String)> {
    let mut out = base.to_vec();
    if attempt == ImageAttempt::Source {
        return out;
    }
    if let Some(slot) = out
        .iter_mut()
        .find(|(name, _)| name.eq_ignore_ascii_case("User-Agent"))
    {
        slot.0 = "User-Agent".into();
        slot.1 = IMAGE_BROWSER_UA.into();
    } else {
        out.push(("User-Agent".into(), IMAGE_BROWSER_UA.into()));
    }
    if !out
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("Accept"))
    {
        out.push(("Accept".into(), IMAGE_ACCEPT.into()));
    }
    out
}

/// 决定第一次失败后是否还有第二次、以及第二次怎么打。
///
/// 只有两种回退，最多两次请求：
/// 1. https + TLS 握手失败 → 降级 http（同一路径，浏览器头）；
/// 2. 其余可重试原因（连接失败 / 非 2xx / 不是图片）→ 同 URL 换浏览器头。
///
/// 明令不做的事：忽略证书校验、关闭 TLS 验证、把 DNS/fake-IP 失败当图片错。
pub(super) fn next_image_attempt(
    target: &Url,
    failure: ImageFailure,
) -> Option<(ImageAttempt, Url)> {
    if failure == ImageFailure::Tls && target.scheme() == "https" {
        let mut fallback = target.clone();
        if fallback.set_scheme("http").is_ok() {
            return Some((ImageAttempt::HttpFallback, fallback));
        }
    }
    if failure.retry_with_browser() {
        return Some((ImageAttempt::Browser, target.clone()));
    }
    None
}

/// 把 reqwest 错误的整条 `source()` 链摊平成一行。
///
/// `reqwest::Error` 的 `Display` 只有 `error sending request for url (...)`，
/// 真正原因（DNS / TLS 证书 / 连接被重置）全在 `source()` 里。只打 Display
/// 等于什么也没说，本任务最初就是被这行日志耽误的。
pub(super) fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts: Vec<String> = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if text.is_empty() || parts.iter().any(|part| part == &text) {
            break;
        }
        parts.push(text);
        source = cause.source();
    }
    parts.join("; ")
}

/// 只按错误文本分类，纯函数，便于单测。
pub(super) fn classify_error_text(text: &str) -> ImageFailure {
    let lower = text.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        return ImageFailure::Timeout;
    }
    if lower.contains("dns error")
        || lower.contains("failed to lookup")
        || lower.contains("failed to resolve")
        || lower.contains("no such host")
        || lower.contains("getaddrinfo")
        || lower.contains("name or service not known")
    {
        return ImageFailure::Dns;
    }
    if lower.contains("certificate")
        || lower.contains("tls")
        || lower.contains("handshake")
        || lower.contains("ssl")
        || lower.contains("unknownissuer")
        || lower.contains("unknown issuer")
        || lower.contains("invalid peer")
    {
        return ImageFailure::Tls;
    }
    if lower.contains("connect")
        || lower.contains("connection refused")
        || lower.contains("connection reset")
        || lower.contains("unreachable")
        || lower.contains("eof")
    {
        return ImageFailure::Connect;
    }
    ImageFailure::Other
}

/// 中间件错误先剥到 `reqwest::Error` 再分类；缓存后端自己的错误（写盘失败
/// 之类）只影响这次缓存，不该被说成「线路连不上」。
fn classify_image_error(err: &reqwest_middleware::Error) -> (ImageFailure, String) {
    match err {
        reqwest_middleware::Error::Reqwest(inner) => {
            (classify_transport_error(inner), error_chain(inner))
        }
        other => (ImageFailure::Other, other.to_string()),
    }
}

/// 分类一次 reqwest 传输错误。
pub(super) fn classify_transport_error(err: &reqwest::Error) -> ImageFailure {
    if err.is_timeout() {
        return ImageFailure::Timeout;
    }
    // 只看 source 链：`Display` 里的 URL 可能恰好含 "dns"/"tls" 之类的词，
    // 拿它分类会误判（比如 `https://dns.example/x.jpg`）。
    let mut text = String::new();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        if !text.is_empty() {
            text.push_str("; ");
        }
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    let kind = classify_error_text(&text);
    // 连接阶段没给出更具体原因时，归为 connect 而不是 other：它对排查仍然
    // 意味着「到上游的 TCP/代理层没走通」。
    if kind == ImageFailure::Other && err.is_connect() {
        return ImageFailure::Connect;
    }
    kind
}

/// 发一次封面请求。`timeout` 是单次上限，不复用 m3u8 的 20s 全局值。
async fn fetch_image_once(
    client: &reqwest_middleware::ClientWithMiddleware,
    target: &Url,
    headers: &[(String, String)],
) -> Result<reqwest::Response, reqwest_middleware::Error> {
    let mut request = client.get(target.clone()).timeout(IMAGE_TIMEOUT);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    request.send().await
}

/// 发一次请求并检查响应：成功直接给出可返回的图片响应，失败给出分类原因。
async fn fetch_image(
    client: &reqwest_middleware::ClientWithMiddleware,
    target: &Url,
    headers: &[(String, String)],
) -> Result<Response, (ImageFailure, String)> {
    let upstream = match fetch_image_once(client, target, headers).await {
        Ok(upstream) => upstream,
        Err(err) => return Err(classify_image_error(&err)),
    };
    image_response(upstream, target).await
}

/// 检查一次上游响应：能当图片回就构造好响应；不能就返回「分类 + 原因」。
async fn image_response(
    upstream: reqwest::Response,
    target: &Url,
) -> Result<Response, (ImageFailure, String)> {
    let status = upstream.status();
    if !status.is_success() {
        return Err((ImageFailure::Status, format!("upstream status {status}")));
    }
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // 上游自己声明了 image/*：直接流式转发（不攒内存）。缓存命中时
    // `http-cache-reqwest` 已经把 body 换成缓存副本，这里不需要知道区别。
    if content_type.to_ascii_lowercase().starts_with("image/") {
        let stream = upstream.bytes_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", content_type)
            .header("cache-control", "public, max-age=604800")
            .header("access-control-allow-origin", "*")
            .header("access-control-expose-headers", "*")
            .header("x-luma-proxy", "image")
            .body(Body::from_stream(stream))
            .map_err(|_| (ImageFailure::Other, "response build failed".into()));
    }

    // 没声明成图片（常见 `application/octet-stream` / `binary/octet-stream`
    // / 空 body 的防盗链页）：读回来按文件头嗅探，认出是图片就补对
    // content-type 再回给 <img>。
    // 按字节上限流式收集（见 `read_capped` 的注释）：读满上限即停，不把整条
    // 响应收进内存。
    let body = read_capped(upstream, MAX_SNIFF_BYTES)
        .await
        .map_err(|err| (ImageFailure::Other, err))?;
    if body.len() > MAX_SNIFF_BYTES {
        return Err((
            ImageFailure::NotImage,
            format!(
                "image too large ({} bytes, type {content_type})",
                body.len()
            ),
        ));
    }
    let Some(kind) = image_format(&body) else {
        return Err((
            ImageFailure::NotImage,
            format!(
                "not an image (status {status}, type {content_type}, {} bytes)",
                body.len()
            ),
        ));
    };
    tracing::debug!(url = %target, sniffed = kind, "poster sniffed from non-image content-type");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", kind)
        .header("cache-control", "public, max-age=604800")
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "*")
        .header("x-luma-proxy", "image")
        .body(Body::from(body))
        .map_err(|_| (ImageFailure::Other, "response build failed".into()))
}

pub(super) async fn handle_health(State(state): State<Arc<ProxyState>>) -> Response {
    let body = format!(r#"{{"ok":true,"port":{}}}"#, state.port());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// 播放器 HUD 的吞吐读数（`/meter`）。
///
/// 前端每秒拉一次：没有 IPC 往返、也没有状态要同步，读不到就当 0 处理即可。
pub(super) async fn handle_meter() -> Response {
    let (bytes_per_sec, bytes_total) = super::speed::meter().sample();
    let body = format!(r#"{{"bytesPerSec":{bytes_per_sec},"bytesTotal":{bytes_total}}}"#);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "no-store")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub(super) async fn handle_options() -> Response {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET,HEAD,OPTIONS")
        .header("access-control-allow-headers", "*")
        .header("access-control-expose-headers", "*")
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::NO_CONTENT.into_response())
}

/** 统一盒装，便于「正常直连」与「先 peek 再回放」两条路径共用同一个变量类型。 */
type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static>>;

/** 在响应发出前读一小段头部；这段失败还能重建请求重试，一旦发出头就收不回来了。 */
async fn peek_media_prefix(
    upstream: reqwest::Response,
    cap: usize,
) -> Result<(Vec<u8>, ByteStream), reqwest::Error> {
    let mut stream = upstream.bytes_stream();
    let mut head = Vec::new();
    while head.len() < cap {
        match stream.next().await {
            Some(Ok(chunk)) => head.extend_from_slice(&chunk),
            Some(Err(err)) => return Err(err),
            None => break,
        }
    }
    Ok((head, Box::pin(stream)))
}

/** 重取响应元数据；`bytes_stream()` 会拿走 Response，所以必须在建流前抓完。 */
fn response_meta(
    upstream: &reqwest::Response,
) -> (StatusCode, String, Vec<(&'static str, String)>) {
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let carried = DOWNSTREAM
        .iter()
        .filter_map(|name| {
            upstream
                .headers()
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|text| (*name, text.to_string()))
        })
        .collect();
    (status, content_type, carried)
}

fn header_safe(reason: &str) -> String {
    reason
        .chars()
        .take(120)
        .map(|ch| {
            if matches!(ch, '\n' | '\r' | '\t') {
                ' '
            } else if ch.is_ascii_graphic() || ch == ' ' {
                ch
            } else {
                '?'
            }
        })
        .collect()
}

/** 清单失败时优先回最近一份成功清单；没有才落原来的 deny。 */
fn stale_or_deny(playlist_key: Option<&str>, reason: &str, status: StatusCode) -> Response {
    if let Some(key) = playlist_key {
        if let Some(rewritten) = playlist_cache::stale(key) {
            tracing::warn!(reason, "serving stale m3u8 after upstream failure");
            return Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/vnd.apple.mpegurl")
                .header("cache-control", "no-store")
                .header("access-control-allow-origin", "*")
                .header("access-control-expose-headers", "*")
                .header("x-luma-proxy", "playlist-stale")
                .header("x-luma-proxy-reason", header_safe(reason))
                .body(Body::from(rewritten))
                .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "stale response build failed"));
        }
    }
    deny(status, reason)
}

pub(super) async fn handle_proxy(
    State(state): State<Arc<ProxyState>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    // TVBox sources hand back `proxy?do=py&type=m3u8&url=…` (sometimes with a
    // duplicated `url`), so parse the raw query and keep the last value.
    let pairs: Vec<(String, String)> = raw
        .as_deref()
        .map(|text| {
            url::form_urlencoded::parse(text.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default();
    let get = |key: &str| {
        pairs
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };

    if let Some(kind) = get("do").filter(|value| !value.is_empty()) {
        return handle_spider_proxy(&kind, &pairs).await;
    }

    // Spider local proxy without a `do=` marker. TVBox spiders built for the
    // FongMi contract emit `proxy?url=&type=m3u8&slug=…` (they append their own
    // params to `getProxyUrl()` and expect the host to hand the whole query map
    // back to `Spider.localProxy`). An empty `url=` is never a valid upstream
    // fetch, so route it to the spider proxy instead of 400-ing on `Url::parse("")`.
    let target_url = get("url").unwrap_or_default();
    if target_url.is_empty() && !pairs.is_empty() {
        return handle_spider_proxy("spider", &pairs).await;
    }

    let query = ProxyQuery {
        url: target_url,
        ua: get("ua"),
        referer: get("referer"),
        cookie: get("cookie"),
        h: get("h"),
    };

    let target = match Url::parse(&query.url) {
        Ok(url) => url,
        Err(err) => return deny(StatusCode::BAD_REQUEST, &format!("invalid url: {err}")),
    };

    if let Err(reason) = check_target(&target, state.allow_local).await {
        return deny(StatusCode::FORBIDDEN, &reason);
    }

    let fwd = Fwd {
        ua: query.ua.clone(),
        referer: query.referer.clone(),
        cookie: query.cookie.clone(),
        extra: query.h.clone(),
    };

    let mut request = state.client.get(target.clone());
    // Config-level host headers (TVBox `headers[]`) come first so an explicit
    // ua/referer/cookie from the spider still wins. Building one list keeps
    // `RequestBuilder::header` from appending a duplicate User-Agent.
    // Config-level host rules come first, explicit ua/referer/cookie win, and
    // defaults fill only the gaps. `netrules` owns all three steps so the
    // resolver (play.rs) and this proxy cannot disagree about the UA; keeping
    // one list also stops `RequestBuilder::header` appending a second UA.
    let mut explicit: Vec<(String, String)> = Vec::with_capacity(3);
    if let Some(ua) = fwd.ua.as_deref() {
        explicit.push(("User-Agent".into(), ua.into()));
    }
    if let Some(referer) = fwd.referer.as_deref() {
        explicit.push(("Referer".into(), referer.into()));
    }
    if let Some(cookie) = fwd.cookie.as_deref() {
        explicit.push(("Cookie".into(), cookie.into()));
    }
    let forwarded = crate::netrules::with_defaults(
        &target,
        crate::netrules::merged_for(target.as_str(), &explicit),
    );
    for (name, value) in forwarded {
        request = request.header(name, value);
    }
    for (name, value) in extra_headers(query.h.as_deref()) {
        request = request.header(name, value);
    }
    for name in PASSTHROUGH {
        if let Some(value) = headers.get(name) {
            if let Ok(text) = value.to_str() {
                request = request.header(name, text);
            }
        }
    }

    let playlist_hint = target.path().to_ascii_lowercase().ends_with(".m3u8");
    let playlist_key = playlist_hint.then(|| playlist_cache::key(&target, state.port(), &fwd));
    // GET 没有 body，try_clone 一定可用；留一份给「响应发出前」的有界重试。
    let mut retry_request = request.try_clone();
    let mut retried = false;

    let upstream = loop {
        match request.send().await {
            Ok(response) => break response,
            Err(err) => {
                let retryable = !retried && !err.is_timeout() && err.is_connect();
                if retryable {
                    if let Some(next) = retry_request.take() {
                        retried = true;
                        tracing::warn!(url = %target, error = %err, "upstream connect failed, retrying once");
                        request = next;
                        continue;
                    }
                }
                let status = if err.is_timeout() {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                };
                let reason = format!("upstream failed: {err}");
                return stale_or_deny(playlist_key.as_deref(), &reason, status);
            }
        }
    };

    let (mut status, content_type, mut carried) = response_meta(&upstream);
    let is_playlist = playlist_hint || content_type.to_ascii_lowercase().contains("mpegurl");

    if is_playlist && !status.is_success() {
        let reason = format!("upstream status {status}");
        return stale_or_deny(playlist_key.as_deref(), &reason, status);
    }

    if is_playlist {
        // Relative segment URIs must be rewritten, otherwise hls.js resolves
        // them against 127.0.0.1:9978 and every segment 404s.
        let body = match read_capped(upstream, MAX_PLAYLIST_BYTES).await {
            Ok(bytes) => bytes,
            Err(err) => {
                let reason = format!("playlist read failed: {err}");
                return stale_or_deny(playlist_key.as_deref(), &reason, StatusCode::BAD_GATEWAY);
            }
        };
        if body.len() > MAX_PLAYLIST_BYTES {
            let reason = format!("playlist too large (>{} bytes)", MAX_PLAYLIST_BYTES);
            return stale_or_deny(playlist_key.as_deref(), &reason, StatusCode::BAD_GATEWAY);
        }
        let text = crate::textio::decode(&body);
        // A 200 with a non-playlist body is the normal shape of a dead source:
        // netdisk resolvers answer `{"code":201,"msg":"解析失败了","url":""}` and
        // some CDNs replace the manifest with an HTML error page. Passing that
        // through makes hls.js raise `manifestParsingError`, which reads like a
        // player bug. Fail as a gateway error instead and log a preview so the
        // real cause is visible in logs/.
        if !looks_like_playlist(&text) {
            let preview = preview_text(&text, 160);
            tracing::warn!(url = %target, preview = %preview, "upstream answered with a non-playlist body");
            let reason = format!("upstream returned a non-playlist body: {preview}");
            return stale_or_deny(playlist_key.as_deref(), &reason, StatusCode::BAD_GATEWAY);
        }
        let rewritten = rewrite_playlist(&text, &target, state.port(), &fwd);
        if let Some(key) = playlist_key.as_deref() {
            playlist_cache::remember(key.to_string(), rewritten.clone());
        }
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/vnd.apple.mpegurl")
            .header("cache-control", "no-store")
            .header("access-control-allow-origin", "*")
            .header("access-control-expose-headers", "*")
            .header("x-luma-proxy", "playlist")
            .body(Body::from(rewritten))
            .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "response build failed"));
    }

    // 伪装分片剥离：先把头部 2KB 读出来看是不是「PNG 头 + TS 负载」。
    // 带 Range 的请求（hls.js 直取字节段）不碰，避免把偏移算错。
    //
    // 注意：`bytes_stream()` 会拿走 `upstream` 的所有权，所以响应头必须在
    // 建流之前抓完。
    let wants_range = headers.contains_key("range");
    const PEEK: usize = 2048;
    let mut head: Vec<u8> = Vec::new();
    let upstream_stream: ByteStream = if wants_range {
        Box::pin(upstream.bytes_stream())
    } else {
        match peek_media_prefix(upstream, PEEK).await {
            Ok((bytes, stream)) => {
                head = bytes;
                stream
            }
            Err(err) => {
                let retryable = !retried && !err.is_timeout() && retry_request.is_some();
                if !retryable {
                    let reason = format!("upstream body failed: {err}");
                    return stale_or_deny(playlist_key.as_deref(), &reason, StatusCode::BAD_GATEWAY);
                }
                let next = retry_request.take().expect("retry_request checked above");
                tracing::warn!(url = %target, error = %err, "upstream body stopped early, retrying once");
                let second = match next.send().await {
                    Ok(response) => response,
                    Err(err2) => {
                        let status2 = if err2.is_timeout() {
                            StatusCode::GATEWAY_TIMEOUT
                        } else {
                            StatusCode::BAD_GATEWAY
                        };
                        let reason = format!("upstream retry failed: {err2}");
                        return stale_or_deny(playlist_key.as_deref(), &reason, status2);
                    }
                };
                let (second_status, _second_content_type, second_carried) = response_meta(&second);
                status = second_status;
                carried = second_carried;
                match peek_media_prefix(second, PEEK).await {
                    Ok((bytes, stream)) => {
                        head = bytes;
                        stream
                    }
                    Err(err2) => {
                        let reason = format!("upstream retry body failed: {err2}");
                        return stale_or_deny(playlist_key.as_deref(), &reason, StatusCode::BAD_GATEWAY);
                    }
                }
            }
        }
    };
    let mut stripped = false;
    if !wants_range {
        if let Some(offset) = disguised_ts_offset(&head) {
            tracing::info!(
                url = %target,
                offset,
                peeked = head.len(),
                "stripped disguised prefix from media segment"
            );
            head.drain(..offset);
            stripped = true;
        }
    }

    let mut builder = Response::builder().status(status);
    for (name, value) in carried {
        // 剥离后长度/字节段全变了，这些头必须丢弃（cache 的 etag 也不再可信）。
        if stripped
            && matches!(
                name,
                "content-length" | "content-range" | "accept-ranges" | "etag"
            )
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    if stripped {
        builder = builder.header("content-type", "video/mp2t");
    }

    // 回放已读头部，再接上游剩余流；`head` 为空时等价于原样透传。
    let body_stream = stream::once(async move { Ok::<Bytes, reqwest::Error>(Bytes::from(head)) })
        .chain(upstream_stream)
        // 只有这里知道「从源站真正下了多少字节」：hls.js 读的是 127.0.0.1，它自己
        // 量到的是回环速度。头部也计入，否则分片被重写前缀时读数会偏小。
        .map(|chunk| {
            if let Ok(ref bytes) = chunk {
                super::speed::meter().add(bytes.len());
            }
            chunk
        });
    builder
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "*")
        .header("x-luma-proxy", "1")
        .body(Body::from_stream(body_stream))
        .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "response build failed"))
}

/// 网盘 CDN 的防盗链伪装：分片本体前挂一个 1×1 PNG，真实数据从 IEND 之后开始。
///
/// 2026-11-14 实测 py_bubuzhuiju 的 PAN1 / NBY 线路：分片是 112 字节 PNG 头
/// （`IHDR` 1×1、`IEND` 在 offset 112）+ 完整 MPEG-TS（offset 120 起是 0x47
/// 同步字节）。Fongmi 用 ExoPlayer，它的 `TsExtractor` 会扫描同步字节自动跳过
/// 垃圾前缀；hls.js 不会跳，从第 0 字节按 TS 解析必然 `fragParsingError`。
/// 这里在反代层把前缀剥掉，让 webview 侧看到干净的 TS。
///
/// 只认「PNG 签名 + IEND 在前 1KB + 其后连续三个 0x47」这一种形态，真图片
/// （海报）不会误判：它们的 IEND 在文件尾部，且后面没有 TS 同步字节。
pub(super) fn disguised_ts_offset(buffer: &[u8]) -> Option<usize> {
    const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const TS_PACKET: usize = 188;
    if buffer.len() < 256 || !buffer.starts_with(&PNG_MAGIC) {
        return None;
    }
    let iend = buffer.windows(4).position(|w| w == b"IEND")?;
    // IEND 数据段结构：4 字节长度 + "IEND" + 4 字节 CRC。
    let start = iend + 8;
    if start + 3 * TS_PACKET > buffer.len() {
        return None;
    }
    (start..=buffer.len() - 3 * TS_PACKET).find(|&offset| {
        buffer[offset] == 0x47
            && buffer[offset + TS_PACKET] == 0x47
            && buffer[offset + 2 * TS_PACKET] == 0x47
    })
}

/// Decode a percent-encoded fragment (TVBox embeds URL-encoded header values,
/// e.g. `User-Agent=Mozilla/5.0%20(...)`). Hand-rolled to avoid pulling in a
/// `%XX` -> byte, `+` stays literal (header values, not form
/// data), then UTF-8 decode. Invalid UTF-8 falls back to the raw input rather
/// than rejecting the header. 唯一实现在 `infra::pct`。
pub(super) fn percent_decode(input: &str) -> String {
    crate::pct::percent_decode(input)
}

/// Parse a TVBox `vod_pic` that may carry inline request headers.
///
/// Community sources (e.g. Douban) append `@Referer=...`, `@User-Agent=...`,
/// `@Cookie=...` or a URL-encoded `@Headers={json}` to the real image URL so
/// the host can bypass hotlink protection. This mirrors the native host's
/// `ImgUtil.getUrl` (FongMi) / `VodImages.parseVodPicUrl` (AVBox): the image
/// layer strips the suffix and injects the headers into the request. WebView2
/// `<img>` cannot set custom headers, so our local `/image` proxy plays the
/// role of that native interceptor.
///
/// Returns `None` for `data:` URIs and URLs without an inline header, meaning
/// "no parsing needed" — the caller falls back to a plain upstream fetch.
/// Header names go through `fix_header` aliases (`ua`/`referer`/`cookie`).
pub(crate) fn parse_vod_pic_url(raw: &str) -> Option<(String, Vec<(String, String)>)> {
    if raw.starts_with("data:") || !raw.contains('@') {
        return None;
    }
    // Values are taken up to the next '@' (the separator has no escaping in
    // the TVBox convention). '=' is safe inside a value.
    let grab = |key: &str| -> Option<String> {
        let needle = format!("@{key}=");
        raw.split(&needle)
            .nth(1)
            .map(|rest| rest.split('@').next().unwrap_or("").to_string())
    };
    let url = raw.split('@').next().unwrap_or("").to_string();
    if url.is_empty() {
        return None;
    }
    let fix_header = |key: &str| -> String {
        match key.to_ascii_lowercase().as_str() {
            "user-agent" | "ua" => "User-Agent".into(),
            "referer" | "referrer" => "Referer".into(),
            "cookie" => "Cookie".into(),
            _ => key.to_string(),
        }
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    // @Headers is a percent-encoded JSON object; expand it first so explicit
    // @Referer/@User-Agent below can still override individual keys.
    if let Some(json) = grab("Headers") {
        if let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
            &percent_decode(&json),
        ) {
            for (key, value) in map {
                if let Some(text) = value.as_str().filter(|v| !v.is_empty()) {
                    headers.push((fix_header(&key), text.to_string()));
                }
            }
        }
    }
    // Canonical header -> accepted inline aliases. Native `fixHeader` maps
    // `ua` -> User-Agent etc.; sources in the wild use both spellings.
    for (canonical, aliases) in [
        ("Cookie", &["Cookie", "cookie"][..]),
        ("User-Agent", &["User-Agent", "ua", "user-agent"][..]),
        ("Referer", &["Referer", "referer", "referrer"][..]),
    ] {
        let value = aliases
            .iter()
            .find_map(|key| grab(key))
            .map(|v| percent_decode(&v))
            .filter(|v| !v.is_empty());
        if let Some(value) = value {
            // Replace an existing (case-normalized) key from @Headers.
            let normalized = fix_header(canonical);
            headers.retain(|(name, _)| name != &normalized);
            headers.push((normalized, value));
        }
    }
    Some((url, headers))
}

/// Image proxy: the WebView2 equivalent of the native image interceptor.
///
/// The browser sends the original `vod_pic` (with TVBox `@header` suffix) as
/// `?url=`; we parse the inline headers, validate the pure URL against the
/// same whitelist as `/proxy`, inject headers (inline > config `headers[]` >
/// defaults), then stream the image back with a long cache lifetime.
///
/// Failures get exactly one more chance:
/// - https TLS handshake failure → same path over http (browser headers);
/// - connection failure / non-2xx / 2xx-but-not-an-image → same URL with a
///   browser UA + `Accept: image/*`. Many image hosts answer the TVBox
///   `okhttp/3.15` UA with 403 or a hotlink page.
///
/// DNS failures (e.g. the host resolves to a Clash fake-IP that cannot be
/// dialed) and timeouts are not retried: the retry cannot change the outcome
/// and would only double the stall. We never disable certificate verification
/// to "fix" a site.
pub(super) async fn handle_image(
    State(state): State<Arc<ProxyState>>,
    RawQuery(raw): RawQuery,
) -> Response {
    let pairs: Vec<(String, String)> = raw
        .as_deref()
        .map(|text| {
            url::form_urlencoded::parse(text.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default();
    let pic = pairs
        .iter()
        .rev()
        .find(|(name, _)| name == "url")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();

    let (pure, inline) = match parse_vod_pic_url(&pic) {
        Some((url, headers)) => (url, headers),
        None => (pic.clone(), Vec::new()),
    };
    let target = match Url::parse(&pure) {
        Ok(url) => url,
        Err(err) => return deny(StatusCode::BAD_REQUEST, &format!("invalid url: {err}")),
    };
    if let Err(reason) = check_target(&target, state.allow_local).await {
        return deny(StatusCode::FORBIDDEN, &reason);
    }

    // Inline headers win over the config-level host table; defaults fill gaps.
    let base = crate::netrules::with_defaults(
        &target,
        crate::netrules::merged_for(target.as_str(), &inline),
    );
    let host = target.host_str().unwrap_or("");

    // 最多两次请求。第一次用源给的头；失败后由 `next_image_attempt` 决定
    // 第二次是「换浏览器头」还是「https 降 http」，这里不堆分支。
    let mut request_url = target.clone();
    let mut headers = image_attempt_headers(&base, ImageAttempt::Source);
    let mut first_failure: Option<(ImageFailure, String)> = None;
    let mut failure: Option<(ImageFailure, String)> = None;

    for round in 0..2 {
        match fetch_image(&state.image_client, &request_url, &headers).await {
            Ok(response) => return response,
            Err((kind, reason)) => {
                if round == 0 {
                    first_failure = Some((kind, reason.clone()));
                }
                tracing::debug!(
                    host,
                    url = %request_url,
                    kind = kind.as_str(),
                    reason,
                    "poster attempt failed"
                );
                let next = if round == 0 {
                    next_image_attempt(&target, kind)
                } else {
                    None
                };
                match next {
                    Some((attempt, url)) => {
                        tracing::debug!(
                            host,
                            url = %url,
                            attempt = ?attempt,
                            "poster retrying"
                        );
                        request_url = url;
                        headers = image_attempt_headers(&base, attempt);
                    }
                    None => {
                        failure = Some((kind, reason));
                        break;
                    }
                }
            }
        }
    }

    let (kind, reason) = failure.unwrap_or((ImageFailure::Other, "no attempt".to_string()));
    // 第二次打了别的地址（http 回退）时，把原始 URL 一并留在日志里。
    let reason = if request_url == target {
        reason
    } else {
        format!("{reason} (from {target})")
    };
    let first_kind = first_failure
        .as_ref()
        .map(|(first_kind, _)| *first_kind)
        .filter(|first_kind| *first_kind != kind);
    log_image_failure(&target, kind, &reason, first_kind);
    let status = if kind == ImageFailure::Timeout {
        StatusCode::GATEWAY_TIMEOUT
    } else {
        StatusCode::BAD_GATEWAY
    };
    let body = match &first_failure {
        // 只保留最终那次的话，tls 这种「第一次真因」会从响应体里消失。
        Some((first_kind, first_reason)) if *first_kind != kind => {
            format!(
                "{}: {reason} [{}: {first_reason}]",
                kind.as_str(),
                first_kind.as_str()
            )
        }
        _ => format!("{}: {reason}", kind.as_str()),
    };
    deny(status, &body)
}

/// TVBox local proxy for spider-owned resources (`/proxy?do=py|jar|js`).
///
/// Sources that implement `Spider.proxy(Map)` return URLs pointing at this
/// route; the query map is handed to the spider and its
/// `[contentType, headers, bytes]` answer becomes the HTTP response.
pub(super) async fn handle_spider_proxy(kind: &str, pairs: &[(String, String)]) -> Response {
    // 优先用代理 URL 自带的 `site=<key>` 精确命中产生本次会话的爬虫；不带 site
    // 的老 URL / 直播退回「最近一次点播」。多站并发下这才不会错配到别的源。
    let site_key = pairs
        .iter()
        .rev()
        .find(|(name, _)| name == "site")
        .map(|(_, value)| value.clone());
    let site = site_key
        .as_deref()
        .and_then(crate::spider::play_site_by_key)
        .or_else(crate::spider::last_play_site)
        .or_else(|| {
            // 兜底：从注册表里按 site_key 再取一次（site_key 有但注册表刚被并发覆盖时）。
            site_key.as_deref().and_then(crate::spider::play_site_by_key)
        });
    let Some(site) = site else {
        return deny(
            StatusCode::SERVICE_UNAVAILABLE,
            "no active play source; open a title before using the spider proxy",
        );
    };
    // 往爬虫返回的清单里传播 site，使后续分片回调也带对源（site_key 缺则从站点取）。
    let propagate_key = site_key.or_else(|| {
        site.get("key")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    });

    let mut params: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (name, value) in pairs {
        params.insert(name.clone(), value.clone());
    }
    let timeout = std::time::Duration::from_millis(
        params
            .get("timeoutMs")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(20_000)
            .clamp(3_000, 60_000),
    );

    match crate::spider::proxy_call(&site, params, timeout).await {
        Ok(payload) => {
            let mut builder = Response::builder().status(StatusCode::OK);
            for (name, value) in payload.headers.iter() {
                // Framing headers from the spider would corrupt our response.
                if matches!(
                    name.to_ascii_lowercase().as_str(),
                    "content-length"
                        | "transfer-encoding"
                        | "connection"
                        | "content-encoding"
                        | "content-type"
                ) {
                    continue;
                }
                builder = builder.header(name, value);
            }
            // Spiders frequently return application/octet-stream even for
            // playlists; hls.js sniffs the body, but a correct type keeps
            // browsers/proxies from treating it as a download.
            let mut content_type = payload.content_type.clone();
            let trimmed = payload.body.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(&payload.body);
            let is_playlist = trimmed.starts_with(b"#EXTM3U");
            if content_type.is_empty() || content_type == "application/octet-stream" {
                if is_playlist {
                    content_type = "application/vnd.apple.mpegurl".to_string();
                }
            }
            // 把 site 传播进爬虫清单里的本地代理 URL（分片/密钥回调也带对源），
            // 只对 playlist、且该 URL 尚不含 site= 时追加。
            let body = match (&propagate_key, is_playlist) {
                (Some(key), true) => {
                    let text = String::from_utf8_lossy(&payload.body).into_owned();
                    Body::from(propagate_site_to_playlist(&text, key).into_bytes())
                }
                _ => Body::from(payload.body),
            };
            builder
                .header("content-type", content_type)
                .header("cache-control", "no-store")
                .header("access-control-allow-origin", "*")
                .header("access-control-expose-headers", "*")
                .header("x-luma-proxy", format!("spider-{kind}"))
                .body(body)
                .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "proxy response build failed"))
        }
        Err(err) => deny(
            StatusCode::BAD_GATEWAY,
            &format!("spider proxy failed: {} {}", err.code, err.message),
        ),
    }
}

/// 把 `site=<key>` 追加进爬虫清单里的本地代理 URL（分片/密钥回调也带对源）。
/// 只处理 `http://127.0.0.1/...` 且含 `/proxy?` 又不含 `site=` 的 URL token；
/// token 以 `"`、空白、换行为界，故裸 URL 行与 `URI="…"` 内都能正确插入。
pub(super) fn propagate_site_to_playlist(text: &str, key: &str) -> String {
    let suffix = format!("&site={}", super::urlencode(key));
    let mut out = String::with_capacity(text.len() + 64);
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if text[i..].starts_with("http://127.0.0.1") || text[i..].starts_with("http://localhost") {
            let start = i;
            let mut j = i;
            while j < bytes.len() && !matches!(bytes[j], b'"' | b' ' | b'\n' | b'\r' | b'\t') {
                j += 1;
            }
            let url = &text[start..j];
            out.push_str(url);
            if url.contains("/proxy?") && !url.contains("site=") {
                out.push_str(&suffix);
            }
            i = j;
        } else {
            let ch = text[i..].chars().next().unwrap_or('\u{0}');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

pub(super) fn extra_headers(payload: Option<&str>) -> Vec<(HeaderName, String)> {
    let Some(payload) = payload else {
        return Vec::new();
    };
    let Ok(decoded) = base64_decode(payload) else {
        return Vec::new();
    };
    let Ok(map) = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&decoded)
    else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(key, value)| {
            let text = value.as_str()?.to_string();
            let name = HeaderName::from_bytes(key.as_bytes()).ok()?;
            Some((name, text))
        })
        .collect()
}

pub(crate) fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u8;
    let mut seen_pad = false;
    for byte in input.bytes() {
        if byte == b'=' {
            seen_pad = true;
            continue;
        }
        if byte.is_ascii_whitespace() {
            continue;
        }
        if seen_pad {
            return Err(());
        }
        let index = TABLE.iter().position(|c| *c == byte).ok_or(())? as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[test]
    fn header_safe_replaces_controls_and_caps_length() {
        assert_eq!(header_safe("boom\nnext"), "boom next");
        assert_eq!(header_safe(&"x".repeat(200)).len(), 120);
    }

    #[tokio::test]
    async fn stale_or_deny_serves_last_good_playlist() {
        let target = Url::parse("https://cdn.example/live/stale-test.m3u8").unwrap();
        let key = playlist_cache::key(&target, 9978, &Fwd::default());
        playlist_cache::remember(key.clone(), "#EXTM3U\nseg.ts\n".to_string());

        let response = stale_or_deny(Some(&key), "upstream 503", StatusCode::BAD_GATEWAY);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-luma-proxy"], "playlist-stale");
        assert_eq!(response.headers()["x-luma-proxy-reason"], "upstream 503");
        let body = to_bytes(response.into_body(), 1024).await.expect("body");
        assert_eq!(&body[..], b"#EXTM3U\nseg.ts\n");
    }

    #[tokio::test]
    async fn stale_or_deny_without_cache_keeps_the_error() {
        let response = stale_or_deny(None, "upstream failed", StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    }
}
