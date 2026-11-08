//! Tauri 应用入口。T-01 只保留最小可运行骨架：
//! 注册 shell 插件（仅 `shell:allow-open` 被 capabilities 授权），不注册任何业务 command。
//! 业务 command 按 T-04 起逐个加入并在 capabilities / invoke.ts 中登记。

pub mod error;

pub use error::{code, AppError};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
