use super::*;

pub(super) async fn handle_health(State(state): State<Arc<ProxyState>>) -> Response {
    let body = format!(r#"{{"ok":true,"port":{}}}"#, state.port());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
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

    let query = ProxyQuery {
        url: get("url").unwrap_or_default(),
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

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            let status = if err.is_timeout() {
                StatusCode::GATEWAY_TIMEOUT
            } else {
                StatusCode::BAD_GATEWAY
            };
            return deny(status, &format!("upstream failed: {err}"));
        }
    };

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let is_playlist = target.path().to_ascii_lowercase().ends_with(".m3u8")
        || content_type.to_ascii_lowercase().contains("mpegurl");

    if is_playlist && status.is_success() {
        // Relative segment URIs must be rewritten, otherwise hls.js resolves
        // them against 127.0.0.1:9978 and every segment 404s.
        let body = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => return deny(StatusCode::BAD_GATEWAY, &format!("playlist read failed: {err}")),
        };
        let text = String::from_utf8_lossy(&body);
        // A 200 with a non-playlist body is the normal shape of a dead source:
        // netdisk resolvers answer `{"code":201,"msg":"解析失败了","url":""}` and
        // some CDNs replace the manifest with an HTML error page. Passing that
        // through makes hls.js raise `manifestParsingError`, which reads like a
        // player bug. Fail as a gateway error instead and log a preview so the
        // real cause is visible in logs/.
        if !looks_like_playlist(&text) {
            let preview = preview_text(&text, 160);
            tracing::warn!(url = %target, preview = %preview, "upstream answered with a non-playlist body");
            return deny(
                StatusCode::BAD_GATEWAY,
                &format!("upstream returned a non-playlist body: {preview}"),
            );
        }
        let rewritten = rewrite_playlist(&text, &target, state.port(), &fwd);
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/vnd.apple.mpegurl")
            .header("cache-control", "no-store")
            .header("access-control-allow-origin", "*")
            .header("access-control-expose-headers", "*")
            .header("x-tvbox-proxy", "playlist")
            .body(Body::from(rewritten))
            .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "response build failed"));
    }

    // 伪装分片剥离：先把头部 2KB 读出来看是不是「PNG 头 + TS 负载」。
    // 带 Range 的请求（hls.js 直取字节段）不碰，避免把偏移算错。
    //
    // 注意：`bytes_stream()` 会拿走 `upstream` 的所有权，所以响应头必须在
    // 建流之前抓完。
    let carried: Vec<(&'static str, String)> = DOWNSTREAM
        .iter()
        .filter_map(|name| {
            upstream
                .headers()
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|text| (*name, text.to_string()))
        })
        .collect();
    let wants_range = headers.contains_key("range");
    let mut upstream_stream = upstream.bytes_stream();
    let mut head: Vec<u8> = Vec::new();
    let mut stripped = false;
    if !wants_range {
        const PEEK: usize = 2048;
        while head.len() < PEEK {
            match upstream_stream.next().await {
                Some(Ok(chunk)) => head.extend_from_slice(&chunk),
                Some(Err(err)) => {
                    return deny(StatusCode::BAD_GATEWAY, &format!("upstream body failed: {err}"))
                }
                None => break,
            }
        }
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
        if stripped && matches!(name, "content-length" | "content-range" | "accept-ranges" | "etag")
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
        .chain(upstream_stream);
    builder
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "*")
        .header("x-tvbox-proxy", "1")
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
/// new dependency: `%XX` -> byte, `+` stays literal (header values, not form
/// data), then UTF-8 decode. Invalid UTF-8 falls back to the raw input rather
/// than rejecting the header.
pub(super) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
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
        if let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&percent_decode(&json)) {
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
pub(super) async fn handle_image(
    State(state): State<Arc<ProxyState>>,
    RawQuery(raw): RawQuery,
) -> Response {
    let pairs: Vec<(String, String)> = raw
        .as_deref()
        .map(|text| url::form_urlencoded::parse(text.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let pic = pairs.iter().rev().find(|(name, _)| name == "url").map(|(_, v)| v.clone()).unwrap_or_default();

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
    let forwarded = crate::netrules::with_defaults(
        &target,
        crate::netrules::merged_for(target.as_str(), &inline),
    );
    let mut request = state.client.get(target.clone());
    for (name, value) in forwarded {
        request = request.header(name, value);
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            let status = if err.is_timeout() { StatusCode::GATEWAY_TIMEOUT } else { StatusCode::BAD_GATEWAY };
            return deny(status, &format!("upstream failed: {err}"));
        }
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    // Only serve real images; refuse to turn the proxy into a generic file
    // fetcher (and stop a mislabeled playlist/script from reaching <img>).
    if !status.is_success() || !content_type.to_ascii_lowercase().starts_with("image/") {
        return deny(StatusCode::BAD_GATEWAY, &format!("not an image (status {status}, type {content_type})"));
    }

    let stream = upstream.bytes_stream();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .header("cache-control", "public, max-age=604800")
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "*")
        .header("x-tvbox-proxy", "image")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "response build failed"))
}

/// TVBox local proxy for spider-owned resources (`/proxy?do=py|jar|js`).
///
/// Sources that implement `Spider.proxy(Map)` return URLs pointing at this
/// route; the query map is handed to the spider and its
/// `[contentType, headers, bytes]` answer becomes the HTTP response.
pub(super) async fn handle_spider_proxy(kind: &str, pairs: &[(String, String)]) -> Response {
    let Some(site) = crate::spider::last_play_site() else {
        return deny(
            StatusCode::SERVICE_UNAVAILABLE,
            "no active play source; open a title before using the spider proxy",
        );
    };

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
            if content_type.is_empty() || content_type == "application/octet-stream" {
                if payload.body.starts_with(b"#EXTM3U") {
                    content_type = "application/vnd.apple.mpegurl".to_string();
                }
            }
            builder
                .header("content-type", content_type)
                .header("cache-control", "no-store")
                .header("access-control-allow-origin", "*")
                .header("access-control-expose-headers", "*")
                .header("x-tvbox-proxy", format!("spider-{kind}"))
                .body(Body::from(payload.body))
                .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "proxy response build failed"))
        }
        Err(err) => deny(
            StatusCode::BAD_GATEWAY,
            &format!("spider proxy failed: {} {}", err.code, err.message),
        ),
    }
}

pub(super) fn extra_headers(payload: Option<&str>) -> Vec<(HeaderName, String)> {
    let Some(payload) = payload else { return Vec::new() };
    let Ok(decoded) = base64_decode(payload) else { return Vec::new() };
    let Ok(map) = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&decoded) else {
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
