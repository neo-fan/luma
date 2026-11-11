//! Tauri 应用入口。业务 command 按 7.1 注册；解析逻辑全部在 Python sidecar。

pub mod bridge;
pub mod clipboard;
pub mod config;
pub mod db;
pub mod env;
pub mod error;
pub mod http;
pub mod live;
pub mod logging;
pub mod migrate;
pub mod mpv;
pub mod netrules;
pub mod parse;
pub mod paths;
pub mod play;
pub mod process;
pub mod proxy;
pub mod sniff;
pub mod spider;
pub mod store;
pub mod window;

pub use error::{code, AppError};

use config::ConfigStore;
use store::LibraryStore;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging first: DB migration, sidecar resolution and proxy startup all
    // emit tracing events, and a trial user needs them on disk even if the
    // window never renders.
    logging::init();
    // One SQLite connection shared by both stores: config snapshots, active
    // marker, favourites and history all live in `<data dir>/luma.db`.
    let database = Arc::new(db::Db::open().expect("open sqlite database"));
    tracing::info!(path = %database.path().display(), "sqlite persistence ready");
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ConfigStore::load(database.clone()).expect("load config store"))
        .manage(LibraryStore::load(database.clone()).expect("load library store"))
        .setup(|app| {
            // 标题栏跟随主界面深色，避免 Windows 默认浅色/系统深灰与画布色差。
            if let Some(window) = app.get_webview_window("main") {
                window::apply_dark_caption(&window);
            }
            // T-32: in an installed build the sidecars live under the resource
            // dir, not next to the source tree. Publish that root once so
            // bridge / jvm / mpv resolve the same layout in dev and prod.
            if let Ok(resource) = app.path().resource_dir() {
                env::set("RESOURCE_DIR", &resource);
                tracing::info!(dir = %resource.display(), "resource dir");
            }
            // Optional startup self-check (`LUMA_SELFCHECK=1`): exercises the
            // Python sidecar path resolution and leaves the result in
            // `<data>/selfcheck.log`. Off by default; useful for diagnosing a
            // portable/installed layout without a console.
            if env::is_enabled("SELFCHECK") {
                tauri::async_runtime::spawn(async move {
                    let outcome = match tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        bridge::ping(),
                    )
                    .await
                    {
                        Ok(Ok(value)) => format!("ping ok: {value}"),
                        Ok(Err(err)) => format!("ping err: {} {}", err.code, err.message),
                        Err(_) => "ping timeout".to_string(),
                    };
                    let dir = store::data_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(dir.join("selfcheck.log"), outcome);
                });
            }

            // 7.5: the local reverse proxy is started by the Rust host only.
            match proxy::start() {
                Ok(state) => {
                    app.manage(state);
                }
                Err(err) => {
                    tracing::error!(error = %err, "local proxy failed to start");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::config_import,
            config::config_list,
            config::config_active,
            config::config_remove,
            http::http_fetch,
            spider::spider_invoke,
            live::live_parse,
            proxy::proxy_status,
            play::resolve_play,
            parse::parse_resolve,
            play::open_external,
            mpv::mpv_play,
            store::favorites_list,
            store::favorites_toggle,
            store::history_list,
            store::history_upsert,
            store::history_clear,
            // Trial-run diagnostics: UI log sink, one-click report, log folder.
            logging::log_write,
            logging::diagnostics,
            logging::open_log_dir,
            clipboard::copy_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
