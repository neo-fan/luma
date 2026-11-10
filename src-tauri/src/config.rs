//! Configuration import and snapshot store (spec T-05).
//!
//! Parsing/decrypt/normalization stay in `sidecars/py`; this module only
//! fetches payloads, forwards them to the adapter and keeps snapshots.

use crate::bridge;
use crate::error::{code, AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::RwLock;
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REPOS: usize = 20;
/// Persisted id of the config the user last imported. Without this a restart
/// guesses "last entry in read_dir order", which is filesystem-dependent and
/// can silently select an empty test config while the UI still shows the
/// previously cached site list (fan-out then searches zero sites).
const ACTIVE_FILE: &str = "active.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSource {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub id: String,
    pub name: String,
    pub imported_at: String,
    pub sites: Vec<Value>,
    #[serde(default)]
    pub lives: Vec<Value>,
    #[serde(default)]
    pub parses: Vec<Value>,
    /// Per-host request headers (TVBox top-level `headers`), used by the local
    /// proxy and playback so anti-leech CDNs see their expected UA/Referer.
    #[serde(default)]
    pub headers: Vec<Value>,
    #[serde(default)]
    pub spider: Option<String>,
    #[serde(default)]
    pub wallpaper: Option<String>,
    #[serde(default)]
    pub flags: Vec<Value>,
    #[serde(default, rename = "_raw")]
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMeta {
    pub id: String,
    pub name: String,
    pub source: ConfigSource,
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredConfig {
    snapshot: ConfigSnapshot,
    source: ConfigSource,
}

#[derive(Default)]
pub struct ConfigStore {
    entries: RwLock<Vec<StoredConfig>>,
    /// The config last imported by the user; fan-out only uses its sites.
    active: RwLock<Option<String>>,
}

impl ConfigStore {
    /// Restore snapshots persisted under `<data dir>/configs` (T-12).
    pub fn load() -> Self {
        let dir = crate::store::data_dir().join("configs");
        let mut entries = Vec::new();
        if let Ok(read_dir) = std::fs::read_dir(&dir) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if let Ok(stored) = serde_json::from_str::<StoredConfig>(&text) {
                        entries.push(stored);
                    }
                }
            }
        }
        // `active.json` is authoritative. For data written before it existed,
        // fall back to the most recently imported snapshot: `read_dir` order is
        // filesystem-dependent and can land on an empty test config, making
        // every fan-out search run zero sites while the UI shows cached sites.
        let active = std::fs::read_to_string(Self::active_path())
            .ok()
            .map(|text| text.trim().to_string())
            .filter(|id| entries.iter().any(|entry| entry.snapshot.id == *id))
            .or_else(|| newest_id(&entries));
        Self::persist_active(active.as_deref());
        let store = Self {
            entries: RwLock::new(entries),
            active: RwLock::new(active),
        };
        // Publish the restored config's host header table; otherwise the first
        // playback after a restart loses the anti-leech headers.
        if let Some(snapshot) = store.active_snapshot() {
            crate::netrules::replace(&snapshot.headers);
        }
        store
    }

    fn dir() -> std::path::PathBuf {
        crate::store::data_dir().join("configs")
    }

    fn active_path() -> std::path::PathBuf {
        crate::store::data_dir().join(ACTIVE_FILE)
    }

    fn persist_active(id: Option<&str>) {
        let path = Self::active_path();
        match id {
            Some(id) => {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&path, id);
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    fn persist(&self, stored: &StoredConfig) {
        let dir = Self::dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(text) = serde_json::to_string(stored) {
            let _ = std::fs::write(dir.join(format!("{}.json", stored.snapshot.id)), text);
        }
    }

    pub fn insert(&self, snapshot: ConfigSnapshot, source: ConfigSource) {
        // Keep only the small fields we still need, then move the snapshot into
        // the store. It used to be cloned twice here (raw config JSON included),
        // which is expensive for configs with hundreds of sites.
        let id = snapshot.id.clone();
        let headers = snapshot.headers.clone();
        let stored = StoredConfig { snapshot, source };
        self.persist(&stored);
        {
            let mut guard = self.entries.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.retain(|entry| entry.snapshot.id != id);
            guard.push(stored);
        }
        // Importing a config switches the active one, otherwise stale sites
        // (fixtures, dead repos) keep showing up in every fan-out search.
        *self.active.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id.clone());
        Self::persist_active(Some(&id));
        crate::netrules::replace(&headers);
    }

    pub fn list(&self) -> Vec<ConfigMeta> {
        let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .iter()
            .map(|entry| ConfigMeta {
                id: entry.snapshot.id.clone(),
                name: entry.snapshot.name.clone(),
                source: entry.source.clone(),
                imported_at: entry.snapshot.imported_at.clone(),
            })
            .collect()
    }

    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        let mut guard = self.entries.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = guard.len();
        guard.retain(|entry| entry.snapshot.id != id);
        if guard.len() == before {
            return Err(AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found")));
        }
        let next_active = guard.last().map(|entry| entry.snapshot.id.clone());
        drop(guard);
        // Only now touch `active`, and only if it pointed at the removed entry.
        // `all_sites` acquires active then entries; taking them in the opposite
        // order (or overlapping) lets the two callers deadlock.
        let was_active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_deref()
            == Some(id);
        if was_active {
            Self::persist_active(next_active.as_deref());
            *self.active.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = next_active;
        }
        let _ = std::fs::remove_file(Self::dir().join(format!("{id}.json")));
        if let Some(snapshot) = self.active_snapshot() {
            crate::netrules::replace(&snapshot.headers);
        }
        Ok(())
    }

    pub fn find_site(&self, site_key: &str) -> Result<Value, AppError> {
        let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in guard.iter() {
            for site in &entry.snapshot.sites {
                if site.get("key").and_then(Value::as_str) == Some(site_key) {
                    return Ok(site.clone());
                }
            }
        }
        Err(AppError::new(
            code::INVALID_ARGUMENT,
            format!("site {site_key} not found"),
        ))
    }

    /// Snapshot of the active config (falls back to the last imported one).
    ///
    /// `parses`/`flags` live at config level, not per site, so playback needs
    /// this rather than `find_site`.
    pub fn active_snapshot(&self) -> Option<ConfigSnapshot> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        pick(active.as_deref(), guard.as_slice()).map(|entry| entry.snapshot.clone())
    }

    /// Just the config-level `parses[]` pool. `parse_resolve` runs on every
    /// play attempt; cloning the whole snapshot there would also copy the raw
    /// config JSON (hundreds of KB) for a field nobody looks at.
    pub fn active_parses(&self) -> Vec<Value> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        pick(active.as_deref(), guard.as_slice())
            .map(|entry| entry.snapshot.parses.clone())
            .unwrap_or_default()
    }

    /// Sites of the active config, de-duplicated by key (first wins).
    ///
    /// Old snapshots must not leak into the current config's fan-out: a
    /// previously imported stub/dead config would otherwise add dozens of
    /// doomed requests to every search. Falls back to all configs only when
    /// the active id is missing (e.g. hand-written test fixtures).
    pub fn all_sites(&self) -> Vec<Value> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        let has_active = active
            .as_ref()
            .map(|id| guard.iter().any(|entry| &entry.snapshot.id == id))
            .unwrap_or(false);

        // Borrow the keys for de-duplication: no need to allocate a String per
        // site just to test membership in the set.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut out = Vec::new();
        for entry in guard.iter() {
            if has_active && active.as_deref() != Some(entry.snapshot.id.as_str()) {
                continue;
            }
            for site in &entry.snapshot.sites {
                let key = site.get("key").and_then(Value::as_str).unwrap_or("");
                if key.is_empty() || !seen.insert(key) {
                    continue;
                }
                out.push(site.clone());
            }
        }
        out
    }
}

/// Fallback for data written before `active.json` existed: the most recently
/// imported snapshot wins, not the last entry returned by `read_dir`.
fn newest_id(entries: &[StoredConfig]) -> Option<String> {
    entries
        .iter()
        .max_by(|a, b| a.snapshot.imported_at.cmp(&b.snapshot.imported_at))
        .map(|entry| entry.snapshot.id.clone())
}

/// Pick the active entry, or the most recently imported one when the active id
/// is missing (hand-written fixtures). `active_snapshot` and `active_parses`
/// must agree on this rule.
fn pick<'a>(active: Option<&str>, entries: &'a [StoredConfig]) -> Option<&'a StoredConfig> {
    entries
        .iter()
        .find(|entry| active == Some(entry.snapshot.id.as_str()))
        .or_else(|| entries.last())
}

async fn fetch_text(url: &str) -> Result<String, AppError> {
    // Reuse the process-wide client so config imports share the same redirect
    // policy and connection pool as every other outbound request.
    let response = crate::http::shared_client()?
        .get(url)
        .timeout(FETCH_TIMEOUT)
        .header(reqwest::header::USER_AGENT, crate::netrules::DEFAULT_UA)
        .send()
        .await
        .map_err(|err| {
            AppError::new(code::CONFIG_FETCH_FAIL, format!("fetch {url} failed"))
                .with_cause(err.to_string())
        })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            code::CONFIG_FETCH_FAIL,
            format!("fetch {url} -> {}", response.status()),
        ));
    }
    response.text().await.map_err(|err| {
        AppError::new(code::CONFIG_FETCH_FAIL, "read body failed").with_cause(err.to_string())
    })
}

pub async fn import_from_source(source: ConfigSource) -> Result<ConfigSnapshot, AppError> {
    let (raw, origin) = match source.kind.as_str() {
        "url" => (fetch_text(&source.value).await?, source.value.clone()),
        "file" => (
            std::fs::read_to_string(&source.value).map_err(|err| {
                AppError::new(code::CONFIG_FETCH_FAIL, "read config file failed")
                    .with_cause(err.to_string())
            })?,
            source.value.clone(),
        ),
        "text" => (source.value.clone(), "inline".to_string()),
        other => {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                format!("unknown source kind: {other}"),
            ))
        }
    };
    import_from_raw(&raw, &origin).await
}

pub async fn import_from_raw(raw: &str, origin: &str) -> Result<ConfigSnapshot, AppError> {
    let decrypted = bridge::call("config.decrypt", json!({ "raw": raw })).await?;
    let plain = decrypted
        .get("plain")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new(code::CONFIG_DECRYPT_FAIL, "adapter returned no plain text"))?
        .to_string();

    let parsed: Value = serde_json::from_str(&plain).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "decrypted payload is not json")
            .with_cause(err.to_string())
    })?;

    if let Some(items) = parsed.get("urls").and_then(Value::as_array) {
        return import_repos(items).await;
    }
    normalize_plain(&plain, origin).await
}

async fn import_repos(items: &[Value]) -> Result<ConfigSnapshot, AppError> {
    let mut set = tokio::task::JoinSet::new();
    for item in items.iter().take(MAX_REPOS) {
        let url = item
            .as_str()
            .map(str::to_string)
            .or_else(|| item.get("url").and_then(Value::as_str).map(str::to_string));
        let Some(url) = url else { continue };
        set.spawn(async move { import_url_snapshot(url).await });
    }

    let mut snapshots = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Ok(snapshot)) = joined {
            snapshots.push(snapshot);
        }
    }
    if snapshots.is_empty() {
        return Err(AppError::new(code::CONFIG_FETCH_FAIL, "all repos failed"));
    }

    let merged = bridge::call("config.mergeRepos", json!({ "snapshots": snapshots })).await?;
    serde_json::from_value(merged).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "merged snapshot shape mismatch")
            .with_cause(err.to_string())
    })
}

async fn import_url_snapshot(url: String) -> Result<Value, AppError> {
    let raw = fetch_text(&url).await?;
    let decrypted = bridge::call("config.decrypt", json!({ "raw": raw })).await?;
    let plain = decrypted
        .get("plain")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new(code::CONFIG_DECRYPT_FAIL, format!("repo {url} decrypt failed")))?;
    bridge::call("config.normalize", json!({ "raw": plain, "origin": url })).await
}

async fn normalize_plain(plain: &str, origin: &str) -> Result<ConfigSnapshot, AppError> {
    let value = bridge::call("config.normalize", json!({ "raw": plain, "origin": origin })).await?;
    serde_json::from_value(value).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "snapshot shape mismatch").with_cause(err.to_string())
    })
}

#[tauri::command]
pub async fn config_import(
    state: tauri::State<'_, ConfigStore>,
    source: ConfigSource,
) -> Result<ConfigSnapshot, AppError> {
    let snapshot = import_from_source(source.clone()).await?;
    state.insert(snapshot.clone(), source);
    Ok(snapshot)
}

#[tauri::command]
pub fn config_list(state: tauri::State<'_, ConfigStore>) -> Result<Vec<ConfigMeta>, AppError> {
    Ok(state.list())
}

/// The active snapshot as the Rust side sees it. The frontend calls this on
/// startup so its localStorage site cache can never disagree with fan-out.
#[tauri::command]
pub fn config_active(state: tauri::State<'_, ConfigStore>) -> Option<ConfigSnapshot> {
    state.active_snapshot()
}

#[tauri::command]
pub fn config_remove(state: tauri::State<'_, ConfigStore>, id: String) -> Result<(), AppError> {
    state.remove(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: &str, keys: &[&str]) -> ConfigSnapshot {
        let sites: Vec<Value> = keys
            .iter()
            .map(|key| json!({ "key": key, "name": key }))
            .collect();
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "importedAt": "2026-01-01T00:00:00Z",
            "sites": sites,
        }))
        .expect("snapshot fixture")
    }

    /// `insert`/`remove` persist to `data_dir()`. Point that at a temp dir so
    /// unit tests never leave an `old.json` (or a bogus active marker) in the
    /// user's real config directory.
    fn isolate_data_dir() {
        let dir = std::env::temp_dir().join(format!("tvbox-config-test-{}", std::process::id()));
        std::env::set_var("TVBOX_DATA_DIR", &dir);
    }

    #[test]
    fn fanout_is_scoped_to_the_active_config() {
        isolate_data_dir();
        let store = ConfigStore::default();
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
        };
        store.insert(snapshot("old", &["stub_a"]), source.clone());
        assert_eq!(store.all_sites().len(), 1);

        store.insert(snapshot("new", &["real_a", "real_b"]), source);
        let keys: Vec<String> = store
            .all_sites()
            .iter()
            .filter_map(|site| site.get("key").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(keys, vec!["real_a".to_string(), "real_b".to_string()]);
        // Detail/playback lookups stay global: an old favourite must still open.
        assert!(store.find_site("stub_a").is_ok());

        store.remove("new").expect("remove active config");
        assert_eq!(store.all_sites().len(), 1, "active falls back to the remaining config");
    }

    #[test]
    fn newest_import_wins_over_read_dir_order() {
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
        };
        let mut stale = snapshot("old", &["stub_a"]);
        stale.imported_at = "2026-01-01T00:00:00Z".into();
        let mut current = snapshot("box", &["real_a", "real_b"]);
        current.imported_at = "2026-11-10T09:14:17Z".into();
        // Deliberately put the stale entry last: that is exactly how read_dir
        // ordered `old.json` after the real config on this machine.
        let entries = vec![
            StoredConfig {
                snapshot: current,
                source: source.clone(),
            },
            StoredConfig {
                snapshot: stale,
                source,
            },
        ];
        assert_eq!(newest_id(&entries).as_deref(), Some("box"));
    }
}
