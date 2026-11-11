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
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2WebResourceRequestedEventArgs, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows062::core::HSTRING;

    unsafe {
        let controller = webview.controller();
        let core = match controller.CoreWebView2() {
            Ok(core) => core,
            Err(err) => {
                let _ = ready.send(Err(err.to_string()));
                return;
            }
        };
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
    _tx: tokio::sync::mpsc::UnboundedSender<String>,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    let _ = ready.send(Err("sniffer is only implemented on Windows".to_string()));
}

/// Load `page_url` in a hidden WebView and return the first media URL it asks
/// for. The caller is responsible for wrapping it into the local proxy.
pub async fn sniff(
    app: &tauri::AppHandle,
    page_url: &str,
    timeout: Duration,
) -> Result<String, AppError> {
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
    if let Err(err) = window.with_webview(move |webview| install(webview, tx, ready_tx)) {
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
    fn accepts_stream_entries_but_not_segments() {
        assert!(is_media("https://cdn.example/a/index.m3u8?token=1"));
        assert!(is_media("https://cdn.example/a/movie.mp4"));
        assert!(is_media("https://cdn.example/live/room.flv"));
        assert!(!is_media("https://cdn.example/a/seg0.ts"));
        assert!(!is_media("https://cdn.example/page.html"));
        assert!(!is_media("blob:http://localhost/abc"));
        assert!(!is_media("data:video/mp4;base64,AAAA"));
    }
}
