use super::*;

#[test]
fn urlencode_keeps_unreserved_only() {
    assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
    assert_eq!(urlencode("http://a b/?x=1&y=2"), "http%3A%2F%2Fa%20b%2F%3Fx%3D1%26y%3D2");
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
    assert!(headers.iter().any(|(k, v)| k == "Referer" && v == "https://api.douban.com/"));
    assert!(headers.iter().any(|(k, v)| k == "User-Agent" && v == "Mozilla/5.0 (Windows NT 10.0)"));
}

#[test]
fn parse_vod_pic_cookie_and_header_aliases() {
    let raw = "https://cdn/x.png@ua=okhttp%2F3.15@referer=https%3A%2F%2Fh%2F@Cookie=a%3D1%3Bb%3D2";
    let (url, headers) = parse_vod_pic_url(raw).expect("aliases");
    assert_eq!(url, "https://cdn/x.png");
    assert!(headers.iter().any(|(k, v)| k == "User-Agent" && v == "okhttp/3.15"));
    assert!(headers.iter().any(|(k, v)| k == "Referer" && v == "https://h/"));
    assert!(headers.iter().any(|(k, v)| k == "Cookie" && v == "a=1;b=2"));
}

#[test]
fn parse_vod_pic_headers_json_and_explicit_override() {
    // @Headers is URL-encoded JSON; an explicit @Referer must override it.
    let raw = "https://cdn/x.webp@Headers=%7B%22Referer%22%3A%22https%3A%2F%2Fjson%2F%22%2C%22X-Token%22%3A%22abc%22%7D@Referer=https%3A%2F%2Fexplicit%2F";
    let (url, headers) = parse_vod_pic_url(raw).expect("headers json");
    assert_eq!(url, "https://cdn/x.webp");
    let get = |k: &str| headers.iter().find(|(name, _)| name == k).map(|(_, v)| v.as_str());
    assert_eq!(get("Referer"), Some("https://explicit/")); // explicit wins, single entry
    assert_eq!(get("X-Token"), Some("abc"));
    assert_eq!(headers.iter().filter(|(name, _)| name == "Referer").count(), 1);
}

#[test]
fn percent_decode_handles_invalid_utf8_gracefully() {
    assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
    assert_eq!(percent_decode("plain"), "plain");
    assert_eq!(percent_decode("%FF%FE"), "%FF%FE"); // invalid UTF-8 -> raw
}

#[test]
fn proxy_url_includes_optional_headers() {
    let url = build_proxy_url(9978, "http://cdn/x.m3u8", Some("okhttp/3.15"), Some("http://ref/"), None);
    assert!(url.starts_with("http://127.0.0.1:9978/proxy?url=http%3A%2F%2Fcdn%2Fx.m3u8"));
    assert!(url.contains("ua=okhttp%2F3.15"));
    assert!(url.contains("referer=http%3A%2F%2Fref%2F"));
    assert!(!url.contains("cookie="));
}

#[test]
fn blocked_ranges_cover_private_and_loopback() {
    for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"] {
        assert!(is_blocked(ip.parse().unwrap()), "{ip} should be blocked");
    }
    for ip in ["8.8.8.8", "1.1.1.1"] {
        assert!(!is_blocked(ip.parse().unwrap()), "{ip} should be allowed");
    }
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
    assert!(out.contains("http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fcdn.example%2Fx%2Fseg0.ts"), "{out}");
    assert!(out.contains("URI=\"http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fcdn.example%2Fx%2Fkey.bin"), "{out}");
    assert!(out.contains("url=https%3A%2F%2Fother.example%2Fseg1.ts"), "{out}");
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
    assert!(!looks_like_playlist(r#"{"code":201,"msg":"解析失败了","url":""}"#));
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
    assert_eq!(offset, body.windows(4).position(|w| w == b"IEND").unwrap() + 8);
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
    assert_eq!(image_format(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
    assert_eq!(image_format(b"\x00\x00\x00\x20ftypavif0000"), Some("image/avif"));
    assert_eq!(image_format(b"BM000000"), Some("image/bmp"));
}

#[test]
fn image_format_rejects_non_images() {
    assert_eq!(image_format(b"<html>404 not found</html>"), None);
    assert_eq!(image_format(b"#EXTM3U\n#EXTINF:4,\nseg.ts\n"), None);
    assert_eq!(image_format(b""), None);
}
