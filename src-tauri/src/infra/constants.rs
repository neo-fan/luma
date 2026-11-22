//! 跨模块共享的业务常量（后端唯一真源）。
//!
//! 收录标准：同一语义被两个以上模块用到，或作为对外暴露的缺省值。模块内专用
//! 常量（如 douban 的匹配分值、window 的配色 RGB）留在各自模块，避免大杂烩。
//!
//! 注意「同值不同义」：这里刻意不为所有 15_000 建同一个常量——搜索总预算的
//! 上限与单站超时上限是两件事，改一个不该连带改另一个。

// ---- 站点请求 / 聚合 ----

/// 站点请求缺省超时（配置未写 timeout、spider 调用未给值时共用）。
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// 聚合搜索的最大并发扇出。
pub const MAX_FANOUT: usize = 20;
/// 聚合搜索总预算的下限（站点数少时不至于把单站超时直接当总预算）。
pub const SEARCH_BUDGET_MIN_MS: u64 = 8_000;
/// 聚合搜索总预算的上限。
pub const SEARCH_BUDGET_MAX_MS: u64 = 30_000;
/// 单站超时下限：低于 2s 源根本来不及响应。
pub const SITE_TIMEOUT_MIN_MS: u64 = 2_000;
/// 单站超时上限：高于 15s 用户等不起。
pub const SITE_TIMEOUT_MAX_MS: u64 = 15_000;
/// 体检的缺省单站超时（比聚合搜索宽松，要覆盖尽可能多的站）。
pub const HEALTH_DEFAULT_TIMEOUT_MS: u64 = 8_000;
/// 体检总预算硬上限，避免一堆死源让体检页一直转。
pub const HEALTH_BUDGET_MAX_MS: u64 = 45_000;

// ---- 存储 ----

/// 播放记录保留上限（超出按 updated_at 淘汰最早的非收藏项）。
pub const MAX_HISTORY: usize = 500;

#[cfg(test)]
mod tests {
    use super::*;

    /// 夹逼区间必须自洽，否则 clamp 会静默返回错误的边界值。
    #[test]
    fn timeout_bounds_are_ordered() {
        assert!(SITE_TIMEOUT_MIN_MS < SITE_TIMEOUT_MAX_MS);
        assert!(SITE_TIMEOUT_MAX_MS == DEFAULT_TIMEOUT_MS);
        assert!(SEARCH_BUDGET_MIN_MS < SEARCH_BUDGET_MAX_MS);
        assert!(HEALTH_DEFAULT_TIMEOUT_MS >= SEARCH_BUDGET_MIN_MS);
        assert!(HEALTH_BUDGET_MAX_MS > SEARCH_BUDGET_MIN_MS);
    }

    /// 这些值被 spider / config / db 通过 re-export 使用，改值即改全局行为。
    #[test]
    fn shared_constants_keep_expected_values() {
        assert_eq!(DEFAULT_TIMEOUT_MS, 15_000);
        assert_eq!(MAX_FANOUT, 20);
        assert_eq!(MAX_HISTORY, 500);
        assert_eq!(SITE_TIMEOUT_MIN_MS, 2_000);
        assert_eq!(SEARCH_BUDGET_MAX_MS, 30_000);
        assert_eq!(HEALTH_BUDGET_MAX_MS, 45_000);
    }
}
