//! Tauri 应用入口。业务 command 按 7.1 注册；解析逻辑全部在 Python sidecar。
//!
//! ## 源码分层（2026-11-11 物理归档）
//!
//! 源码按技术层归入两个目录，用 `#[path]` 保持逻辑模块名不变
//! （`crate::error`、`crate::config` 等），因此所有 `use crate::foo` 与
//! `generate_handler!` 的 command 路径都无需改动，也不会引发 "command not found"。
//!
//! - `infra/`：底座能力（错误、环境、路径、进程、HTTP、bridge、DB、迁移、
//!   存储、日志、窗口）——出边少、被大量依赖。`db` 与 `store` 有双向引用，
//!   刻意同放一层，避免跨越层边界成环。
//! - `domain/`：业务语义（配置、播放、解析、代理、直播、嗅探、mpv、剪贴板、
//!   spider 派发）。`proxy` 与 `spider` 有双向引用，同样同放一层。
//!
//! 这是**物理分层**：依赖方向的硬约束（把 `crate::infra::*` 前缀化、抽
//! `commands/` 模块）留作后续阶段，届时再逐个提升私有 helper 的可见性。

// ---- infra/：底座能力 ----
#[path = "infra/bridge.rs"]
pub mod bridge;
#[path = "infra/db.rs"]
pub mod db;
#[path = "infra/env.rs"]
pub mod env;
#[path = "infra/error.rs"]
pub mod error;
#[path = "infra/http.rs"]
pub mod http;
#[path = "infra/logging.rs"]
pub mod logging;
#[path = "infra/netrules.rs"]
pub mod netrules;
#[path = "infra/paths.rs"]
pub mod paths;
#[path = "infra/process.rs"]
pub mod process;
#[path = "infra/store.rs"]
pub mod store;
#[path = "infra/window.rs"]
pub mod window;

// ---- domain/：业务语义 ----
#[path = "domain/clipboard.rs"]
pub mod clipboard;
#[path = "domain/config.rs"]
pub mod config;
#[path = "domain/live.rs"]
pub mod live;
#[path = "domain/mpv.rs"]
pub mod mpv;
#[path = "domain/parse.rs"]
pub mod parse;
#[path = "domain/play.rs"]
pub mod play;
#[path = "domain/proxy.rs"]
pub mod proxy;
#[path = "domain/sniff.rs"]
pub mod sniff;
#[path = "domain/spider/mod.rs"]
pub mod spider;

pub use error::{code, AppError};

use config::ConfigStore;
use store::LibraryStore;
use std::sync::Arc;
use tauri::{Emitter, Manager};

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

            // 订阅定时刷新：60s 一次轻量判定，到期才真正回拉配置。间隔由
            // 设置页控制（0 = 关闭），改设置后下一个 tick 立即生效，不需要
            // 重建任务。只刷 active 订阅：刷新非 active 配置对用户没有可见
            // 收益，却会悄悄改掉别人正在切换过去的那份数据。
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        let store = handle.state::<ConfigStore>();
                        let Some(id) = store.due_config_id() else {
                            continue;
                        };
                        match store.refresh(Some(&id)).await {
                            Ok(outcome) if outcome.changed => {
                                tracing::info!(
                                    config = %outcome.config_id,
                                    sites = outcome.sites,
                                    "subscription refreshed"
                                );
                                // 前端据此替换站点缓存；后台订阅更新不能静默
                                // 改数据却不告诉界面，否则列表与 fan-out 会对不上。
                                let _ = handle.emit("config-refreshed", &outcome);
                            }
                            Ok(_) => {}
                            Err(err) => tracing::warn!(
                                config = %id,
                                code = %err.code,
                                error = %err.message,
                                "subscription refresh failed"
                            ),
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::config_import,
            config::config_list,
            config::config_active,
            config::config_activate,
            config::config_rename,
            config::config_remove,
            config::config_refresh_settings,
            config::config_set_refresh_interval,
            config::config_refresh,
            config::site_set_enabled,
            http::http_fetch,
            spider::spider_invoke,
            spider::site_health,
            live::live_parse,
            live::live_epg,
            proxy::proxy_status,
            play::resolve_play,
            parse::parse_resolve,
            play::open_external,
            mpv::mpv_play,
            store::favorites_list,
            store::favorites_toggle,
            store::favorites_patch_meta,
            store::history_list,
            store::history_upsert,
            store::history_patch_meta,
            store::history_clear,
            store::history_remove,
            // Trial-run diagnostics: UI log sink, one-click report, log folder.
            logging::log_write,
            logging::diagnostics,
            logging::open_log_dir,
            logging::export_report,
            clipboard::copy_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
