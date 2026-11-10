//! Tauri 应用入口。业务 command 按 7.1 注册；解析逻辑全部在 Python sidecar。

pub mod bridge;
pub mod config;
pub mod error;
pub mod http;
pub mod live;
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

pub use error::{code, AppError};

use config::ConfigStore;
use store::LibraryStore;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ConfigStore::load())
        .manage(LibraryStore::load())
        .setup(|app| {
            // T-32: in an installed build the sidecars live under the resource
            // dir, not next to the source tree. Publish that root once so
            // bridge / jvm / mpv resolve the same layout in dev and prod.
            if let Ok(resource) = app.path().resource_dir() {
                std::env::set_var("TVBOX_RESOURCE_DIR", &resource);
                tracing::info!(dir = %resource.display(), "resource dir");
            }
            // Optional startup self-check (`TVBOX_SELFCHECK=1`): exercises the
            // Python sidecar path resolution and leaves the result in
            // `<data>/selfcheck.log`. Off by default; useful for diagnosing a
            // portable/installed layout without a console.
            if std::env::var("TVBOX_SELFCHECK").ok().as_deref() == Some("1") {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
