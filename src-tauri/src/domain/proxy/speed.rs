//! 反代吞吐表：播放器 HUD 的「缓存速度」。
//!
//! 反代是唯一知道「从源站真正下了多少字节」的地方：hls.js 读的是
//! `127.0.0.1:9978`，它自己的 `bandwidthEstimate` 量到的是本机回环速度，报出来
//! 没有意义。这里在分片转发途中累计字节数，前端每秒轮询一次 `/meter` 即可。
//!
//! 采样按固定窗口做指数平滑：单个分片往往是「猛灌一阵 → 停一会儿」，直接用
//! 瞬时值会让数字剧烈跳动；平滑后 HUD 上的读数接近用户对「下载速度」的直觉。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 两次采样之间至少隔这么久，否则窗口太短、读数会被单个分片带飞。
const SAMPLE_WINDOW: Duration = Duration::from_millis(500);

pub(crate) struct Meter {
    total: AtomicU64,
    window: AtomicU64,
    smoothed: AtomicU64,
    last: Mutex<Option<Instant>>,
}

impl Meter {
    pub(crate) fn new() -> Self {
        Self {
            total: AtomicU64::new(0),
            window: AtomicU64::new(0),
            smoothed: AtomicU64::new(0),
            last: Mutex::new(None),
        }
    }

    /// 记一段刚转发给播放器的字节（含重写后回放的头部）。
    pub(crate) fn add(&self, bytes: usize) {
        let bytes = bytes as u64;
        self.total.fetch_add(bytes, Ordering::Relaxed);
        self.window.fetch_add(bytes, Ordering::Relaxed);
    }

    /// 返回 `(平滑后的 bytes/s, 启动以来的总字节)`。
    ///
    /// 采样间隔不足时直接返回上一次的平滑值：HUD 每秒问一次，这里不该因为
    /// 上游刚好卡住半秒就把速度打到 0。
    pub(crate) fn sample(&self) -> (u64, u64) {
        let total = self.total.load(Ordering::Relaxed);
        let mut last = match self.last.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let elapsed = match *last {
            Some(previous) => now.duration_since(previous),
            None => SAMPLE_WINDOW,
        };
        if elapsed < SAMPLE_WINDOW {
            return (self.smoothed.load(Ordering::Relaxed), total);
        }
        *last = Some(now);
        let bytes = self.window.swap(0, Ordering::Relaxed);
        let instant = bytes as f64 * 1_000.0 / elapsed.as_millis().max(1) as f64;
        let previous = self.smoothed.load(Ordering::Relaxed) as f64;
        // 0.55 / 0.45：一个分片的突刺两三次采样后就磨平，起步也不会从 0 慢慢爬。
        let smoothed = if previous <= 0.0 {
            instant
        } else {
            previous * 0.55 + instant * 0.45
        };
        self.smoothed
            .store(smoothed.round() as u64, Ordering::Relaxed);
        (self.smoothed.load(Ordering::Relaxed), total)
    }
}

static METER: OnceLock<Meter> = OnceLock::new();

/// 全进程一份：同一时刻只有一个播放器在拉流，按会话分表没有收益。
pub(crate) fn meter() -> &'static Meter {
    METER.get_or_init(Meter::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_bytes_and_reports_a_positive_rate() {
        let meter = Meter::new();
        meter.add(1024);
        // 第一次采样立刻算一次，窗口按 SAMPLE_WINDOW 兜底。
        let (_, total) = meter.sample();
        assert_eq!(total, 1024);

        std::thread::sleep(SAMPLE_WINDOW + Duration::from_millis(50));
        meter.add(64 * 1024);
        let (rate, total) = meter.sample();
        assert_eq!(total, 1024 + 64 * 1024);
        assert!(rate > 0, "rate should be positive after traffic, got {rate}");
    }

    #[test]
    fn keeps_the_last_rate_between_samples() {
        let meter = Meter::new();
        meter.add(4096);
        let (first, _) = meter.sample();
        // 立刻再问：窗口未到，返回上一档平滑值而不是 0。
        let (second, _) = meter.sample();
        assert_eq!(first, second);
    }
}
