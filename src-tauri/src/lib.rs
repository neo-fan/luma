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
//! - `domain/`：业务语义（配置、播放、解析、代理、直播、嗅探、剪贴板、
//!   spider 派发）。`proxy` 与 `spider` 有双向引用，同样同放一层。
//!
//! 这是**物理分层**：依赖方向的硬约束（把 `crate::infra::*` 前缀化、抽
//! `commands/` 模块）留作后续阶段，届时再逐个提升私有 helper 的可见性。

// ---- infra/：底座能力 ----
#[path = "infra/bridge.rs"]
pub mod bridge;
#[path = "infra/db/mod.rs"]
pub mod db;
#[path = "infra/env.rs"]
pub mod env;
#[path = "infra/error.rs"]
pub mod error;
#[path = "infra/http.rs"]
pub mod http;
#[path = "infra/logging/mod.rs"]
pub mod logging;
#[path = "infra/netrules.rs"]
pub mod netrules;
#[path = "infra/pct.rs"]
pub(crate) mod pct;
#[path = "infra/paths.rs"]
pub mod paths;
#[path = "infra/process.rs"]
pub mod process;
#[path = "infra/started.rs"]
pub mod started;
#[path = "infra/store.rs"]
pub mod store;
#[path = "infra/textio.rs"]
pub mod textio;
#[path = "infra/window.rs"]
pub mod window;

// ---- domain/：业务语义 ----
#[path = "domain/clipboard.rs"]
pub mod clipboard;
#[path = "domain/config/mod.rs"]
pub mod config;
#[path = "domain/diagnostics.rs"]
pub mod diagnostics;
#[path = "domain/douban.rs"]
pub mod douban;
#[path = "domain/ghproxy.rs"]
pub mod ghproxy;
#[path = "domain/live.rs"]
pub mod live;
#[path = "domain/parse.rs"]
pub mod parse;
#[path = "domain/play.rs"]
pub mod play;
#[path = "domain/proxy/mod.rs"]
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

/// dev（debug）默认打开 WebView2 远程调试口 9222，返回是否由本函数设置。
///
/// `tools/*.mjs` 里的探针全部靠 CDP 直连界面，以前每次启动都要手工注入
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，忘了就只能摸黑排查。
///
/// 三条约束：
/// 1. **必须在任何 WebView2 环境创建之前调用**——wry 只在
///    `CreateCoreWebView2Environment` 时读这个变量，窗口起来后再设无效；
/// 2. 只在 debug 生效，release 包不能带调试口（那等于把整个 `Runtime.evaluate`
///    暴露给本机任意进程）；
/// 3. 已经手工设置过就完全尊重用户值：想换端口、或想关掉
///    （`=--remote-debugging-port=0`）都不用改代码。
#[cfg(all(debug_assertions, target_os = "windows"))]
fn enable_devtools_port() -> bool {
    const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    if std::env::var_os(KEY).is_some() {
        return false;
    }
    std::env::set_var(KEY, "--remote-debugging-port=9222");
    true
}

#[cfg(not(all(debug_assertions, target_os = "windows")))]
fn enable_devtools_port() -> bool {
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 界面的 build 号取「本次启动时刻」：越早记越好，保证它是进程真正起来的时刻。
    started::mark();
    // 最先做：晚于 WebView2 环境创建就失效（见函数注释）。
    let devtools_default = enable_devtools_port();
    // 把解析后的数据目录发布给子进程：py 适配器的 spider.log 只认
    // LUMA_DATA_DIR / APPDATA 环境变量（见 adapterlog.py），不注入的话
    // debug 隔离（Luma-debug）下的 sidecar 日志仍会落回 %APPDATA%/Luma。
    // 必须先于 logging::init()（后者解析同一目录）与任何 sidecar spawn。
    std::env::set_var("LUMA_DATA_DIR", crate::store::data_dir());
    // Logging first: DB migration, sidecar resolution and proxy startup all
    // emit tracing events, and a trial user needs them on disk even if the
    // window never renders.
    logging::init();
    if devtools_default {
        // 上一次 dev 没退干净时端口会被旧 WebView2 占着，新实例的 DevTools
        // 就绑不上（表现为「探针连到的其实是旧窗口」或窗口起不来）。
        // 这里只做一次 loopback 探测，把根因直接写进日志。
        if std::net::TcpStream::connect(("127.0.0.1", 9222)).is_ok() {
            tracing::warn!(
                "port 9222 is already taken; CDP may attach to a stale window — kill leftover luma.exe first"
            );
        } else {
            tracing::info!("webview2 devtools listening on 127.0.0.1:9222 (debug build default)");
        }
    }
    // One SQLite connection shared by both stores: config snapshots, active
    // marker, favourites and history all live in `<data dir>/luma.db`.
    let database = Arc::new(db::Db::open().expect("open sqlite database"));
    tracing::info!(path = %database.path().display(), "sqlite persistence ready");
    let config_store = ConfigStore::load(database.clone()).expect("load config store");
    // 让已导入的配置跟上当前 GitHub 加速前缀。首次带这段代码启动时，老配置
    // 里还是裸 GitHub 地址，这里一次性改写；之后幂等，什么都没变就不写库。
    match config_store.sync_github_proxy() {
        Ok((links, configs)) if configs > 0 => {
            tracing::info!(links, configs, "github proxy applied to stored configs");
        }
        Ok(_) => {}
        Err(err) => tracing::warn!(code = %err.code, error = %err.message, "github proxy sync failed"),
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(config_store)
        .manage(LibraryStore::load(database.clone()).expect("load library store"))
        .setup(|app| {
            // 标题栏跟随主界面深色，避免 Windows 默认浅色/系统深灰与画布色差。
            if let Some(window) = app.get_webview_window("main") {
                window::apply_dark_caption(&window);
                // 调试窗口与已安装的正式版同机并存（数据目录 Luma-debug / Luma），
                // 版本号一模一样，任务栏与标题栏必须一眼可辨。判定用 Tauri 官方
                // `tauri::is_dev()`（未启用 custom-protocol，即 `tauri dev`），
                // 不用 debug_assertions：`tauri build --debug` 也是 debug 断言，
                // 但它是产物包，不该冒充调试窗口。
                if tauri::is_dev() {
                    let title = format!("Luma {} (Dev)", env!("CARGO_PKG_VERSION"));
                    let _ = window.set_title(&title);
                }
            }
            // T-32: in an installed build the sidecars live under the resource
            // dir, not next to the source tree. Publish that root once so
            // bridge / qjs runner resolve the same layout in dev and prod.
            // 走 `paths::set_resource_dir`（OnceLock）而不是 `env::set`：
            // setup() 里 tokio worker 已在跑，改环境变量与并发读是数据竞争。
            if let Ok(resource) = app.path().resource_dir() {
                paths::set_resource_dir(&resource);
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
            config::gh_proxy_state,
            config::gh_proxy_set,
            config::gh_proxy_test,
            config::site_set_enabled,
            http::http_fetch,
            spider::spider_invoke,
            spider::site_health,
            live::live_parse,
            live::live_epg,
            live::live_epg_warm,
            proxy::proxy_status,
            play::resolve_play,
            parse::parse_resolve,
            play::open_external,
            douban::douban_meta,
            douban::douban_request,
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
            diagnostics::diagnostics,
            logging::open_log_dir,
            diagnostics::export_report,
            clipboard::copy_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 退出收口：sidecar 优雅关停。以前只有 Job Object 兜底（进程一定
            // 会被杀，但 Python 的 spider.log 缓冲、qjs-runner 的映像句柄都不
            // 走体面路径——dev 实测那个映像句柄会锁住 binaries 拷贝，下一次
            // cargo build 直接 PermissionDenied，2026-11-16 评审 P1）。
            // Exit 在所有窗口销毁后触发，此时 block_on 不会再与界面任务抢
            // runtime；两个 shutdown 自身幂等（slot 空则直接返回）。
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(async {
                    let bridge = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        bridge::shutdown(),
                    )
                    .await;
                    let runner = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        spider::quickjs::shutdown(),
                    )
                    .await;
                    // 关停失败不阻断退出：Job Object 仍是最后兜底。
                    if bridge.is_err() {
                        tracing::warn!("python adapter shutdown timed out; job object will reap it");
                    }
                    if runner.is_err() {
                        tracing::warn!("qjs-runner shutdown timed out; job object will reap it");
                    }
                });
            }
        });
}
