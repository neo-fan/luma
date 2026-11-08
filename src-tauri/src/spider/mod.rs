//! Spider runtime dispatch (spec 7.3 / 8.3).

pub mod cms;

use crate::config::ConfigStore;
use crate::error::{code, AppError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpiderMethod {
    HomeContent,
    CategoryContent,
    DetailContent,
    SearchContent,
    PlayerContent,
    LiveContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpiderRequest {
    pub site_key: String,
    pub method: SpiderMethod,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Prefer the runtime computed by the Python normalizer; fall back to 8.3 rules.
pub fn route(site: &Value) -> String {
    if let Some(runtime) = site.get("runtime").and_then(Value::as_str) {
        return match runtime {
            "python" | "quickjs" | "jvm" => runtime.to_string(),
            _ => "cms".to_string(),
        };
    }
    let jar = site.get("jar").and_then(Value::as_str).unwrap_or("");
    let api = site.get("api").and_then(Value::as_str).unwrap_or("");
    let key = site.get("key").and_then(Value::as_str).unwrap_or("");
    if jar == "py" || api.ends_with(".py") {
        return "python".to_string();
    }
    if jar == "js" || api.ends_with(".js") {
        return "quickjs".to_string();
    }
    if key.starts_with("csp_") || jar.ends_with(".jar") {
        return "jvm".to_string();
    }
    "cms".to_string()
}

#[tauri::command]
pub async fn spider_invoke(
    state: tauri::State<'_, ConfigStore>,
    request: SpiderRequest,
) -> Result<Value, AppError> {
    let site = state.find_site(&request.site_key)?;
    match route(&site).as_str() {
        "cms" => cms::invoke(&site, request.method, &request.args).await,
        other => Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            format!("runtime {other} not implemented yet"),
        )),
    }
}
