use super::*;
use super::naming::{clean_name, default_name};

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REPOS: usize = 20;

/// 导入链路单次 sidecar 调用的预算。比爬虫的 15s 宽：一次导入是用户在屏幕前
/// 等的一个明确结果（解密 + 归一化 + 多仓合并），不该和单站请求共用同一条线；
/// 但仍要有上限，适配层真卡死时不能让导入永久转圈。
pub(crate) const CONFIG_CALL_TIMEOUT: Duration = Duration::from_secs(30);

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
    // 配置正文可能不是 UTF-8（中文圈配置大量是 GBK，论坛里复制的还常带 BOM），
    // 所以收字节再洗，不交给 `Response::text()` 按 UTF-8 硬解。
    let declared_charset = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(crate::textio::charset_from_content_type);
    let bytes = response.bytes().await.map_err(|err| {
        AppError::new(code::CONFIG_FETCH_FAIL, "read body failed").with_cause(err.to_string())
    })?;
    Ok(crate::textio::decode_with_charset(
        &bytes,
        declared_charset.as_deref(),
    ))
}

/// 读一份配置（url / file / text），归一化后**统一套上 GitHub 加速前缀**。
///
/// 前缀在这里一次性生效，而不是散落在各个调用点：`config_import`、订阅
/// 定时刷新、多仓库合并都走同一条路，不会出现「手动导入加速了、自动刷新
/// 又变回直连」的不一致。`prefix` 为空串表示用户选了直连，此时只是把可能
/// 残留的旧代理前缀剥掉。
pub async fn import_from_source(
    source: ConfigSource,
    prefix: &str,
) -> Result<ConfigSnapshot, AppError> {
    let (raw, origin) = match source.kind.as_str() {
        // 配置地址本身常常就是 raw.githubusercontent.com，同样要加速，
        // 否则「配置都拉不下来」这一步就先失败了。
        "url" => (
            fetch_text(ghproxy::apply(&source.value, prefix).as_ref()).await?,
            source.value.clone(),
        ),
        "file" => (
            crate::textio::read_file(std::path::Path::new(&source.value)).map_err(|err| {
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
    let mut snapshot = import_from_raw(&raw, &origin, prefix).await?;
    ghproxy::rewrite_snapshot(&mut snapshot, prefix);
    Ok(snapshot)
}

pub async fn import_from_raw(
    raw: &str,
    origin: &str,
    prefix: &str,
) -> Result<ConfigSnapshot, AppError> {
    let decrypted = decrypt_config(raw).await?;
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
        return import_repos(items, prefix).await;
    }
    normalize_plain(&plain, origin).await
}

/// 调 `config.decrypt` 并留一条可复盘的耗时记录。
///
/// 1.0.1 那次「导入失败：config.decrypt exceeded 15000ms」查不动，是因为宿主侧
/// 只留下「超时」四个字：既没有 payload 大小，也没有实际耗时，无法区分「解密
/// 慢」和「排队 15 秒」。这条 INFO 在 `luma-*.log` 里，失败也照记。
async fn decrypt_config(raw: &str) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    let outcome = bridge::call_with_timeout(
        "config.decrypt",
        json!({ "raw": raw }),
        CONFIG_CALL_TIMEOUT,
    )
    .await;
    tracing::info!(
        bytes = raw.len(),
        took_ms = started.elapsed().as_millis() as u64,
        ok = outcome.is_ok(),
        "config decrypt"
    );
    outcome
}

async fn import_repos(items: &[Value], prefix: &str) -> Result<ConfigSnapshot, AppError> {
    let mut set = tokio::task::JoinSet::new();
    for item in items.iter().take(MAX_REPOS) {
        let url = item
            .as_str()
            .map(str::to_string)
            .or_else(|| item.get("url").and_then(Value::as_str).map(str::to_string));
        let Some(url) = url else { continue };
        let prefix = prefix.to_string();
        set.spawn(async move { import_url_snapshot(url, prefix).await });
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

    let merged = bridge::call_with_timeout(
        "config.mergeRepos",
        json!({ "snapshots": snapshots }),
        CONFIG_CALL_TIMEOUT,
    )
    .await?;
    serde_json::from_value(merged).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "merged snapshot shape mismatch")
            .with_cause(err.to_string())
    })
}

async fn import_url_snapshot(url: String, prefix: String) -> Result<Value, AppError> {
    // 取用加速地址，但 origin 记原始 URL：配置 id 由 origin 派生，跟着代理
    // 走会让「换个代理再导一次」变成两份配置。
    let raw = fetch_text(ghproxy::apply(&url, &prefix).as_ref()).await?;
    let decrypted = decrypt_config(&raw).await?;
    let plain = decrypted
        .get("plain")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new(code::CONFIG_DECRYPT_FAIL, format!("repo {url} decrypt failed")))?;
    bridge::call_with_timeout(
        "config.normalize",
        json!({ "raw": plain, "origin": url }),
        CONFIG_CALL_TIMEOUT,
    )
    .await
}

async fn normalize_plain(plain: &str, origin: &str) -> Result<ConfigSnapshot, AppError> {
    let value = bridge::call_with_timeout(
        "config.normalize",
        json!({ "raw": plain, "origin": origin }),
        CONFIG_CALL_TIMEOUT,
    )
    .await?;
    serde_json::from_value(value).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "snapshot shape mismatch").with_cause(err.to_string())
    })
}


pub(crate) async fn import_config(
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
    let mut imported = import_from_source(
        ConfigSource {
            name: None,
            ..source.clone()
        },
        &state.github_proxy(),
    )
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
