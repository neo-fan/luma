use super::*;

/// 封面缓存的可量化证据：同一个 URL 打两次，上游只被请求一次。
/// 第二次命中 `http-cache-reqwest` 的磁盘缓存（cacache），不再回源。
#[tokio::test]
async fn image_cache_serves_repeat_requests_without_hitting_upstream() {
    use std::sync::atomic::AtomicUsize;

    static HITS: AtomicUsize = AtomicUsize::new(0);

    async fn poster() -> impl IntoResponse {
        HITS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        (
            [
                ("content-type", "image/png"),
                ("cache-control", "public, max-age=604800"),
            ],
            vec![0x89u8, b'P', b'N', b'G', 1, 2, 3],
        )
    }

    let app = Router::new().route("/poster.png", get(poster));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let dir = std::env::temp_dir().join(format!("luma-image-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let client = ProxyState::image_client_in(&dir);
    let url = format!("http://{addr}/poster.png");

    let first = client.get(&url).send().await.expect("first");
    assert!(first.status().is_success());
    assert_eq!(&first.bytes().await.expect("body")[..4], b"\x89PNG");

    let second = client.get(&url).send().await.expect("second");
    assert!(second.status().is_success());
    assert_eq!(&second.bytes().await.expect("body")[..4], b"\x89PNG");

    assert_eq!(
        HITS.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "second request must be a cache hit, not another upstream fetch"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn urlencode_keeps_unreserved_only() {
    assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
    assert_eq!(
        urlencode("http://a b/?x=1&y=2"),
        "http%3A%2F%2Fa%20b%2F%3Fx%3D1%26y%3D2"
    );
}

#[test]
fn parse_vod_pic_plain_and_data_are_not_parsed() {
    assert!(parse_vod_pic_url("https://img/x.jpg").is_none());
    assert!(parse_vod_pic_url("").is_none());
    assert!(parse_vod_pic_url("data:image/png;base64,AAAA").is_none());
    assert!(parse_vod_pic_url("@Referer=http://x").is_none()); // empty url
}

#[test]
fn parse_vod_pic_douban_inline_headers() {
    // The exact shape produced by douban.py PIC_SUFFIX, incl. %20 in UA.
    let raw = "https://img3.doubanio.com/p.jpg@Referer=https://api.douban.com/@User-Agent=Mozilla/5.0%20(Windows%20NT%2010.0)";
    let (url, headers) = parse_vod_pic_url(raw).expect("inline header");
    assert_eq!(url, "https://img3.doubanio.com/p.jpg");
    assert_eq!(headers.len(), 2);
    assert!(headers
        .iter()
        .any(|(k, v)| k == "Referer" && v == "https://api.douban.com/"));
    assert!(headers
        .iter()
        .any(|(k, v)| k == "User-Agent" && v == "Mozilla/5.0 (Windows NT 10.0)"));
}

#[test]
fn parse_vod_pic_cookie_and_header_aliases() {
    let raw = "https://cdn/x.png@ua=okhttp%2F3.15@referer=https%3A%2F%2Fh%2F@Cookie=a%3D1%3Bb%3D2";
    let (url, headers) = parse_vod_pic_url(raw).expect("aliases");
    assert_eq!(url, "https://cdn/x.png");
    assert!(headers
        .iter()
        .any(|(k, v)| k == "User-Agent" && v == "okhttp/3.15"));
    assert!(headers
        .iter()
        .any(|(k, v)| k == "Referer" && v == "https://h/"));
    assert!(headers.iter().any(|(k, v)| k == "Cookie" && v == "a=1;b=2"));
}

#[test]
fn parse_vod_pic_headers_json_and_explicit_override() {
    // @Headers is URL-encoded JSON; an explicit @Referer must override it.
    let raw = "https://cdn/x.webp@Headers=%7B%22Referer%22%3A%22https%3A%2F%2Fjson%2F%22%2C%22X-Token%22%3A%22abc%22%7D@Referer=https%3A%2F%2Fexplicit%2F";
    let (url, headers) = parse_vod_pic_url(raw).expect("headers json");
    assert_eq!(url, "https://cdn/x.webp");
    let get = |k: &str| {
        headers
            .iter()
            .find(|(name, _)| name == k)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(get("Referer"), Some("https://explicit/")); // explicit wins, single entry
    assert_eq!(get("X-Token"), Some("abc"));
    assert_eq!(
        headers.iter().filter(|(name, _)| name == "Referer").count(),
        1
    );
}

#[test]
fn percent_decode_handles_invalid_utf8_gracefully() {
    assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
    assert_eq!(percent_decode("plain"), "plain");
    assert_eq!(percent_decode("%FF%FE"), "%FF%FE"); // invalid UTF-8 -> raw
}

#[test]
fn proxy_url_includes_optional_headers() {
    let url = build_proxy_url(
        9978,
        "http://cdn/x.m3u8",
        Some("okhttp/3.15"),
        Some("http://ref/"),
        None,
    );
    assert!(url.starts_with("http://127.0.0.1:9978/proxy?url=http%3A%2F%2Fcdn%2Fx.m3u8"));
    assert!(url.contains("ua=okhttp%2F3.15"));
    assert!(url.contains("referer=http%3A%2F%2Fref%2F"));
    assert!(!url.contains("cookie="));
}

#[test]
fn blocked_ranges_cover_private_and_loopback() {
    for ip in [
        "127.0.0.1",
        "10.1.2.3",
        "192.168.1.1",
        "169.254.1.1",
        "::1",
        "fd00::1",
    ] {
        assert!(is_blocked(ip.parse().unwrap()), "{ip} should be blocked");
    }
    for ip in ["8.8.8.8", "1.1.1.1"] {
        assert!(!is_blocked(ip.parse().unwrap()), "{ip} should be allowed");
    }
}

/// SSRF 回归：过审的初始 URL 用 302 把宿主打向 loopback（dev 的 CDP 9222
/// 或本机任意 HTTP 服务）时，重定向每一跳必须被 `redirect_guard` 拦死，
/// 绝不让 127.0.0.1 的响应体回流到播放器/网页。
///
/// 「合法初跳」用 Windows 非本机地址绑定（8.8.8.8:port）伪造：本机栈直接
/// 终结连接，reqwest 把它当公网 IP 字面量放行，随后 302 指向 127.0.0.1
/// 触发守卫。绑定失败的机器（路由严格 / 非 Windows）直接跳过。
#[tokio::test]
async fn redirect_to_loopback_is_refused_not_followed() {
    let flippy = match std::net::TcpListener::bind(("8.8.8.8", 0)) {
        Ok(listener) => listener,
        Err(_) => {
            eprintln!("[skip] cannot bind non-local address on this machine");
            return;
        }
    };
    let flippy_port = flippy.local_addr().expect("addr").port();
    let victim = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loop");
    let victim_port = victim.local_addr().expect("victim addr").port();
    let secret = "SSRF-PAYLOAD-MUST-NOT-FLOW-BACK";

    {
        let secret = secret.to_string();
        std::thread::spawn(move || {
            for stream in flippy.incoming().take(4) {
                let Ok(mut stream) = stream else { continue };
                use std::io::Read;
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    victim_port
                );
                let _ = std::io::Write::write_all(&mut stream, body.as_bytes());
                let _ = secret;
            }
        });
    }
    {
        let secret = secret.to_string();
        tauri::async_runtime::spawn(async move {
            for _ in 0..4 {
                let Ok((mut sock, _)) = victim.accept().await else {
                    break;
                };
                use tokio::io::AsyncWriteExt;
                let _ = sock
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            secret.len(),
                            secret
                        )
                        .as_bytes(),
                    )
                    .await;
            }
        });
    }

    // 与生产客户端同一构造路径（ClientCache::new → redirect_guard(false)）。
    let state = ProxyState {
        port: AtomicU16::new(0),
        allow_local: false,
        client: streaming_builder(false).build().expect("streaming client"),
        image_client: std::sync::Arc::new(wrap_image(
            reqwest::Client::builder()
                .redirect(guard::redirect_guard(false))
                .dns_resolver(guard::pinned_resolver())
                .build()
                .expect("image client"),
            &std::env::temp_dir().join("luma-ssrf-test-unused"),
        )),
    };
    let jump = Url::parse(&format!("http://8.8.8.8:{flippy_port}/jump")).expect("parse");
    // 初跳 IP 字面量 8.8.8.8 合法（is_blocked=false），守卫必须只在「跳转」处生效。
    check_target(&jump, false)
        .await
        .expect("initial hop allowed");
    let result = state
        .client
        .get(jump.clone())
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match result {
        Err(err) => {
            let text = err.to_string();
            assert!(
                text.contains("redirect refused")
                    || text.contains("not allowed")
                    || text.contains("blocked"),
                "expected redirect guard error, got: {text}"
            );
        }
        Ok(response) => {
            let body = response.bytes().await.expect("bytes");
            panic!(
                "redirect to loopback must fail the request, got: {}",
                String::from_utf8_lossy(&body)
            );
        }
    }
}

/// `check_target` 通过后必须把已校验 IP 登记进钉住表，
/// `client_for` 据此构建「解析-建连同址」客户端；IP 轮换 → 新 key → 新客户端。
#[test]
fn validated_registry_roundtrip_and_expiry() {
    let host = "pin.roundtrip.example";
    let ips = vec!["93.184.216.34".parse().unwrap()];
    pin(host, &ips, PIN_TTL);
    let got = pinned(host).expect("fresh pin");
    assert_eq!(&*got.ips, ips.as_slice());
    pin(host, &ips, Duration::ZERO);
    assert!(pinned(host).is_none(), "expired pin must drop");
}

#[test]
fn playlist_rewrites_relative_segments_and_key_uris() {
    let base = Url::parse("https://cdn.example/x/playlist.m3u8").unwrap();
    let fwd = Fwd {
        ua: Some("okhttp/3.15".into()),
        referer: Some("https://ref.example/".into()),
        cookie: None,
        extra: None,
    };
    let source = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:2,\nseg0.ts\n#EXTINF:2,\nhttps://other.example/seg1.ts\n";
    let out = rewrite_playlist(source, &base, 9978, &fwd);
    assert!(
        out.contains("http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fcdn.example%2Fx%2Fseg0.ts"),
        "{out}"
    );
    assert!(
        out.contains(
            "URI=\"http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fcdn.example%2Fx%2Fkey.bin"
        ),
        "{out}"
    );
    assert!(
        out.contains("url=https%3A%2F%2Fother.example%2Fseg1.ts"),
        "{out}"
    );
    assert!(out.contains("ua=okhttp%2F3.15"), "{out}");
    assert!(out.contains("#EXTM3U"), "{out}");
}

#[test]
fn base64_roundtrip_for_extra_headers() {
    let payload = "eyJYLVN0dWIiOiIxIn0=";
    let decoded = base64_decode(payload).expect("decode");
    assert_eq!(String::from_utf8(decoded).unwrap(), r#"{"X-Stub":"1"}"#);
}

#[test]
fn looks_like_playlist_accepts_bom_and_blank_leading_lines() {
    assert!(looks_like_playlist("#EXTM3U\n#EXTINF:4,\nseg.ts\n"));
    assert!(looks_like_playlist("\u{feff}#EXTM3U\nseg.ts\n"));
    assert!(looks_like_playlist("\n\n  #EXTM3U\r\nseg.ts\r\n"));
}

#[test]
fn looks_like_playlist_rejects_dead_source_payloads() {
    // Netdisk resolver answering 200 while its token no longer works.
    assert!(!looks_like_playlist(
        r#"{"code":201,"msg":"解析失败了","url":""}"#
    ));
    assert!(!looks_like_playlist("<html><body>404</body></html>"));
    assert!(!looks_like_playlist(""));
    assert!(!looks_like_playlist("#EXTINF:4,\nseg.ts\n"));
}

#[test]
fn preview_text_flattens_control_chars_and_truncates() {
    let text = "{\"code\":201,\n\"msg\":\"解析失败了\"}";
    let preview = preview_text(text, 12);
    assert!(!preview.contains('\n'), "{preview}");
    assert!(preview.chars().count() <= 12, "{preview}");
}

/// 造一段「1×1 PNG 头 + n 个 TS 包」的伪装分片（PAN1/NBY 线路的真实形态）。
fn disguised_segment() -> Vec<u8> {
    let mut png: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend_from_slice(&[0, 0, 0, 13]); // IHDR 长度
    png.extend_from_slice(b"IHDR");
    png.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]); // 1×1 RGBA
    png.extend_from_slice(&[0x1f, 0x15, 0xc4, 0x89]); // IHDR CRC
    png.extend_from_slice(&[0, 0, 0, 0]); // IEND 长度
    png.extend_from_slice(b"IEND");
    png.extend_from_slice(&[0xae, 0x42, 0x60, 0x82]); // IEND CRC
    let prefix = png.len();
    let mut out = png;
    for i in 0..6 {
        out.push(0x47); // 同步字节
        out.extend(std::iter::repeat(0x20u8).take(187));
        out[prefix + i * 188] = 0x47;
    }
    out
}

#[test]
fn disguised_ts_offset_strips_png_prefix() {
    let body = disguised_segment();
    let offset = disguised_ts_offset(&body).expect("should detect disguise");
    assert_eq!(body[offset], 0x47);
    assert_eq!(
        offset,
        body.windows(4).position(|w| w == b"IEND").unwrap() + 8
    );
}

#[test]
fn disguised_ts_offset_ignores_real_png_and_plain_ts() {
    // 真实海报：PNG 签名 + IEND 在尾部，后面没有 TS 同步字节。
    let mut poster: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    poster.extend_from_slice(&[0u8; 600]);
    poster.extend_from_slice(b"IEND");
    poster.extend_from_slice(&[0u8; 4]);
    assert!(disguised_ts_offset(&poster).is_none());

    // 干净 TS：没有 PNG 签名。
    let mut ts = vec![0x47u8; 1024];
    for i in 1..1024 {
        ts[i] = 0x20;
    }
    for k in (0..1024).step_by(188) {
        ts[k] = 0x47;
    }
    assert!(disguised_ts_offset(&ts).is_none());
}

#[test]
fn image_format_sniffs_common_headers() {
    // 上游对 .jpg 回 application/octet-stream 时靠文件头认图（实测 3 个图床）。
    assert_eq!(image_format(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
    assert_eq!(image_format(b"\x89PNG\r\n\x1a\n0000"), Some("image/png"));
    assert_eq!(image_format(b"GIF89a000000"), Some("image/gif"));
    assert_eq!(
        image_format(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
        Some("image/webp")
    );
    assert_eq!(
        image_format(b"\x00\x00\x00\x20ftypavif0000"),
        Some("image/avif")
    );
    assert_eq!(image_format(b"BM000000"), Some("image/bmp"));
}

#[test]
fn image_format_rejects_non_images() {
    assert_eq!(image_format(b"<html>404 not found</html>"), None);
    assert_eq!(image_format(b"#EXTM3U\n#EXTINF:4,\nseg.ts\n"), None);
    assert_eq!(image_format(b""), None);
}

#[test]
fn image_attempt_browser_headers_overwrite_ua_and_keep_referer() {
    let base = vec![
        ("User-Agent".to_string(), "okhttp/3.15".to_string()),
        ("Referer".to_string(), "https://ref.example/".to_string()),
        ("Cookie".to_string(), "a=1".to_string()),
    ];
    assert_eq!(image_attempt_headers(&base, ImageAttempt::Source), base);

    let browser = image_attempt_headers(&base, ImageAttempt::Browser);
    let get = |name: &str| {
        browser
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(get("User-Agent"), Some(IMAGE_BROWSER_UA));
    assert_eq!(get("Referer"), Some("https://ref.example/"));
    assert_eq!(get("Cookie"), Some("a=1"));
    assert!(get("Accept").unwrap_or("").contains("image/avif"));
    // 不允许出现两个 UA（reqwest 会把后一个覆盖成单值，别指望它去重）。
    assert_eq!(
        browser
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case("User-Agent"))
            .count(),
        1
    );
}

#[test]
fn image_attempt_headers_adds_missing_ua_and_keeps_explicit_accept() {
    let base = vec![("Accept".to_string(), "image/png".to_string())];
    let browser = image_attempt_headers(&base, ImageAttempt::HttpFallback);
    assert!(browser
        .iter()
        .any(|(key, value)| key == "User-Agent" && value == IMAGE_BROWSER_UA));
    assert_eq!(
        browser.iter().filter(|(key, _)| key == "Accept").count(),
        1,
        "显式 Accept 不能被覆盖或重复"
    );
    assert!(browser
        .iter()
        .any(|(key, value)| key == "Accept" && value == "image/png"));
}

#[test]
fn next_image_attempt_prefers_http_fallback_for_https_tls_failure() {
    let url = Url::parse("https://img.example/a.jpg").unwrap();
    let (attempt, fallback) = next_image_attempt(&url, ImageFailure::Tls).expect("http 回退");
    assert_eq!(attempt, ImageAttempt::HttpFallback);
    assert_eq!(fallback.scheme(), "http");
    assert_eq!(fallback.as_str(), "http://img.example/a.jpg");

    // 原 URL 已经是 http：没有「降级」空间，也不做隐式 https 升级。
    let plain = Url::parse("http://img.example/a.jpg").unwrap();
    assert_eq!(next_image_attempt(&plain, ImageFailure::Tls), None);
}

#[test]
fn next_image_attempt_retries_browser_headers_only_for_retryable_kinds() {
    let url = Url::parse("https://img.example/a.jpg").unwrap();
    for failure in [
        ImageFailure::Status,
        ImageFailure::NotImage,
        ImageFailure::Connect,
        ImageFailure::Other,
    ] {
        let (attempt, retry) = next_image_attempt(&url, failure).expect(failure.as_str());
        assert_eq!(attempt, ImageAttempt::Browser, "{}", failure.as_str());
        assert_eq!(retry.as_str(), "https://img.example/a.jpg");
    }
    // DNS（Clash fake-IP）/ 超时重试无意义：换个 UA 解析结果和超时预算都不变。
    assert_eq!(next_image_attempt(&url, ImageFailure::Dns), None);
    assert_eq!(next_image_attempt(&url, ImageFailure::Timeout), None);
}

#[test]
fn classify_error_text_separates_network_from_picture() {
    assert_eq!(
        classify_error_text(
            "dns error: failed to lookup address information: Name or service not known"
        ),
        ImageFailure::Dns
    );
    assert_eq!(
        classify_error_text("invalid peer certificate: UnknownIssuer"),
        ImageFailure::Tls
    );
    assert_eq!(classify_error_text("tls handshake eof"), ImageFailure::Tls);
    assert_eq!(
        classify_error_text("tcp connect error: Connection refused (os error 10061)"),
        ImageFailure::Connect
    );
    assert_eq!(
        classify_error_text("connection reset by peer"),
        ImageFailure::Connect
    );
    assert_eq!(
        classify_error_text("operation timed out"),
        ImageFailure::Timeout
    );
    assert_eq!(classify_error_text("something odd"), ImageFailure::Other);
    // 失败的 UA / 状态码不参与分类，别把 403 当成 TLS。
    assert_eq!(
        classify_error_text("upstream status 403 Forbidden"),
        ImageFailure::Other
    );
}

#[derive(Debug)]
struct ChainLink(&'static str, Option<Box<ChainLink>>);

impl std::fmt::Display for ChainLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for ChainLink {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.1
            .as_deref()
            .map(|link| link as &(dyn std::error::Error + 'static))
    }
}

#[test]
fn error_chain_flattens_source_chain() {
    // reqwest 的 Display 只有 "error sending request for url (...)"，真正原因
    // 在 source() 里；摊平后日志才有 tls/dns 可读。
    let err = ChainLink(
        "error sending request for url (https://img.example/a.jpg)",
        Some(Box::new(ChainLink(
            "client error (Connect)",
            Some(Box::new(ChainLink(
                "invalid peer certificate: UnknownIssuer",
                None,
            ))),
        ))),
    );
    let text = error_chain(&err);
    assert!(text.contains("error sending request"), "{text}");
    assert!(
        text.contains("invalid peer certificate: UnknownIssuer"),
        "{text}"
    );
    // 同一段文本不重复拼（source 链里偶尔会有等价的 io::Error）。
    let dup = ChainLink("same", Some(Box::new(ChainLink("same", None))));
    assert_eq!(error_chain(&dup), "same");
}

#[test]
fn propagate_site_appends_to_bare_proxy_urls() {
    let text = "#EXTM3U\nhttp://127.0.0.1:9979/proxy?url=&slug=cctv2&seq=39\n";
    let out = handlers::propagate_site_to_playlist(text, "py_yangshipin");
    assert!(out.contains("seq=39&site=py_yangshipin"), "{out}");
}

#[test]
fn propagate_site_skips_urls_already_carrying_site() {
    let text = "http://127.0.0.1:9979/proxy?do=py&site=x\n";
    let out = handlers::propagate_site_to_playlist(text, "y");
    assert_eq!(out, text);
}

#[test]
fn propagate_site_inserts_inside_uri_quotes() {
    let text = "#EXT-X-KEY:METHOD=AES-128,URI=\"http://127.0.0.1:9979/proxy?url=&slug=k\"\n";
    let out = handlers::propagate_site_to_playlist(text, "py_x");
    assert!(
        out.contains("slug=k&site=py_x\""),
        "should insert before the closing quote: {out}"
    );
}

#[test]
fn propagate_site_leaves_non_proxy_lines_untouched() {
    let text = "#EXTINF:7,\nhttps://real.cdn/seg.ts\n";
    let out = handlers::propagate_site_to_playlist(text, "py_x");
    assert_eq!(out, text);
}

#[test]
fn propagate_site_urlencodes_non_ascii_key() {
    let text = "http://127.0.0.1:9979/proxy?url=&slug=a\n";
    let out = handlers::propagate_site_to_playlist(text, "央视频源1");
    assert!(out.contains("slug=a&site=%E5%A4%AE"), "site key should be percent-encoded: {out}");
}
