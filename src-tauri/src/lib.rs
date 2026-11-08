//! Tauri 应用入口。业务 command 按 7.1 注册；解析逻辑全部在 Python sidecar。

pub mod bridge;
pub mod config;
pub mod error;
pub mod http;
pub mod live;
pub mod play;
pub mod process;
pub mod proxy;
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
            config::config_remove,
            http::http_fetch,
            spider::spider_invoke,
            live::live_parse,
            proxy::proxy_status,
            play::resolve_play,
            play::open_external,
            store::favorites_list,
            store::favorites_toggle,
            store::history_list,
            store::history_upsert,
            store::history_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
