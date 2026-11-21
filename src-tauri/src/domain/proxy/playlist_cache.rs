//! m3u8 最近成功清单的内存缓存。
//!
//! 只用于「上游这一下失败」时的兜底：正常路径仍然每次回源，保证直播清单能刷新。
//! 缓存的是已经重写过分片 URI / headers 的清单，所以 key 必须包含代理端口与
//! 透传参数——换通道（端口不同）或换 UA / Referer 后不能混用。

use super::*;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 单条清单的容量上限。清单被 `read_capped` 限制在 8 MB，64 条最坏也只占几百 KB
/// 到几 MB（正常清单只有几十 KB）；64 足以覆盖连续换台/换源的操作窗口。
const MAX_ENTRIES: usize = 64;
/// 超过这个年龄的旧清单不再回退：直播分片会过期，太久的清单只会制造更多 404。
const MAX_STALE_AGE: Duration = Duration::from_secs(30 * 60);

struct Entry {
    rewritten: String,
    stored_at: Instant,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, Entry>,
    order: Vec<String>,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}

/// 缓存键：目标 URL + 代理端口（重写后的 URI 带端口）+ 透传头。
pub(super) fn key(target: &Url, port: u16, fwd: &Fwd) -> String {
    format!("{}|{}|{}", target.as_str(), port, fwd.suffix())
}

/** 记住一份成功解析并重写过的清单；同 key 重复写入只刷新时间戳。 */
pub(super) fn remember(key: String, rewritten: String) {
    let mut guard = match cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if !guard.entries.contains_key(&key) {
        guard.order.push(key.clone());
    }
    guard.entries.insert(
        key,
        Entry {
            rewritten,
            stored_at: Instant::now(),
        },
    );
    while guard.order.len() > MAX_ENTRIES {
        if let Some(oldest) = guard.order.first().cloned() {
            guard.order.remove(0);
            guard.entries.remove(&oldest);
        }
    }
}

/**
 * 取一份仍可回退的旧清单。过期条目顺手清掉，不让失效数据长期占着缓存。
 */
pub(super) fn stale(key: &str) -> Option<String> {
    let mut guard = match cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let expired = guard
        .entries
        .get(key)
        .is_some_and(|entry| entry.stored_at.elapsed() > MAX_STALE_AGE);
    if expired {
        guard.order.retain(|item| item != key);
        guard.entries.remove(key);
        return None;
    }
    guard.entries.get(key).map(|entry| entry.rewritten.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_and_serves_stale_playlist() {
        let target = Url::parse("https://cdn.example/live/playlist.m3u8").unwrap();
        let fwd = Fwd::default();
        let key = key(&target, 9978, &fwd);
        remember(key.clone(), "#EXTM3U\nseg.ts\n".to_string());
        assert_eq!(stale(&key).as_deref(), Some("#EXTM3U\nseg.ts\n"));
    }

    #[test]
    fn keys_include_port_and_forwarded_headers() {
        let target = Url::parse("https://cdn.example/live/playlist.m3u8").unwrap();
        let base = Fwd::default();
        let ua = Fwd {
            ua: Some("okhttp/3.15".into()),
            ..Fwd::default()
        };
        assert_ne!(key(&target, 9978, &base), key(&target, 9979, &base));
        assert_ne!(key(&target, 9978, &base), key(&target, 9978, &ua));
    }
}
