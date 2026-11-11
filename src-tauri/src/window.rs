//! 窗口外观：把 Windows 标题栏刷成与主界面一致的深色。
//!
//! `tauri.conf.json` 的 `theme: Dark` 只是让系统用深色标题栏（Win11 约
//! `#202020`），与画布 `#0b0d12` 仍有明显色差。这里用 DWM 精确指定：
//!   - `DWMWA_USE_IMMERSIVE_DARK_MODE`：Win10 1809+ 的深色标题栏；
//!   - `DWMWA_CAPTION_COLOR` / `TEXT_COLOR` / `BORDER_COLOR`：Win11 2215+
//!     支持的自定义颜色，旧系统会返回错误，直接忽略即可。
//!
//! 颜色必须与 `src/styles.css` 的 `--bg` / `--text` / `--border` 同步；
//! 改设计 token 时记得同时改这里（或把值提到编译期常量）。

#[cfg(target_os = "windows")]
pub fn apply_dark_caption(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    let Ok(raw) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(raw.0 as *mut core::ffi::c_void);

    // COLORREF 是 0x00BBGGRR，与 CSS 的 #RRGGBB 字节序相反。
    let colorref = |r: u32, g: u32, b: u32| r | (g << 8) | (b << 16);
    let caption = colorref(0x0b, 0x0d, 0x12); // --bg
    let text = colorref(0xe9, 0xed, 0xf5); // --text
    let border = colorref(0x22, 0x2a, 0x37); // --border

    unsafe {
        let dark: u32 = 1;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        for (attribute, value) in [
            (DWMWA_CAPTION_COLOR, caption),
            (DWMWA_TEXT_COLOR, text),
            (DWMWA_BORDER_COLOR, border),
        ] {
            let _ = DwmSetWindowAttribute(
                hwnd,
                attribute,
                &value as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn apply_dark_caption(_window: &tauri::WebviewWindow) {}
