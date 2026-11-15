//! 进程启动时刻（epoch 秒）。
//!
//! 界面上的 build 号统一取这个值，而不是各自取「构建时刻」：`tauri dev` 下前端
//! （Vite 起 dev server）与后端（cargo 编译）的构建时刻必然不同，设置页里分两行
//! 显示永远对不上；换成「本次启动时刻」后一个进程只有一个值，前端侧栏与设置页
//! 读的是同一个 `Diagnostics::started_at`。
//!
//! 记录时机在 `run()` 的最前面（早于 WebView、日志与 sidecar），因此它不依赖任何
//! 初始化结果，也不会被 cargo 缓存影响，重启一次就换一个新值。

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static STARTED_AT: OnceLock<u64> = OnceLock::new();

/// 记录进程启动时刻。`run()` 内尽早调用；重复调用无副作用（重复调用保留首次值）。
pub fn mark() {
    STARTED_AT.get_or_init(epoch_now);
}

/// 进程启动时刻（epoch 秒）。未显式 `mark()`（例如单测直接调用）时回退当前时刻，
/// 保证诊断字段永远有值。
pub fn epoch_secs() -> u64 {
    *STARTED_AT.get_or_init(epoch_now)
}

fn epoch_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_is_idempotent_and_returns_a_plausible_epoch() {
        mark();
        let first = epoch_secs();
        mark();
        assert_eq!(first, epoch_secs(), "第二次 mark 不能改写启动时刻");
        // 2024-01-01 之后的秒级时间戳：防止 shell 里手算成毫秒。
        assert!(first > 1_704_067_200, "启动时刻看起来不像 epoch 秒: {first}");
    }
}
