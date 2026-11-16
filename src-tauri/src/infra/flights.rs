//! 同 key 并发去重（single-flight）。
//!
//! 冷 key 的并发 miss 原本各自跑完整条取数链：首页一批同片名卡片同时查
//! 豆瓣、或一次 fan-out 里多个任务首次触达同一个 spider `api`，会并发发
//! N 次同样的请求（2026-11-16 评审 P1：豆瓣有令牌桶压着，py/js 的脚本
//! 下载在并发闸门外，同一脚本可能被同时下载多次）。
//!
//! 语义：同一 key 的**在途重叠**调用只跑第一次，其余等待同一个结果——
//! **包括失败**（同 fate），所以 `V` 常用 `Result<T, AppError>`（`AppError`
//! 本身 `Clone`）或 `Option<T>`。严格顺序的下一次调用会重新取数，因为条目
//! 完成后立即摘除：这里**不承载缓存语义**，TTL / 磁盘快照仍由各调用方自己管。

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;

/// 表容量上限：完成的条目会被摘掉，这里只兜「大量不同 key 同时在途」时的
/// 内存增长；超限时先清掉已完成的，仍在途的必须留着（否则又会并发跑两次）。
const CELL_CAP: usize = 512;

pub(crate) struct Flights<V> {
    cells: Mutex<HashMap<String, Arc<OnceCell<V>>>>,
}

impl<V> Default for Flights<V> {
    fn default() -> Self {
        // `HashMap::new` 不是 const fn，所以这里只能走 Default + OnceLock
        // （调用方用 `static FLIGHTS: OnceLock<Flights<..>>` 拿到 `'static`）。
        Self {
            cells: Mutex::new(HashMap::new()),
        }
    }
}

impl<V: Clone + Send + Sync + 'static> Flights<V> {
    /// 与同 key 的其它调用共享一次执行结果。
    pub(crate) async fn dedupe<F, Fut>(&self, key: &str, produce: F) -> V
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = V>,
    {
        let cell = self.claim(key);
        // 关键：不在持有 std Mutex 守卫的情况下 await（既会阻塞别的 key，
        // 也让 future 非 Send）。取到 cell 后先放锁。
        let value = cell.get_or_init(|| produce()).await;
        self.release(key, &cell);
        value.clone()
    }

    fn claim(&self, key: &str) -> Arc<OnceCell<V>> {
        let mut guard = self
            .cells
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.len() >= CELL_CAP {
            guard.retain(|_, cell| cell.get().is_none());
        }
        guard
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(OnceCell::new()))
            .clone()
    }

    /// 完成后摘除条目；只摘自己那一份（`Arc::ptr_eq`），避免把同 key 上
    /// 后来者新起的 cell 误删。
    fn release(&self, key: &str, cell: &Arc<OnceCell<V>>) {
        let mut guard = self
            .cells
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = guard.get(key) {
            if Arc::ptr_eq(existing, cell) && existing.get().is_some() {
                guard.remove(key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::OnceLock;
    use std::time::Duration;

    async fn slow(
        table: &Flights<usize>,
        runs: &AtomicUsize,
        key: &str,
        want: usize,
    ) -> usize {
        table
            .dedupe(key, || {
                runs.fetch_add(1, Ordering::SeqCst);
                async move {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    want
                }
            })
            .await
    }

    fn table<V: Clone + Send + Sync + 'static>(slot: &'static OnceLock<Flights<V>>) -> &'static Flights<V> {
        slot.get_or_init(Flights::default)
    }

    #[tokio::test]
    async fn concurrent_same_key_runs_producer_once() {
        static TABLE: OnceLock<Flights<usize>> = OnceLock::new();
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        let flights = table(&TABLE);
        RUNS.store(0, Ordering::SeqCst);
        let (a, b, c) = tokio::join!(
            slow(flights, &RUNS, "same-key", 7),
            slow(flights, &RUNS, "same-key", 7),
            slow(flights, &RUNS, "same-key", 7),
        );
        assert_eq!((a, b, c), (7, 7, 7));
        assert_eq!(RUNS.load(Ordering::SeqCst), 1, "同 key 并发只应跑一次取数");
    }

    #[tokio::test]
    async fn different_keys_are_not_merged() {
        static TABLE: OnceLock<Flights<usize>> = OnceLock::new();
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        let flights = table(&TABLE);
        RUNS.store(0, Ordering::SeqCst);
        let (a, b) = tokio::join!(
            slow(flights, &RUNS, "key-a", 1),
            slow(flights, &RUNS, "key-b", 2),
        );
        assert_eq!((a, b), (1, 2));
        assert_eq!(RUNS.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn entry_is_dropped_after_completion_so_next_call_refetches() {
        static TABLE: OnceLock<Flights<usize>> = OnceLock::new();
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        let flights = table(&TABLE);
        RUNS.store(0, Ordering::SeqCst);
        assert_eq!(slow(flights, &RUNS, "ephemeral", 3).await, 3);
        assert_eq!(slow(flights, &RUNS, "ephemeral", 4).await, 4);
        assert_eq!(RUNS.load(Ordering::SeqCst), 2, "完成后不残留：下次重新取数");
    }

    #[tokio::test]
    async fn failure_is_shared_by_fate_not_retried_per_waiter() {
        static TABLE: OnceLock<Flights<Option<u32>>> = OnceLock::new();
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        let flights = table(&TABLE);
        RUNS.store(0, Ordering::SeqCst);
        // 生产者必须「在途」（有 await 点），两个调用者才真的重叠：
        // 若第一个立刻完成，条目已被摘除，第二个本来就该重新取数——那是
        // 顺序调用，不是并发。
        let leader = flights.dedupe("boom", || {
            RUNS.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                None
            }
        });
        let follower = flights.dedupe("boom", || {
            RUNS.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Some(9)
            }
        });
        let (a, b) = tokio::join!(leader, follower);
        assert!(a.is_none() && b.is_none(), "同 fate：失败结果也被共享");
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn error_result_is_shared_between_overlapping_callers() {
        // py/js 通道的真实用法：`Result<String, AppError>` 直接当 V
        // （AppError 本身是 Clone 的），并发重叠的调用者拿到同一个错误，
        // 而之后的调用仍会重试（去重不等于缓存）。
        static TABLE: OnceLock<Flights<Result<String, String>>> = OnceLock::new();
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        let flights = table(&TABLE);
        RUNS.store(0, Ordering::SeqCst);
        let failing = || {
            RUNS.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Err("network down".to_string())
            }
        };
        let other = || {
            RUNS.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok("should not run".to_string())
            }
        };
        let (a, b) = tokio::join!(flights.dedupe("api-url", failing), flights.dedupe("api-url", other));
        assert_eq!(a, Err("network down".to_string()));
        assert_eq!(b, Err("network down".to_string()), "同 fate：错误也被共享");
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
        // 下一次调用重新尝试。
        let again = flights
            .dedupe("api-url", || {
                RUNS.fetch_add(1, Ordering::SeqCst);
                async { Ok("later ok".to_string()) }
            })
            .await;
        assert_eq!(again, Ok("later ok".to_string()));
        assert_eq!(RUNS.load(Ordering::SeqCst), 2);
    }
}
