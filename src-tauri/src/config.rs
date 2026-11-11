//! Configuration import and snapshot store (spec T-05).
//!
//! Parsing/decrypt/normalization stay in `sidecars/py`; this module only
//! fetches payloads, forwards them to the adapter and keeps snapshots.

use crate::bridge;
use crate::db::{ConfigWrite, Db};
use crate::error::{code, AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, RwLock};
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REPOS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSource {
    pub kind: String,
    pub value: String,
    /// Config name typed by the user during import.
    ///
    /// It travels inside the source object (instead of a second command
    /// argument) so every existing `config_import { source: {kind, value} }`
    /// caller keeps working, and it is cleared before the row is persisted:
    /// the name of record is `ConfigSnapshot::name`, not the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Upper bound for a user-visible config name. Long enough for a host plus a
/// label, short enough that the settings list never wraps into three lines.
const MAX_NAME_CHARS: usize = 48;

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
    /// Config exactly as imported + normalized. Runtime policy NEVER rewrites
    /// this: it is the source of truth when a policy changes and the only place
    /// old favourites/history can still look a site up.
    ///
    /// `alias` reads files written before the split, where this field was
    /// called `snapshot`. New files always serialize as `imported`.
    #[serde(alias = "snapshot")]
    imported: ConfigSnapshot,
    /// One-way derivation of `imported` (see `derive_runtime`). All fan-out,
    /// playback and frontend cache reads go through this, never `imported`.
    #[serde(default)]
    runtime: Option<ConfigSnapshot>,
    source: ConfigSource,
}

/// Runtimes deliberately excluded from the runtime snapshot.
///
/// Community configs ship Android dex jars (`csp_*` sites + a config-level
/// `spider` jar) and drpy2 / ES-module JS sources. Both fail on Win x64 no
/// matter how often we retry, and each one used to add a failure line to every
/// aggregate search. They stay intact in `imported` so the user's config is
/// preserved and can be re-derived if support is added later.
pub(crate) fn blocked_reason(site: &Value) -> Option<&'static str> {
    match site.get("runtime").and_then(Value::as_str) {
        Some("jvm") => Some("jar 源为 Android dex，Windows 端暂不支持"),
        Some("quickjs") => Some("JS 源（drpy2 / ES 模块）暂不支持"),
        _ => None,
    }
}

/// imported -> runtime, one way and idempotent.
///
/// Only `sites` is transformed; the rest is inherited. `imported` is borrowed,
/// so re-running this after a policy change always starts from the original
/// data instead of stacking transformations on a transformed snapshot.
/// Blocked rows are kept (with `enabled = false` + a reason) rather than
/// removed, so the settings UI can explain why they disappeared.
fn derive_runtime(imported: &ConfigSnapshot) -> ConfigSnapshot {
    let mut runtime = imported.clone();
    runtime.sites = imported
        .sites
        .iter()
        .map(|site| match blocked_reason(site) {
            None => site.clone(),
            Some(reason) => {
                let mut blocked = site.clone();
                if let Some(map) = blocked.as_object_mut() {
                    map.insert("enabled".into(), Value::Bool(false));
                    map.insert("disabledReason".into(), Value::String(reason.to_string()));
                }
                blocked
            }
        })
        .collect();
    runtime
}

/// `runtime` is always Some after `insert`/`load`; fall back to `imported` for
/// hand-built fixtures so a missing derivation degrades instead of panicking.
fn runtime_of(entry: &StoredConfig) -> &ConfigSnapshot {
    entry.runtime.as_ref().unwrap_or(&entry.imported)
}

/// Trim + length-limit a user-supplied name, dropping control characters so a
/// pasted newline cannot break the settings list layout.
fn clean_name(value: &str) -> String {
    let mut out: String = value.trim().chars().take(MAX_NAME_CHARS).collect();
    out.retain(|ch| !ch.is_control());
    out.trim().to_string()
}

/// Host of a URL without the `www.` prefix: the default config name.
///
/// Users usually keep several configs from different providers, and the
/// domain is what tells them apart — the TVBox `name` field is often just
/// "box" or missing entirely.
///
/// Parsed by hand on purpose: `url::Url` IDNA-encodes the host, so a config
/// served from `www.例子.cc` would be labelled `xn--sss604efuw.cc`. The raw
/// authority keeps whatever the user actually typed.
fn host_of(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let rest = trimmed
        .split_once("://")
        .map(|(_, tail)| tail)
        .unwrap_or(trimmed);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Drop `user:pass@` and the port; keep an IPv6 literal in brackets.
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, tail)| tail);
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next().map(|hex| format!("[{hex}]"))?
    } else {
        host_port.split(':').next().unwrap_or("").to_string()
    };
    let host = host.trim_start_matches("www.").trim_end_matches('.');
    if host.is_empty()
        || !host
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '.' | '_' | '[' | ']'))
    {
        // Spaces / punctuation mean the user is still typing a URL: let the
        // normalizer's own name win instead of showing garbage.
        return None;
    }
    Some(host.to_string())
}

/// Default name for a freshly imported config.
///
/// URL imports use the domain; file/text imports keep whatever the normalizer
/// derived (config `name`, file stem, or "本地配置"), because there is no host
/// to show.
fn default_name(source: &ConfigSource, fallback: &str) -> String {
    if source.kind == "url" {
        if let Some(host) = host_of(&source.value) {
            return clean_name(&host);
        }
    }
    clean_name(fallback)
}

pub struct ConfigStore {
    entries: RwLock<Vec<StoredConfig>>,
    /// The config last imported by the user; fan-out only uses its sites.
    active: RwLock<Option<String>>,
    /// SQLite is the source of truth; `entries` is a parsed read cache so a
    /// 100-site snapshot is not deserialized on every search keystroke.
    db: Arc<Db>,
}

impl ConfigStore {
    /// Restore snapshots from SQLite. Rows imported from the old JSON files may
    /// carry an empty `runtime_json`; derive once and persist the result, so a
    /// policy upgrade takes effect without asking the user to re-import.
    pub fn load(db: Arc<Db>) -> Result<Self, AppError> {
        let mut entries = Vec::new();
        for row in db.config_rows()? {
            let imported: ConfigSnapshot = serde_json::from_str(&row.imported_json).map_err(|err| {
                AppError::new(code::INTERNAL, format!("config {} import is corrupt", row.id))
                    .with_cause(err.to_string())
            })?;
            let source: ConfigSource = serde_json::from_str(&row.source_json)
                .unwrap_or_else(|_| ConfigSource {
                    kind: "text".into(),
                    value: String::new(),
                    name: None,
                });
            let runtime = if row.runtime_json.is_empty() {
                None
            } else {
                Some(serde_json::from_str(&row.runtime_json).map_err(|err| {
                    AppError::new(code::INTERNAL, format!("config {} runtime is corrupt", row.id))
                        .with_cause(err.to_string())
                })?)
            };
            let mut stored = StoredConfig { imported, runtime, source };
            if stored.runtime.is_none() {
                let derived = derive_runtime(&stored.imported);
                db.set_runtime_json(&stored.imported.id, &serde_json::to_string(&derived)?)?;
                stored.runtime = Some(derived);
            }
            entries.push(stored);
        }
        // The active marker is authoritative. If it is missing or stale (older
        // data, or a config deleted out of band), fall back to the newest
        // import and self-heal the marker. Guessing from file order here is
        // what made fan-out search zero sites after a restart.
        let active = db
            .active_config_id()?
            .filter(|id| entries.iter().any(|entry| entry.imported.id == *id))
            .or_else(|| newest_id(&entries));
        db.set_active_config_id(active.as_deref())?;
        let store = Self {
            entries: RwLock::new(entries),
            active: RwLock::new(active),
            db,
        };
        // Publish the restored config's host header table; otherwise the first
        // playback after a restart loses the anti-leech headers.
        if let Some(snapshot) = store.active_snapshot() {
            crate::netrules::replace(&snapshot.headers);
        }
        Ok(store)
    }

    /// Persist the imported config AND its independent runtime derivation.
    /// Returns the runtime snapshot: `config_import` gives it to the frontend
    /// so the site cache cannot reintroduce sources we just blocked.
    pub fn insert(
        &self,
        imported: ConfigSnapshot,
        source: ConfigSource,
    ) -> Result<ConfigSnapshot, AppError> {
        let id = imported.id.clone();
        let runtime = derive_runtime(&imported);
        let headers = runtime.headers.clone();
        // Write the imported/runtime pair and switch the active marker in one
        // transaction BEFORE touching the in-memory caches. Two separate files
        // used to be able to disagree after a crash mid-write.
        let imported_json = serde_json::to_string(&imported)?;
        let runtime_json = serde_json::to_string(&runtime)?;
        let source_json = serde_json::to_string(&source)?;
        self.db.activate_config(ConfigWrite {
            id: &id,
            name: &imported.name,
            imported_at: &imported.imported_at,
            imported_json: &imported_json,
            runtime_json: &runtime_json,
            source_json: &source_json,
        })?;
        // One clone is unavoidable here: the store owns the runtime snapshot
        // while the caller needs it for the UI. Imports are rare; a second IPC
        // round trip to read it back would cost more than the copy.
        let stored = StoredConfig {
            imported,
            runtime: Some(runtime.clone()),
            source,
        };
        {
            let mut guard = self.entries.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.retain(|entry| entry.imported.id != id);
            guard.push(stored);
        }
        *self.active.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id);
        crate::netrules::replace(&headers);
        Ok(runtime)
    }

    pub fn list(&self) -> Vec<ConfigMeta> {
        let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .iter()
            .map(|entry| ConfigMeta {
                id: entry.imported.id.clone(),
                name: entry.imported.name.clone(),
                source: entry.source.clone(),
                imported_at: entry.imported.imported_at.clone(),
            })
            .collect()
    }

    /// Current name of an imported config, used to keep a user-chosen name
    /// when the same config is imported again (id is derived from the origin,
    /// so a re-import overwrites the same row).
    pub fn name_of(&self, id: &str) -> Option<String> {
        self.entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|entry| entry.imported.id == id)
            .map(|entry| entry.imported.name.clone())
    }

    /// Make another stored config the active one and return its runtime
    /// snapshot so the frontend can swap its site cache in the same breath.
    pub fn activate(&self, id: &str) -> Result<ConfigSnapshot, AppError> {
        let snapshot = {
            let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = guard
                .iter()
                .find(|entry| entry.imported.id == id)
                .ok_or_else(|| {
                    AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found"))
                })?;
            runtime_of(entry).clone()
        };
        // Persist first: if SQLite rejects the write the in-memory active id
        // must keep pointing at the config that is actually stored.
        self.db.set_active_config_id(Some(id))?;
        *self.active.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id.to_string());
        crate::netrules::replace(&snapshot.headers);
        Ok(snapshot)
    }

    /// Rename a stored config. The name lives in both snapshots (`imported` is
    /// what the list/UI reads, `runtime` is what the frontend receives), so
    /// both are rewritten and the row is persisted as one row (no active id
    /// change — renaming must not switch what is playing).
    pub fn rename(&self, id: &str, name: &str) -> Result<ConfigMeta, AppError> {
        let name = clean_name(name);
        if name.is_empty() {
            return Err(AppError::new(code::INVALID_ARGUMENT, "config name is empty"));
        }
        let (mut imported, mut runtime, source) = {
            let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = guard
                .iter()
                .find(|entry| entry.imported.id == id)
                .ok_or_else(|| {
                    AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found"))
                })?;
            (entry.imported.clone(), runtime_of(entry).clone(), entry.source.clone())
        };
        imported.name = name.clone();
        runtime.name = name.clone();
        let imported_json = serde_json::to_string(&imported)?;
        let runtime_json = serde_json::to_string(&runtime)?;
        let source_json = serde_json::to_string(&source)?;
        self.db.update_config(ConfigWrite {
            id: &imported.id,
            name: &name,
            imported_at: &imported.imported_at,
            imported_json: &imported_json,
            runtime_json: &runtime_json,
            source_json: &source_json,
        })?;
        {
            let mut guard = self.entries.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = guard.iter_mut().find(|entry| entry.imported.id == id) {
                entry.imported.name = name.clone();
                if let Some(snapshot) = entry.runtime.as_mut() {
                    snapshot.name = name.clone();
                }
            }
        }
        Ok(ConfigMeta {
            id: imported.id,
            name,
            source,
            imported_at: imported.imported_at,
        })
    }

    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        let exists = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|entry| entry.imported.id == id);
        if !exists {
            return Err(AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found")));
        }
        let was_active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_deref()
            == Some(id);
        // SQLite promotes the newest remaining config when the active one is
        // removed; the returned id keeps the cache and the DB in agreement.
        let next_active = self.db.delete_config(id)?;
        {
            let mut guard = self.entries.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.retain(|entry| entry.imported.id != id);
        }
        // Only now touch `active`, and only if it pointed at the removed entry.
        // `all_sites` acquires active then entries; taking them in the opposite
        // order (or overlapping) lets the two callers deadlock.
        if was_active {
            *self.active.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = next_active;
        }
        if let Some(snapshot) = self.active_snapshot() {
            crate::netrules::replace(&snapshot.headers);
        }
        Ok(())
    }

    pub fn find_site(&self, site_key: &str) -> Result<Value, AppError> {
        // Look in the imported configs on purpose: a favourite/history entry
        // may still point at a site that the runtime policy now blocks. The
        // caller (`spider_invoke`) enforces the policy before dispatch.
        let guard = self.entries.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in guard.iter() {
            for site in &entry.imported.sites {
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
        pick(active.as_deref(), guard.as_slice()).map(|entry| runtime_of(entry).clone())
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
            .map(|entry| runtime_of(entry).parses.clone())
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
            .map(|id| guard.iter().any(|entry| &entry.imported.id == id))
            .unwrap_or(false);

        // Borrow the keys for de-duplication: no need to allocate a String per
        // site just to test membership in the set.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut out = Vec::new();
        for entry in guard.iter() {
            if has_active && active.as_deref() != Some(entry.imported.id.as_str()) {
                continue;
            }
            for site in &runtime_of(entry).sites {
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
        .max_by(|a, b| a.imported.imported_at.cmp(&b.imported.imported_at))
        .map(|entry| entry.imported.id.clone())
}

/// Pick the active entry, or the most recently imported one when the active id
/// is missing (hand-written fixtures). `active_snapshot` and `active_parses`
/// must agree on this rule.
fn pick<'a>(active: Option<&str>, entries: &'a [StoredConfig]) -> Option<&'a StoredConfig> {
    entries
        .iter()
        .find(|entry| active == Some(entry.imported.id.as_str()))
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
    // `insert` owns the imported snapshot and returns its runtime derivation.
    // Never hand the imported one back to the UI: its sites still contain the
    // blocked jar/JS sources and would silently repopulate the frontend cache.
    let requested = source
        .name
        .as_deref()
        .map(clean_name)
        .filter(|name| !name.is_empty());
    let mut imported = import_from_source(ConfigSource {
        name: None,
        ..source.clone()
    })
    .await?;
    // Priority: what the user typed → the name this config already has (a
    // re-import must not throw away a custom name) → the domain / config name.
    imported.name = match requested {
        Some(name) => name,
        None => state
            .name_of(&imported.id)
            .unwrap_or_else(|| default_name(&source, &imported.name)),
    };
    state.insert(
        imported,
        ConfigSource {
            name: None,
            ..source
        },
    )
}

#[tauri::command]
pub fn config_list(state: tauri::State<'_, ConfigStore>) -> Result<Vec<ConfigMeta>, AppError> {
    Ok(state.list())
}

/// Switch the active config without re-importing it. Returns the runtime
/// snapshot (blocked sites already disabled) so the UI can replace its cache.
#[tauri::command]
pub fn config_activate(
    state: tauri::State<'_, ConfigStore>,
    id: String,
) -> Result<ConfigSnapshot, AppError> {
    state.activate(&id)
}

#[tauri::command]
pub fn config_rename(
    state: tauri::State<'_, ConfigStore>,
    id: String,
    name: String,
) -> Result<ConfigMeta, AppError> {
    state.rename(&id, &name)
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

    /// Each test owns a separate SQLite file. `LUMA_DATA_DIR` is process-wide,
    /// so the guard is held for the whole test, not just during setup.
    static DATA_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn isolate_data_dir() -> (std::sync::MutexGuard<'static, ()>, std::path::PathBuf) {
        let guard = DATA_DIR_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "luma-config-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        crate::env::set("DATA_DIR", &dir);
        (guard, dir)
    }

    /// Fresh process-like state: open the DB and rebuild the in-memory cache.
    fn store_at(dir: &std::path::Path) -> ConfigStore {
        let db = Arc::new(Db::at(dir.to_path_buf()).expect("open sqlite db"));
        ConfigStore::load(db).expect("load config store")
    }

    #[test]
    fn fanout_is_scoped_to_the_active_config() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        };
        store.insert(snapshot("old", &["stub_a"]), source.clone()).unwrap();
        assert_eq!(store.all_sites().len(), 1);

        store.insert(snapshot("new", &["real_a", "real_b"]), source).unwrap();
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
            name: None,
        };
        let mut stale = snapshot("old", &["stub_a"]);
        stale.imported_at = "2026-01-01T00:00:00Z".into();
        let mut current = snapshot("box", &["real_a", "real_b"]);
        current.imported_at = "2026-11-10T09:14:17Z".into();
        // Deliberately put the stale entry last: that is exactly how read_dir
        // ordered `old.json` after the real config on this machine.
        let entries = vec![
            StoredConfig {
                imported: current,
                runtime: None,
                source: source.clone(),
            },
            StoredConfig {
                imported: stale,
                runtime: None,
                source,
            },
        ];
        assert_eq!(newest_id(&entries).as_deref(), Some("box"));
    }

    #[test]
    fn derive_runtime_blocks_jar_and_js_without_rewriting_the_import() {
        let mut imported = snapshot("box", &[]);
        imported.sites = vec![
            json!({"key": "cms", "runtime": "cms", "enabled": true}),
            json!({"key": "py", "runtime": "python", "enabled": true}),
            json!({"key": "jar", "runtime": "jvm", "enabled": true}),
            json!({"key": "js", "runtime": "quickjs", "enabled": true}),
            json!({"key": "divider", "runtime": "none", "enabled": false}),
        ];
        let before = imported.sites.clone();
        let runtime = derive_runtime(&imported);

        // The import is the source of truth: the transform must be read-only.
        assert_eq!(imported.sites, before);
        let site = |key: &str| -> Value {
            runtime
                .sites
                .iter()
                .find(|site| site.get("key").and_then(Value::as_str) == Some(key))
                .expect("site present")
                .clone()
        };
        for key in ["jar", "js"] {
            assert_eq!(site(key).get("enabled").and_then(Value::as_bool), Some(false));
            assert!(site(key).get("disabledReason").and_then(Value::as_str).is_some());
        }
        for key in ["cms", "py"] {
            assert_eq!(site(key).get("enabled").and_then(Value::as_bool), Some(true));
            assert!(site(key).get("disabledReason").is_none());
        }
        assert_eq!(site("divider").get("enabled").and_then(Value::as_bool), Some(false));
        // Config-level fields are inherited, not rebuilt from scratch.
        assert_eq!(runtime.id, imported.id);
        assert_eq!(runtime.headers, imported.headers);
        // Re-deriving from the same import is idempotent (no stacked policy).
        assert_eq!(derive_runtime(&imported).sites, runtime.sites);
    }

    #[test]
    fn legacy_json_migrates_into_sqlite_without_rewriting_the_import() {
        let (_guard, root) = isolate_data_dir();
        let dir = root.join("configs");
        std::fs::create_dir_all(&dir).expect("temp configs dir");
        let legacy = json!({
            "snapshot": {
                "id": "legacy",
                "name": "legacy",
                "importedAt": "2026-11-10T00:00:00Z",
                "sites": [
                    {"key": "py", "runtime": "python", "enabled": true},
                    {"key": "jar", "runtime": "jvm", "enabled": true}
                ]
            },
            "source": {"kind": "text", "value": ""}
        });
        std::fs::write(dir.join("legacy.json"), serde_json::to_string(&legacy).unwrap()).unwrap();
        std::fs::write(root.join("active.json"), "legacy").unwrap();

        // Db::at performs the one-time JSON -> SQLite migration on open.
        let db = Arc::new(Db::at(root.clone()).expect("open db"));
        let store = ConfigStore::load(db.clone()).expect("load store");
        let active = store.active_snapshot().expect("active snapshot");
        let jar = active
            .sites
            .iter()
            .find(|site| site.get("key").and_then(Value::as_str) == Some("jar"))
            .expect("jar site");
        assert_eq!(jar.get("enabled").and_then(Value::as_bool), Some(false));
        assert!(jar.get("disabledReason").is_some());
        assert_eq!(store.all_sites().len(), 2, "blocked rows stay, but disabled");

        // Both sides live in SQLite now: the import is untouched, the derived
        // runtime is persisted so a policy change can always re-derive from it.
        let rows = db.config_rows().unwrap();
        assert_eq!(rows.len(), 1);
        let imported: Value = serde_json::from_str(&rows[0].imported_json).unwrap();
        assert_eq!(imported["sites"][1]["enabled"], json!(true));
        let runtime: Value = serde_json::from_str(&rows[0].runtime_json).unwrap();
        assert!(runtime["sites"][1]["disabledReason"].is_string());
        assert_eq!(db.active_config_id().unwrap().as_deref(), Some("legacy"));

        // Reopening must not duplicate rows or lose the active marker, even
        // though the old JSON files are deliberately left in place.
        let reopened = store_at(&root);
        assert_eq!(reopened.list().len(), 1);
        assert_eq!(reopened.active_snapshot().unwrap().id, "legacy");
        assert_eq!(reopened.all_sites().len(), 2);
    }

    #[test]
    fn active_config_survives_restart_and_deletion() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        };
        let mut stale = snapshot("old", &["stub_a"]);
        stale.imported_at = "2026-01-01T00:00:00Z".into();
        let mut current = snapshot("box", &["real_a", "real_b"]);
        current.imported_at = "2026-11-10T09:14:17Z".into();
        store.insert(stale, source.clone()).unwrap();
        store.insert(current, source).unwrap();

        let restarted = store_at(&dir);
        assert_eq!(restarted.list().len(), 2);
        assert_eq!(restarted.active_snapshot().unwrap().id, "box");
        assert_eq!(restarted.all_sites().len(), 2);

        restarted.remove("box").unwrap();
        let after = store_at(&dir);
        assert_eq!(after.list().len(), 1);
        assert_eq!(after.active_snapshot().unwrap().id, "old");
        assert_eq!(after.all_sites().len(), 1);
        assert!(after.remove("missing").is_err(), "unknown id is rejected");
    }

    #[test]
    fn default_name_uses_the_domain_for_urls() {
        let url = |value: &str| ConfigSource {
            kind: "url".into(),
            value: value.into(),
            name: None,
        };
        // `www.` and the path are noise; the registrable host is the label.
        assert_eq!(
            default_name(&url("https://www.例子.cc/tv/box.json"), "box"),
            "例子.cc"
        );
        assert_eq!(default_name(&url("http://example.com:8080/api"), "box"), "example.com");
        // No host to show: keep what the normalizer derived.
        assert_eq!(default_name(&url("not a url"), "box"), "box");
        assert_eq!(
            default_name(
                &ConfigSource {
                    kind: "text".into(),
                    value: "{}".into(),
                    name: None,
                },
                "本地配置"
            ),
            "本地配置"
        );
    }

    #[test]
    fn clean_name_trims_and_caps_length() {
        assert_eq!(clean_name("  我的配置 \n"), "我的配置");
        assert_eq!(clean_name("   "), "");
        assert_eq!(clean_name(&"x".repeat(80)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn activate_switches_the_live_config_and_persists_it() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        };
        let mut first = snapshot("aaa", &["site_a"]);
        first.imported_at = "2026-01-01T00:00:00Z".into();
        let mut second = snapshot("bbb", &["site_b", "site_c"]);
        second.imported_at = "2026-02-01T00:00:00Z".into();
        store.insert(first, source.clone()).unwrap();
        // The newest import becomes active, so switching back is a real change.
        store.insert(second, source).unwrap();
        assert_eq!(store.active_snapshot().unwrap().id, "bbb");

        let snapshot = store.activate("aaa").unwrap();
        assert_eq!(snapshot.id, "aaa");
        assert_eq!(snapshot.sites.len(), 1);
        assert!(store.activate("missing").is_err(), "unknown id is rejected");

        // Active id is the DB's business: a restart must keep the choice.
        let restarted = store_at(&dir);
        assert_eq!(restarted.active_snapshot().unwrap().id, "aaa");
        assert_eq!(restarted.all_sites().len(), 1);
    }

    #[test]
    fn rename_touches_both_snapshots_without_switching_active() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "url".into(),
            value: "https://example.com/box.json".into(),
            name: None,
        };
        let mut first = snapshot("aaa", &["site_a"]);
        first.imported_at = "2026-01-01T00:00:00Z".into();
        let mut second = snapshot("bbb", &["site_b"]);
        second.imported_at = "2026-02-01T00:00:00Z".into();
        store.insert(first, source.clone()).unwrap();
        store.insert(second, source).unwrap();

        let meta = store.rename("aaa", "  家里的配置  ").unwrap();
        assert_eq!(meta.name, "家里的配置");
        assert_eq!(store.name_of("aaa").as_deref(), Some("家里的配置"));
        // Renaming the non-active config must not steal the active marker.
        assert_eq!(store.active_snapshot().unwrap().id, "bbb");
        assert!(store.rename("aaa", "   ").is_err(), "empty name is rejected");

        let restarted = store_at(&dir);
        assert_eq!(restarted.name_of("aaa").as_deref(), Some("家里的配置"));
        assert_eq!(restarted.active_snapshot().unwrap().id, "bbb");
        // Both snapshots were rewritten, so the runtime view carries the name.
        let entry = restarted
            .entries
            .read()
            .unwrap()
            .iter()
            .find(|entry| entry.imported.id == "aaa")
            .map(|entry| entry.runtime.as_ref().unwrap().name.clone());
        assert_eq!(entry.as_deref(), Some("家里的配置"));
    }
}
