use super::naming::{clean_name, default_name};
use super::*;

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REPOS: usize = 20;

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

/// 三内置代理 + 直连并发竞速：谁先成功返回用谁。
async fn fetch_fastest(bare: &str) -> Result<String, AppError> {
    let mut set = tokio::task::JoinSet::new();
    for prefix in ghproxy::BUILTIN_PREFIXES {
        let url = format!("{prefix}{bare}");
        set.spawn(async move { fetch_text(url.as_str()).await });
    }
    let direct = bare.to_string();
    set.spawn(async move { fetch_text(direct.as_str()).await });

    let mut last_error: Option<AppError> = None;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(text)) => {
                set.abort_all();
                return Ok(text);
            }
            Ok(Err(err)) => last_error = Some(err),
            Err(_) => {}
        }
    }
    Err(last_error
        .unwrap_or_else(|| AppError::new(code::CONFIG_FETCH_FAIL, "all GitHub mirrors failed")))
}

/// 按地址类型决定怎么拉：
/// - 用户自带加速前缀（非 app 内置）→ 原样直取，不再叠加、不替换；
/// - 裸 GitHub / app 内置前缀 → 三代理并发竞速；
/// - 其它 → 直连。
async fn fetch_config_text(url: &str) -> Result<String, AppError> {
    if let Some((prefix, _)) = ghproxy::split_proxy(url) {
        if !ghproxy::is_builtin_prefix(prefix) {
            return fetch_text(url).await;
        }
    }
    let bare = ghproxy::strip_proxy(url);
    if ghproxy::is_github_url(bare) {
        return fetch_fastest(bare).await;
    }
    fetch_text(bare).await
}

/// 订阅地址入库前归一化：app 内置加速前缀剥掉存**裸地址**（唯一性稳定）；
/// 用户自带前缀保留原样（那是用户明确选择的加速）。
fn normalize_source(mut source: ConfigSource) -> ConfigSource {
    if source.kind == "url" {
        if let Some((prefix, bare)) = ghproxy::split_proxy(&source.value) {
            if ghproxy::is_builtin_prefix(prefix) {
                source.value = bare.to_string();
            }
        }
    }
    source
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
        "url" => (fetch_config_text(&source.value).await?, source.value.clone()),
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
    let mut snapshot = import_from_raw(&raw, &origin).await?;
    ghproxy::rewrite_snapshot(&mut snapshot, prefix);
    Ok(snapshot)
}

pub async fn import_from_raw(raw: &str, origin: &str) -> Result<ConfigSnapshot, AppError> {
    let plain = decrypt_plain(raw)?;

    let parsed: Value = serde_json::from_str(&plain).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "decrypted payload is not json")
            .with_cause(err.to_string())
    })?;

    if let Some(items) = parsed.get("urls").and_then(Value::as_array) {
        return import_repos(items).await;
    }
    normalize_plain(&plain, origin)
}

/// 解密（含 JSONC 清洗）并留一条可复盘的耗时记录。
///
/// 以前这一步是一次 sidecar 往返，1.0.1 那次「config.decrypt exceeded 15000ms」
/// 就是排队 + 超时；现在解密是进程内的纯计算，微秒级，日志仍保留大小与耗时，
/// 便于以后核对「是不是又退化成 IO」。
fn decrypt_plain(raw: &str) -> Result<String, AppError> {
    let started = std::time::Instant::now();
    let outcome = decrypt::decrypt(raw);
    tracing::info!(
        bytes = raw.len(),
        took_ms = started.elapsed().as_millis() as u64,
        ok = outcome.is_ok(),
        method = outcome.as_ref().map(|out| out.method).unwrap_or("-"),
        "config decrypt"
    );
    Ok(outcome?.plain)
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

    let merged = normalize::merge_repos(&snapshots);
    serde_json::from_value(merged).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "merged snapshot shape mismatch")
            .with_cause(err.to_string())
    })
}

async fn import_url_snapshot(url: String) -> Result<Value, AppError> {
    // 取用加速地址，但 origin 记原始 URL：配置 id 由 origin 派生，跟着代理
    // 走会让「换个代理再导一次」变成两份配置。
    let raw = fetch_config_text(&url).await?;
    let plain = decrypt_plain(&raw)?;
    normalize_value(&plain, &url)
}

fn normalize_plain(plain: &str, origin: &str) -> Result<ConfigSnapshot, AppError> {
    let value = normalize_value(plain, origin)?;
    serde_json::from_value(value).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "snapshot shape mismatch").with_cause(err.to_string())
    })
}

fn normalize_value(plain: &str, origin: &str) -> Result<Value, AppError> {
    let parsed: Value = serde_json::from_str(plain).map_err(|err| {
        AppError::new(code::DIALECT_UNKNOWN, "decrypted payload is not json")
            .with_cause(err.to_string())
    })?;
    normalize::normalize_config(&parsed, origin)
}

pub(crate) async fn import_config(
    state: tauri::State<'_, ConfigStore>,
    source: ConfigSource,
) -> Result<ConfigSnapshot, AppError> {
    // 订阅地址归一化：app 内置加速前缀剥掉存裸地址，订阅唯一性才稳定。
    let source = normalize_source(source);
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
