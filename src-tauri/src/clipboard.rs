//! 系统剪贴板写入。
//!
//! 为什么不直接用 `navigator.clipboard`：WebView2 在缺少用户手势/权限时会弹
//! 出 `permission-request-dialog` 并让 Promise 挂起，按钮看起来「点了没反应」。
//! 桌面应用直接写系统剪贴板更可靠，也不依赖浏览器权限。
//!
//! Windows 走 Win32 `OpenClipboard / SetClipboardData(CF_UNICODETEXT)`：无子
//! 进程、无 PowerShell 启动开销（实测 `powershell Set-Clipboard` 在 Tauri 子
//! 进程里要 40s 且可能失败），UTF-16 原生写入不会出现中文乱码。

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
use std::io::Write;
#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
use std::process::{Command, Stdio};

use crate::error::AppError;
#[cfg(not(target_os = "windows"))]
use crate::error::code;

/// 诊断 JSON 只有几 KB；上限只用于防御异常调用。
const MAX_CHARS: usize = 20_000;

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), AppError> {
    let clipped: String = text.chars().take(MAX_CHARS).collect();
    platform_copy(&clipped)
}

#[cfg(target_os = "windows")]
fn platform_copy(text: &str) -> Result<(), AppError> {
    windows_clipboard::copy(text)
}

#[cfg(target_os = "windows")]
mod windows_clipboard {
    use std::ptr;
    use std::sync::Mutex;

    use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    use crate::error::{code, AppError};

    /// 剪贴板是全局单例：并发点击「复制」时串行化，避免 OpenClipboard 互相打架。
    static LOCK: Mutex<()> = Mutex::new(());

    pub fn copy(text: &str) -> Result<(), AppError> {
        let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide.len() * std::mem::size_of::<u16>();

        unsafe {
            OpenClipboard(HWND(ptr::null_mut())).map_err(|err| {
                AppError::new(code::INTERNAL, "open clipboard failed")
                    .with_cause(err.to_string())
            })?;

            // 从这里开始无论成功失败都要 CloseClipboard，交给 Drop 保证。
            let session = ClipboardSession;
            let _ = EmptyClipboard();

            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|err| {
                AppError::new(code::INTERNAL, "clipboard alloc failed")
                    .with_cause(err.to_string())
            })?;
            let target = GlobalLock(handle);
            if target.is_null() {
                let _ = GlobalFree(handle);
                return Err(AppError::new(code::INTERNAL, "clipboard lock failed"));
            }
            ptr::copy_nonoverlapping(wide.as_ptr(), target as *mut u16, wide.len());
            let _ = GlobalUnlock(handle);

            // 成功后内存所有权归系统，不能再 GlobalFree；失败时才回收。
            match SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(handle.0)) {
                Ok(_) => {
                    drop(session);
                    Ok(())
                }
                Err(err) => {
                    let _ = GlobalFree(handle);
                    Err(AppError::new(code::INTERNAL, "clipboard set failed")
                        .with_cause(err.to_string()))
                }
            }
        }
    }

    /// 保证 `CloseClipboard` 一定执行（提前 return / panic 都能收尾）。
    struct ClipboardSession;

    impl Drop for ClipboardSession {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_copy(text: &str) -> Result<(), AppError> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|err| {
            AppError::new(code::INTERNAL, "clipboard helper failed").with_cause(err.to_string())
        })?;
    write_and_wait(&mut child, text)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_copy(text: &str) -> Result<(), AppError> {
    // Wayland 优先 wl-copy，X11 退 xclip；都没有就报错，由前端降级成手动复制。
    for (program, args) in [("wl-copy", &[][..]), ("xclip", &["-selection", "clipboard"][..])] {
        let Ok(mut child) = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .spawn()
        else {
            continue;
        };
        if write_and_wait(&mut child, text).is_ok() {
            return Ok(());
        }
    }
    Err(AppError::new(code::INTERNAL, "no clipboard tool found"))
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn write_and_wait(child: &mut std::process::Child, text: &str) -> Result<(), AppError> {
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|err| AppError::new(code::INTERNAL, "clipboard write failed").with_cause(err.to_string()))?;
    }
    let status = child
        .wait()
        .map_err(|err| AppError::new(code::INTERNAL, "clipboard helper failed").with_cause(err.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::new(code::INTERNAL, "clipboard copy failed"))
    }
}
