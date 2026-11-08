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

struct StoredConfig {
    snapshot: ConfigSnapshot,
    source: ConfigSource,
}

#[derive(Default)]
pub struct ConfigStore {
    entries: RwLock<Vec<StoredConfig>>,
}

impl ConfigStore {
    pub fn insert(&self, snapshot: ConfigSnapshot, source: ConfigSource) {
        let mut guard = self.entries.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.retain(|entry| entry.snapshot.id != snapshot.id);
        guard.push(StoredConfig { snapshot, source });
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
}

async fn fetch_text(url: &str) -> Result<String, AppError> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("okhttp/3.15")
        .build()
        .map_err(|err| {
            AppError::new(code::CONFIG_FETCH_FAIL, "http client init failed").with_cause(err.to_string())
        })?;
    let response = client.get(url).send().await.map_err(|err| {
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

#[tauri::command]
pub fn config_remove(state: tauri::State<'_, ConfigStore>, id: String) -> Result<(), AppError> {
    state.remove(&id)
}
