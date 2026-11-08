//! Tauri 应用入口。业务 command 按 7.1 注册；解析逻辑全部在 Python sidecar。

pub mod bridge;
pub mod config;
pub mod error;
pub mod http;
pub mod spider;

pub use error::{code, AppError};

use config::ConfigStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ConfigStore::default())
        .invoke_handler(tauri::generate_handler![
            config::config_import,
            config::config_list,
            config::config_remove,
            http::http_fetch,
            spider::spider_invoke,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
