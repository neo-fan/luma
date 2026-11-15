//! Level-4 playback sniffer (spec 8.6 / T-29).
//!
//! When the first three levels (direct URL, site playerContent, parses[]) all
//! fail to produce a playable address, load the play page in an **isolated,
//! invisible WebView2** and observe its network requests. The window:
//! * is a separate `sniffer-*` window, not listed in `capabilities/default.json`
//!   (which only grants `main`), so third-party pages get zero command rights;
//! * is hidden and skipped in the taskbar;
//! * is closed as soon as a media URL shows up or the wall clock expires.
//!
//! The wall clock is not specified by the spec for this level (10 节 only
//! covers py/js/jar child processes), so `play.rs` passes the same 15s budget
//! used for a single source and the value lives in one place.

use crate::error::{code, AppError};
use std::time::Duration;
use url::Url;

/// Third-party config files are untrusted input: a 1 MB header value would be
/// copied onto every request the hidden window makes, so cap both fields long
/// before they reach WebView2.
const MAX_HEADER_NAME_BYTES: usize = 256;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;

/// RFC 7230 `token`: what a header name may consist of. Spaces, colons, CR/LF
/// and non-ASCII bytes are rejected — they either produce an invalid request or
/// allow request splitting.
fn is_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_HEADER_NAME_BYTES
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

/// Header values may be arbitrary printable text (config tables in the wild
/// carry non-ASCII Referer / Cookie values), but never control characters:
/// CR/LF/NUL are the injection vectors, and Chromium rejects them anyway.
fn is_header_value(value: &str) -> bool {
    value.len() <= MAX_HEADER_VALUE_BYTES && value.chars().all(|ch| ch == '\t' || !ch.is_control())
}

/// Turn the caller's headers into the set the hidden WebView2 will send.
///
/// * names/values Chromium would reject are dropped instead of failing the
///   whole sniff — one bad row from a config must not kill level 4;
/// * duplicates are merged case-insensitively keeping the last value (same
///   rule `resolve_play` uses when a parser overrides spider headers);
/// * nothing is invented here: UA / Referer defaults come from
///   [`crate::netrules::with_defaults`] on the caller side, so a caller that
///   passes no headers (the `parses[]` type-0 path) keeps WebView2's own UA and
///   behaves exactly like it did before this change.
fn webview_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in headers {
        if !is_header_name(name) || !is_header_value(value) {
            continue;
        }
        if let Some(slot) = out
            .iter_mut()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
        {
            slot.1.clone_from(value);
        } else {
            out.push((name.clone(), value.clone()));
        }
    }
    out
}

/// Only accept the actual stream entry, never segment requests: a page loads
/// `index.m3u8` before its `.ts` segments, and returning a segment would make
/// the player show a 2-second clip.
fn is_media(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("blob:") {
        return false;
    }
    let path = lower.split(['?', '#']).next().unwrap_or(&lower);
    [".m3u8", ".mp4", ".flv", ".mkv", ".mov", ".webm"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

#[cfg(windows)]
fn install(
    webview: tauri::webview::PlatformWebview,
    headers: Vec<(String, String)>,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings2, ICoreWebView2WebResourceRequestedEventArgs,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows062::core::{HSTRING, Interface};

    unsafe {
        let controller = webview.controller();
        let core = match controller.CoreWebView2() {
            Ok(core) => core,
            Err(err) => {
                let _ = ready.send(Err(err.to_string()));
                return;
            }
        };
        // `Settings2.SetUserAgent` also changes `navigator.userAgent`, so pages
        // that branch on the UA see the same client that sends the request. The
        // per-request header below is the fallback for runtimes where the cast
        // to Settings2 is unavailable.
        if let Some((_, ua)) = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("User-Agent"))
        {
            match core
                .Settings()
                .and_then(|settings| settings.cast::<ICoreWebView2Settings2>())
            {
                Ok(settings) => {
                    if let Err(err) = settings.SetUserAgent(&HSTRING::from(ua.as_str())) {
                        eprintln!("[sniff] SetUserAgent failed: {err}");
                    }
                }
                Err(err) => eprintln!("[sniff] ICoreWebView2Settings2 unavailable: {err}"),
            }
        }
        if let Err(err) =
            core.AddWebResourceRequestedFilter(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
        {
            let _ = ready.send(Err(err.to_string()));
            return;
        }
        let handler = WebResourceRequestedEventHandler::create(Box::new(
            move |_sender,
                  args: Option<ICoreWebView2WebResourceRequestedEventArgs>| {
                if let Some(args) = args {
                    if let Ok(request) = args.Request() {
                        // WebView2 only lets the host rewrite outgoing headers
                        // from this event; that is how Referer/Cookie and any
                        // config-level header reach the page before it runs.
                        // A rejected header (Host, Content-Length, ...) must not
                        // abort the request, so errors are ignored.
                        if let Ok(outgoing) = request.Headers() {
                            for (name, value) in &headers {
                                let _ = outgoing.SetHeader(
                                    &HSTRING::from(name.as_str()),
                                    &HSTRING::from(value.as_str()),
                                );
                            }
                        }
                        // Uri() writes into a CoTaskMem pointer; take_pwstr copies
                        // it out and frees the original, so no COM leak per request.
                        let mut uri = windows062::core::PWSTR::null();
                        if request.Uri(&mut uri).is_ok() {
                            let _ = tx.send(webview2_com::take_pwstr(uri));
                        }
                    }
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        if let Err(err) = core.add_WebResourceRequested(&handler, &mut token) {
            let _ = ready.send(Err(err.to_string()));
            return;
        }
        let _ = ready.send(Ok(()));
    }
}

#[cfg(not(windows))]
fn install(
    _webview: tauri::webview::PlatformWebview,
    _headers: Vec<(String, String)>,
    _tx: tokio::sync::mpsc::UnboundedSender<String>,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    let _ = ready.send(Err("sniffer is only implemented on Windows".to_string()));
}

/// Entry point kept for `parses[]` type-0 webview rules, which do not resolve
/// config-level headers yet. Level 4 in `resolve_play` calls
/// [`sniff_with_headers`] with the same pairs it sends to the local proxy.
pub async fn sniff(
    app: &tauri::AppHandle,
    page_url: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    sniff_with_headers(app, page_url, &[], timeout).await
}

/// 隐藏嗅探窗必须静音。
///
/// 社区源的分享页大多「进页面就自动播放」：嗅探窗 `visible(false)` 看不见，
/// 但 WebView2 里的 `<video>` 照样出声，用户看到的是主播放器黑屏、却有声音。
/// 这里在页面脚本之前注入：新出现的 `video/audio` 一律 `muted` + `volume=0`，
/// 并监听 `play` 兜底（部分播放器会用 MSE 重建元素）。
const MUTE_MEDIA_SCRIPT: &str = r#"
(function () {
  var muted = new WeakSet();
  function mute(el) {
    if (!el || muted.has(el)) return;
    muted.add(el);
    try { el.muted = true; el.volume = 0; el.defaultMuted = true; } catch (e) {}
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("video,audio").forEach(mute);
  }
  document.addEventListener("play", function (e) { mute(e.target); }, true);
  document.addEventListener("loadedmetadata", function (e) { mute(e.target); }, true);
  var observer = new MutationObserver(function (records) {
    records.forEach(function (record) {
      record.addedNodes.forEach(function (node) {
        if (node && node.nodeType === 1) {
          if (node.tagName === "VIDEO" || node.tagName === "AUDIO") mute(node);
          scan(node);
        }
      });
    });
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });
  scan(document);
})();
"#;

/// Load `page_url` in a hidden WebView and return the first media URL it asks
/// for. `headers` follow the `resolve_play` precedence (spider-explicit first,
/// config host rules next, defaults last) and are sanitised by
/// [`webview_headers`] before they reach WebView2; they are injected before the
/// navigation, so the page's very first request carries them. The caller is
/// responsible for wrapping the result into the local proxy.
pub async fn sniff_with_headers(
    app: &tauri::AppHandle,
    page_url: &str,
    headers: &[(String, String)],
    timeout: Duration,
) -> Result<String, AppError> {
    let headers = webview_headers(headers);
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    use tauri::Manager;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // The hidden WebView2 needs its own environment: sharing the main window's
    // environment would inherit WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (notably
    // `--remote-debugging-port=9222` in dev), and two instances cannot listen on
    // the same debug port — Windows returns 0x8007139F. Different browser args
    // also require a different data directory, so sniffing is serialised.
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    let parsed = Url::parse(page_url)
        .map_err(|err| AppError::new(code::INVALID_ARGUMENT, "sniff url invalid").with_cause(err.to_string()))?;
    let blank = Url::parse("about:blank").expect("about:blank is a valid url");
    let label = format!("sniffer-{}", COUNTER.fetch_add(1, Ordering::Relaxed));
    let data_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("sniffer");
    let _ = std::fs::create_dir_all(&data_dir);

    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(blank))
        .title("sniffer")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .data_directory(data_dir)
        .additional_browser_args("--remote-debugging-port=0")
        // 页面自动播放时嗅探窗是隐藏的，音频却会漏到系统混音器里（用户看到
        // 「主播放器黑屏、却有声音」）。初始化脚本在页面脚本之前执行。
        .initialization_script(MUTE_MEDIA_SCRIPT)
        .build()
        .map_err(|err| {
            eprintln!("[sniff] window build failed: {err}");
            AppError::new(code::RUNTIME_UNAVAILABLE, "sniffer window failed")
                .with_cause(err.to_string())
        })?;

    // If this future is dropped (the parse pool races several parsers and
    // aborts the losers), the guard still closes the window. Without it an
    // aborted sniff leaks a hidden WebView2 for the app's whole lifetime.
    struct CloseOnDrop<'a>(&'a tauri::WebviewWindow);
    impl Drop for CloseOnDrop<'_> {
        fn drop(&mut self) {
            let _ = self.0.close();
        }
    }
    let _closer = CloseOnDrop(&window);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    if let Err(err) = window.with_webview(move |webview| install(webview, headers, tx, ready_tx)) {
        eprintln!("[sniff] with_webview failed: {err}");
        let _ = window.close();
        return Err(AppError::new(code::RUNTIME_UNAVAILABLE, "sniffer hook failed")
            .with_cause(err.to_string()));
    }

    // `with_webview` dispatches to the UI thread; give the filter a moment so
    // the very first request of the page is not missed. A timeout here is not
    // fatal — we still navigate and let the wall clock decide.
    match tokio::time::timeout(Duration::from_secs(3), ready_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(err))) => eprintln!("[sniff] install failed: {err}"),
        Ok(Err(err)) => eprintln!("[sniff] ready channel closed: {err}"),
        Err(_) => eprintln!("[sniff] install timed out"),
    }

    if let Err(err) = window.navigate(parsed) {
        eprintln!("[sniff] navigate failed: {err}");
        let _ = window.close();
        return Err(AppError::new(code::PLAY_RESOLVE_FAIL, "sniffer navigate failed")
            .with_cause(err.to_string()));
    }

    let found = tokio::time::timeout(timeout, async {
        while let Some(candidate) = rx.recv().await {
            if is_media(&candidate) {
                return Some(candidate);
            }
        }
        None
    })
    .await;

    let _ = window.close();

    match found {
        Ok(Some(url)) => {
            tracing::info!(page = %page_url, media = %url, "sniffer found media url");
            Ok(url)
        }
        Ok(None) => Err(AppError::new(code::PLAY_RESOLVE_FAIL, "sniffer found no media url")),
        Err(_) => Err(AppError::new(
            code::PLAY_RESOLVE_FAIL,
            format!("sniffer exceeded {}ms", timeout.as_millis()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mute_script_silences_every_media_element() {
        // 嗅探窗不可见，页面自动播放的声音会漏出去：脚本必须同时处理
        // 已有元素（scan）与后续插入（MutationObserver + play 事件）。
        assert!(MUTE_MEDIA_SCRIPT.contains("muted = true"));
        assert!(MUTE_MEDIA_SCRIPT.contains("volume = 0"));
        assert!(MUTE_MEDIA_SCRIPT.contains("MutationObserver"));
        assert!(MUTE_MEDIA_SCRIPT.contains("querySelectorAll(\"video,audio\")"));
    }

    #[test]
    fn accepts_stream_entries_but_not_segments() {
        assert!(is_media("https://cdn.example/a/index.m3u8?token=1"));
        assert!(is_media("https://cdn.example/a/movie.mp4"));
        assert!(is_media("https://cdn.example/live/room.flv"));
        assert!(!is_media("https://cdn.example/a/seg0.ts"));
        assert!(!is_media("https://cdn.example/page.html"));
        assert!(!is_media("blob:http://localhost/abc"));
        assert!(!is_media("data:video/mp4;base64,AAAA"));
    }

    /// The `parses[]` type-0 path passes no headers: WebView2 must keep its own
    /// UA and send nothing extra, i.e. behave exactly like before this change.
    #[test]
    fn empty_headers_leave_the_webview_untouched() {
        assert!(webview_headers(&[]).is_empty());
    }

    /// The whole point of the change: a spider/config UA survives untouched
    /// (and is not replaced by, or duplicated with, a default).
    #[test]
    fn explicit_user_agent_is_kept() {
        let out = webview_headers(&[
            ("User-Agent".to_string(), "Mozilla/5.0 Luma".to_string()),
            ("Referer".to_string(), "https://page.example/".to_string()),
        ]);
        let agents: Vec<&(String, String)> = out
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("User-Agent"))
            .collect();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].1, "Mozilla/5.0 Luma");
        assert!(out
            .iter()
            .any(|(name, value)| name == "Referer" && value == "https://page.example/"));
    }

    #[test]
    fn lowercase_user_agent_from_a_spider_is_kept() {
        let out = webview_headers(&[("user-agent".to_string(), "spider/2.0".to_string())]);
        assert_eq!(out.len(), 1, "case-insensitive match, no second UA");
        assert_eq!(out[0].1, "spider/2.0");
    }

    /// Third-party config rows are untrusted: one malformed name/value must be
    /// dropped, not break the remaining headers or the sniff.
    #[test]
    fn illegal_header_names_and_values_are_dropped() {
        let out = webview_headers(&[
            ("Bad Header".to_string(), "x".to_string()),
            ("X-CRLF".to_string(), "a\r\nInjected: 1".to_string()),
            (String::new(), "x".to_string()),
            ("Cookie".to_string(), "sid=1; theme=dark".to_string()),
        ]);
        assert!(out.iter().all(|(name, _)| !name.contains(' ')));
        assert!(!out
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("X-CRLF")));
        assert!(!out.iter().any(|(name, _)| name.is_empty()));
        assert!(out
            .iter()
            .any(|(name, value)| name == "Cookie" && value == "sid=1; theme=dark"));
        assert_eq!(
            out.len(),
            1,
            "only the well-formed row survives; nothing is invented"
        );
    }

    #[test]
    fn duplicate_headers_keep_the_last_value() {
        let out = webview_headers(&[
            ("Referer".to_string(), "https://old.example/".to_string()),
            ("referer".to_string(), "https://new.example/".to_string()),
        ]);
        let referers: Vec<&(String, String)> = out
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("Referer"))
            .collect();
        assert_eq!(referers.len(), 1);
        assert_eq!(referers[0].1, "https://new.example/");
    }
}
