use super::*;

///
/// 只取会真正影响功能的字段，并且递归按 key 排序后再序列化——normalize 的
/// 输出顺序理论上稳定，但一次多余的字段重排就让用户看到「每天都有更新」，
/// 这个代价不值得省。`name` / `imported_at` 必须排除：用户改过名、或者只是
/// 导入时间不同，都不是内容变化。
pub(crate) fn content_signature(snapshot: &ConfigSnapshot) -> String {
    let mut value = match serde_json::to_value(snapshot) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    if let Some(map) = value.as_object_mut() {
        map.remove("name");
        map.remove("importedAt");
        map.remove("imported_at");
        map.remove("id");
    }
    canonical_json(&value)
}

/// 递归按 key 排序的 JSON 序列化；数组顺序保持原样（站点顺序有意义）。
pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// 到期判定（纯函数，便于单测）。间隔 0 = 关闭；从未检查过视为立即到期，
/// 这样「装好就一直在跑」的程序启动后也会检查一次订阅。
pub(crate) fn refresh_due(interval_hours: u32, checked_at: Option<u64>, now_ms: u64) -> bool {
    if interval_hours == 0 {
        return false;
    }
    match checked_at {
        None => true,
        Some(checked) => now_ms.saturating_sub(checked) >= u64::from(interval_hours) * 3_600_000,
    }
}

/// 运行态禁用原因：返回 `Some` 的站点在 fan-out / 播放 / 前端一律不参与。
///
/// 目前两类：jar（Android dex，Win x64 无解，见 `docs/ARCHITECTURE.md`）和
/// 「相对地址没解析出来」（粘贴文本 / 本地文件导入，见 `unresolved_relative`）。
/// JS 源曾经也被一刀切封禁，qjs-runner 支持 ESM + `assets://` 之后已放开
/// （见 `docs/js-support.md`）。被封的站点行在 `imported` 里原样保留，策略变化
/// 可以重新派生，不丢用户配置。
pub(crate) fn blocked_reason(site: &Value) -> Option<&'static str> {
    if unresolved_relative(site) {
        return Some(RELATIVE_BLOCK_REASON);
    }
    match site.get("runtime").and_then(Value::as_str) {
        Some("jvm") => Some("jar 源为 Android dex，Windows 端暂不支持"),
        _ => None,
    }
}

/// 相对地址（`./py/x.py`、`../lib/x.m3u`、`/jar/x.jar`）只能相对配置来源 URL
/// 解析。粘贴文本 / 本地文件导入没有 base，`resolve_ref` 会原样留下，运行态再去
/// 抓就成了 `fetch ./py/douban.py failed` —— 用户只看到「首页内容加载失败」。
/// 这类站点在运行态统一标成禁用并给出原因，导入原件一个字段都不动（重新从 URL
/// 导入可以恢复）。分隔条 / 空 api 不算。
fn unresolved_relative(site: &Value) -> bool {
    let api = site.get("api").and_then(Value::as_str).unwrap_or("").trim();
    if api.is_empty() {
        return false;
    }
    api.starts_with("./") || api.starts_with("../") || api.starts_with('/')
}

/// 相对地址被封禁的原因（站点体检 / 导入提示直接展示这句）。
pub(crate) const RELATIVE_BLOCK_REASON: &str =
    "相对地址只有从 URL 导入的配置才能解析，请改用「导入 URL」";

/// Reasons written by an *older* blocking policy. A row still carrying one of
/// these is stale: the policy no longer blocks that runtime, so a restart must
/// re-enable it instead of keeping the user's sources hidden forever.
pub(crate) const STALE_BLOCK_REASONS: &[&str] = &["JS 源（drpy2 / ES 模块）暂不支持"];

/// Replay the current blocking policy onto an existing runtime snapshot.
///
/// Unlike `derive_runtime` (which starts from `imported` and would drop manual
/// disables), this only touches rows that are stale or newly blocked:
///   * blocked now (jvm) -> force disabled + current reason;
///   * stale reason from a retired policy -> re-enable + clear the reason;
///   * user disables ("已在站点体检中手动禁用") -> untouched.
/// Returns true when the snapshot changed and needs persisting.
pub(crate) fn refresh_policy(runtime: &mut ConfigSnapshot) -> bool {
    let mut changed = false;
    for site in runtime.sites.iter_mut() {
        let reason = site
            .get("disabledReason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let enabled = site.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        match blocked_reason(site) {
            Some(blocked) => {
                if enabled || reason != blocked {
                    if let Some(map) = site.as_object_mut() {
                        map.insert("enabled".into(), Value::Bool(false));
                        map.insert("disabledReason".into(), Value::String(blocked.to_string()));
                    }
                    changed = true;
                }
            }
            None if STALE_BLOCK_REASONS.contains(&reason.as_str()) => {
                if let Some(map) = site.as_object_mut() {
                    map.insert("enabled".into(), Value::Bool(true));
                    map.remove("disabledReason");
                }
                changed = true;
            }
            None => {}
        }
    }
    changed
}

/// imported -> runtime, one way and idempotent.
///
/// Only `sites` is transformed; the rest is inherited. `imported` is borrowed,
/// so re-running this after a policy change always starts from the original
/// data instead of stacking transformations on a transformed snapshot.
/// Blocked rows are kept (with `enabled = false` + a reason) rather than
/// removed, so the settings UI can explain why they disappeared.
pub(crate) fn derive_runtime(imported: &ConfigSnapshot) -> ConfigSnapshot {
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

/// 只有 URL 来源能回拉：file / 粘贴文本没有远端可更新。
pub(crate) fn ensure_refreshable(source: &ConfigSource) -> Result<(), AppError> {
    if source.kind == "url" {
        Ok(())
    } else {
        Err(AppError::new(
            code::INVALID_ARGUMENT,
            "只有网络地址导入的配置支持自动刷新",
        ))
    }
}

/// 站点体检里被手动禁用的站点 key。
pub(crate) fn manual_disabled_keys(runtime: &ConfigSnapshot) -> Vec<String> {
    runtime
        .sites
        .iter()
        .filter(|site| {
            site.get("disabledReason").and_then(Value::as_str) == Some(MANUAL_DISABLE_REASON)
        })
        .filter_map(|site| site.get("key").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// 把手动禁用搬回新派生的 runtime。
///
/// `derive_runtime` 只按屏蔽策略算（jvm / dex），手动状态存在 runtime 层；
/// 订阅刷新如果只重新派生，用户屏蔽的慢源就会被订阅更新悄悄复活。
pub(crate) fn apply_manual_disables(runtime: &mut ConfigSnapshot, manual: &[String]) {
    for site in runtime.sites.iter_mut() {
        let key = site.get("key").and_then(Value::as_str).unwrap_or("");
        if !manual.iter().any(|manual_key| manual_key == key) {
            continue;
        }
        if let Some(map) = site.as_object_mut() {
            map.insert("enabled".into(), Value::Bool(false));
            map.insert(
                "disabledReason".into(),
                Value::String(MANUAL_DISABLE_REASON.into()),
            );
        }
    }
}

/// `runtime` is always Some after `insert`/`load`; fall back to `imported` for
/// hand-built fixtures so a missing derivation degrades instead of panicking.
pub(crate) fn runtime_of(entry: &StoredConfig) -> &ConfigSnapshot {
    entry.runtime.as_ref().unwrap_or(&entry.imported)
}
