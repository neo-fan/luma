//! 窗口外观：把 Windows 原生标题栏刷成与画布完全同色。
//!
//! 为什么需要：`tauri.conf.json` 的 `theme: Dark` 只能让系统用「深色标题栏」
//! （Win11 是 `#202020` 一档的灰），和画布 `#0a0a0b` 摆在一起会明显分层——
//! 顶部一条更亮的灰，像嵌了别人的窗口。这里用 DWM 精确指定颜色：
//!   - `DWMWA_USE_IMMERSIVE_DARK_MODE`：Win10 1809+ 的深色标题栏；
//!   - `DWMWA_CAPTION_COLOR` / `DWMWA_TEXT_COLOR` / `DWMWA_BORDER_COLOR`：
//!     Win11 22000+ 支持的自定义颜色。
//!
//! **颜色是设计 token 的镜像**：改 `src/styles.css` 的 `--bg` / `--text` /
//! `--border` 时必须同步下面三个常量，否则又会出现「标题栏和主题不一样」。
//! 集成测试 `tests/window_tokens.rs` 会读 CSS 做一致性校验，漏改即失败。

/// 标题栏底色：与 `--bg` 一致。
pub const CAPTION_RGB: (u8, u8, u8) = (0x0a, 0x0a, 0x0b);
/// 标题栏文字（"Luma" 与最小化/最大化/关闭按钮）：与 `--text` 一致。
pub const CAPTION_TEXT_RGB: (u8, u8, u8) = (0xed, 0xed, 0xef);
/// 窗口边框（细一圈的分隔线）：与 `--border` 一致。
pub const CAPTION_BORDER_RGB: (u8, u8, u8) = (0x23, 0x23, 0x26);

#[cfg(target_os = "windows")]
mod imp {
    use super::{CAPTION_BORDER_RGB, CAPTION_RGB, CAPTION_TEXT_RGB};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    /// COLORREF 是 0x00BBGGRR，与 CSS 的 #RRGGBB 字节序相反。
    const fn colorref(rgb: (u8, u8, u8)) -> u32 {
        (rgb.0 as u32) | ((rgb.1 as u32) << 8) | ((rgb.2 as u32) << 16)
    }

    pub fn apply(window: &tauri::WebviewWindow) {
        let Ok(raw) = window.hwnd() else {
            tracing::warn!("caption: window has no hwnd yet, skip");
            return;
        };
        let hwnd = HWND(raw.0 as *mut core::ffi::c_void);

        unsafe {
            let dark: u32 = 1;
            let hr = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &dark as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            if hr.is_err() {
                // Win10 1809 以前没有这个属性：只影响观感，不值得中断启动。
                tracing::warn!(?hr, "caption: immersive dark mode unavailable");
            }

            // 旧系统（Win10 / 早期 Win11）不认这三个属性，会返回
            // E_INVALIDARG；逐个记日志，避免「颜色没生效」只能靠肉眼猜。
            for (name, attribute, rgb) in [
                ("caption", DWMWA_CAPTION_COLOR, CAPTION_RGB),
                ("text", DWMWA_TEXT_COLOR, CAPTION_TEXT_RGB),
                ("border", DWMWA_BORDER_COLOR, CAPTION_BORDER_RGB),
            ] {
                let value = colorref(rgb);
                let hr = DwmSetWindowAttribute(
                    hwnd,
                    attribute,
                    &value as *const u32 as *const core::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                );
                if hr.is_err() {
                    tracing::warn!(?hr, part = name, "caption: custom color rejected");
                } else {
                    tracing::info!(part = name, color = ?rgb, "caption color applied");
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn apply_dark_caption(window: &tauri::WebviewWindow) {
    imp::apply(window);

    // 首次绘制之后再刷一遍：少数系统会在窗口 show / 主题切换时把标题栏
    // 重置回系统默认色，表现为「刚启动是对的、切一下窗口又变灰」。
    let retry = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        imp::apply(&retry);
    });
}

#[cfg(not(target_os = "windows"))]
pub fn apply_dark_caption(_window: &tauri::WebviewWindow) {}
