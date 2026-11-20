//! 发布通道：`stable` / `beta` / `dev`。
//!
//! 身份与版本同源，都来自 `package.json`：
//!
//! ```text
//! appId       = app.luma           （identifier 的前缀，build.rs 注入）
//! version     = 2.0.0              （tauri.conf.json 指向它，安装器跟着走）
//! productName = Luma               （安装目录 / 开始菜单）
//! ```
//!
//! 通道只由构建命令行参数决定（`pnpm build:beta`），`tools/tauri_cli.mjs` 按
//! `appId + 后缀` 生成 overlay。运行时代码不写死 identifier，也不猜版本：
//!
//! ```text
//! identifier = appId + suffix      （stable ""、beta ".beta"、dev ".dev"）
//! ```
//!
//! `debug_assertions` 优先于 identifier——`tauri build --debug` 也带调试断言，
//! 它产出的是调试包，不该因为 identifier 是正式名就冒充 stable。
//!
//! 通道隔离的只有身份相关的东西：数据目录（直接用 identifier）、反代固定端口、
//! 窗口标题与侧栏徽标。配置格式、数据库 schema 不按通道分叉。
//!
//! dev 只服务日常调试（`tauri dev`），不出安装包；beta 按需启用（预发布时才用
//! `build:beta` 出包），stable 才是常驻交付通道。

use std::sync::OnceLock;

/// build.rs 从 `package.json` 的 `appId` 注入；缺失时按包名派生。
const APP_ID: &str = env!("LUMA_APP_ID");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
    Dev,
}

static CHANNEL: OnceLock<Channel> = OnceLock::new();
static IDENTIFIER: OnceLock<String> = OnceLock::new();

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
            Channel::Dev => "dev",
        }
    }

    /// identifier 后缀：stable 不加，beta/dev 各自一段。
    fn suffix(self) -> &'static str {
        match self {
            Channel::Stable => "",
            Channel::Beta => ".beta",
            Channel::Dev => ".dev",
        }
    }

    /// 标题/徽标的展示名；stable 不配 label，正式包看起来才不像预发布。
    pub fn label(self) -> Option<&'static str> {
        match self {
            Channel::Stable => None,
            Channel::Beta => Some("Beta"),
            Channel::Dev => Some("Dev"),
        }
    }

    /// 反代固定端口。三通道同时驻留时各自有固定端口，不靠「被占再退临时端口」，
    /// 否则 py/js 侧按默认端口兜底会指向另一个实例。
    pub fn proxy_port(self) -> u16 {
        match self {
            Channel::Stable => 9978,
            Channel::Beta => 9977,
            Channel::Dev => 9979,
        }
    }
}

/// `appId + suffix`：构建脚本注入的 identifier 与数据目录名都由它派生。
pub fn identifier_for(channel: Channel) -> String {
    format!("{APP_ID}{}", channel.suffix())
}

/// 按派生值精确匹配，不做字符串后缀猜测——`app.luma.devil` 不会被认成 dev。
pub fn from_identifier(identifier: &str) -> Channel {
    [Channel::Stable, Channel::Beta, Channel::Dev]
        .into_iter()
        .find(|channel| identifier_for(*channel) == identifier)
        .unwrap_or(Channel::Stable)
}

/// 进程启动时发布一次。重复调用返回首次的值（诊断要知道真实来源）。
pub fn init(identifier: &str) -> Channel {
    let _ = IDENTIFIER.set(identifier.trim().to_string());
    *CHANNEL.get_or_init(|| {
        if cfg!(debug_assertions) {
            Channel::Dev
        } else {
            from_identifier(identifier)
        }
    })
}

/// 当前通道。未初始化（单测、工具直接调用）时按构建类型回退，绝不返回错通道。
pub fn current() -> Channel {
    *CHANNEL.get_or_init(|| {
        if cfg!(debug_assertions) {
            Channel::Dev
        } else {
            Channel::Stable
        }
    })
}

/// 数据目录名 = identifier（`%APPDATA%\app.luma[.beta|.dev]`），与系统里看到的
/// 包身份同名。未初始化时按构建类型回退到派生值，单测/工具直接调用也不会拿错目录。
pub fn data_dir_name() -> &'static str {
    IDENTIFIER
        .get()
        .map(String::as_str)
        .unwrap_or_else(fallback_data_dir)
}

fn fallback_data_dir() -> &'static str {
    static FALLBACK: OnceLock<String> = OnceLock::new();
    FALLBACK
        .get_or_init(|| {
            identifier_for(if cfg!(debug_assertions) {
                Channel::Dev
            } else {
                Channel::Stable
            })
        })
        .as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_are_derived_from_app_id() {
        assert_eq!(identifier_for(Channel::Stable), APP_ID);
        for channel in [Channel::Stable, Channel::Beta, Channel::Dev] {
            let derived = identifier_for(channel);
            assert_eq!(from_identifier(&derived), channel);
        }
    }

    #[test]
    fn lookalike_names_do_not_select_a_channel() {
        assert_eq!(from_identifier("app.luma.devil"), Channel::Stable);
        assert_eq!(from_identifier("other.luma.dev"), Channel::Stable);
    }

    #[test]
    fn ports_are_distinct_per_channel() {
        let ports: Vec<_> = [Channel::Stable, Channel::Beta, Channel::Dev]
            .iter()
            .map(|c| c.proxy_port())
            .collect();
        assert_eq!(ports, [9978, 9977, 9979]);
        assert_eq!(
            ports.iter().collect::<std::collections::HashSet<_>>().len(),
            ports.len()
        );
    }

    #[test]
    fn only_stable_has_no_label() {
        assert_eq!(Channel::Stable.label(), None);
        assert_eq!(Channel::Beta.label(), Some("Beta"));
        assert_eq!(Channel::Dev.label(), Some("Dev"));
    }

    #[test]
    fn data_dir_name_falls_back_to_channel_identifier() {
        let expected = identifier_for(if cfg!(debug_assertions) {
            Channel::Dev
        } else {
            Channel::Stable
        });
        assert_eq!(data_dir_name(), expected);
    }
}