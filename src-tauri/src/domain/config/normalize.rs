//! 配置字段方言归一化 + 站点路由。
//!
//! 社区配置同一件事有好几种写法：顶层 `list` / `parse` / `jar`，站点里 `title`
//! 当名字，`headers` 有时是对象有时是 JSON 字符串，相对路径 `./py/x.py` 要相对
//! 配置地址解析。这里把它们收敛成 `ConfigSnapshot` 的形状，认不出的字段一律
//! 塞进 `_raw`（不丢数据），下游只读归一化结果。
//!
//! 这些函数都是纯函数、同步、零 IPC：导入直接走宿主进程，不必排队等 Python
//! 适配层，也不需要 30s 预算兜底。

use super::deproxy;
use crate::error::{code, AppError};
use crate::spider::DEFAULT_TIMEOUT_MS;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

const TOP_ALIASES: [(&str, &str); 3] = [("list", "sites"), ("parse", "parses"), ("jar", "spider")];
const SITE_ALIASES: [(&str, &str); 1] = [("title", "name")];

/// 站点上「认识」的字段：认识的会进结构化输出，不认识的进 `_raw`。
fn site_known() -> BTreeSet<&'static str> {
    [
        "key",
        "name",
        "type",
        "api",
        "jar",
        "ext",
        "header",
        "headers",
        "ua",
        "searchable",
        "quickSearch",
        "filterable",
        "filter",
        "categories",
        "timeout",
        "playerType",
        "changeable",
        "style",
        "indexs",
        "title",
    ]
    .into_iter()
    .collect()
}

fn config_known() -> BTreeSet<&'static str> {
    [
        "sites",
        "list",
        "lives",
        "parses",
        "parse",
        "spider",
        "jar",
        "wallpaper",
        "flags",
        "headers",
        "ua",
        "urls",
        "home",
        "rules",
        "hosts",
        "logo",
    ]
    .into_iter()
    .collect()
}

/// Spec 8.3 的路由优先级：python / quickjs / jvm / cms，分组分隔条是 `none`。
pub fn route(site: &Map<String, Value>, global_spider: Option<&str>) -> &'static str {
    let jar = text_of(site.get("jar"));
    let api = text_of(site.get("api"));
    let key = text_of(site.get("key"));

    if jar == "py" || api.ends_with(".py") {
        return "python";
    }
    if jar == "js" || api.ends_with(".js") {
        return "quickjs";
    }
    if key.starts_with("csp_") || jar.ends_with(".jar") {
        return "jvm";
    }
    // 裸类名（`api: "csp_Xxx"`）也是 jvm：它不是 URL，也不带扩展名。
    if api.starts_with("csp_")
        || (!api.is_empty()
            && !api.starts_with("http://")
            && !api.starts_with("https://")
            && !api.contains('/'))
    {
        return "jvm";
    }
    // 分组分隔条（`{"key":"1","name":"--- 1 ---"}`）什么源都不是。让它继承全局
    // spider 会被当成 jvm 站点，白烧一次必然失败的调用。
    if api.is_empty() && !truthy(site.get("ext")) && !truthy(site.get("jar")) {
        return "none";
    }
    if global_spider.is_some() && api.is_empty() {
        return "jvm";
    }
    if matches!(site.get("type").and_then(Value::as_i64), Some(0 | 1 | 4)) {
        return "cms";
    }
    "cms"
}

/// 归一化单个站点；`global_spider` 是配置级 `spider`（`csp_*` 站点的 jar 来源）。
pub fn normalize_site(
    raw: &Map<String, Value>,
    global_spider: Option<&str>,
    origin: &str,
) -> Value {
    let mut site = raw.clone();
    for (alias, canonical) in SITE_ALIASES {
        if !site.contains_key(canonical) && site.contains_key(alias) {
            if let Some(value) = site.get(alias).cloned() {
                site.insert(canonical.to_string(), value);
            }
        }
    }

    // 先解析相对引用再路由：`./py/x.py` 变成真 URL 才会被判成 python 源。
    for field in ["api", "jar", "logo", "ext"] {
        if let Some(value) = site.get(field).cloned() {
            site.insert(field.to_string(), resolve_ref(origin, &value));
        }
    }

    // 第三方 TVBox 壳会把「指向本机转发服务」的地址直接写进 api（如
    // `127.0.0.1:<port>/p/<n>/proxy/<url>`）：那个端口只在壳进程里存在，原样
    // 留着等于每个请求都连本机一个不存在的服务。真实地址就嵌在路径里，剥壳
    // 直连（规则见 deproxy 模块头，不绑定具体前缀）。
    if let Some(api) = site.get("api").and_then(Value::as_str) {
        if let Some(restored) = deproxy::restore(api) {
            site.insert("api".into(), Value::String(restored));
        }
    }

    let runtime = route(&site, global_spider);
    let timeout_ms = parse_timeout(site.get("timeout"));

    let mut out = Map::new();
    out.insert("key".into(), text_of(site.get("key")).into());
    out.insert("name".into(), {
        let name = text_of(site.get("name"));
        if name.is_empty() {
            text_of(site.get("key")).into()
        } else {
            name.into()
        }
    });
    out.insert("runtime".into(), runtime.into());
    out.insert("api".into(), text_of(site.get("api")).into());
    out.insert(
        "headers".into(),
        header_map(
            site.get("headers")
                .filter(|v| truthy(Some(v)))
                .or_else(|| site.get("header")),
        ),
    );
    // 缺省语义在各分支相反：Box/TVBoxOS 的 `int searchable` 缺省 0（不可搜），
    // FongMi 的 `Integer searchable` 缺省按 1 算。社区配置大量站点干脆不写这个
    // 字段，按 0 处理会把半个配置的可用源误判成不可搜（实测 101 站里 52 站未
    // 声明，其中 19 站是能搜的 py/js 源）。这里取可搜为缺省，真实「显式关闭」
    // 由 `searchableDeclared` 保住。
    out.insert(
        "searchable".into(),
        bool_of(site.get("searchable").unwrap_or(&json!(1))).into(),
    );
    out.insert(
        "quickSearch".into(),
        bool_of(site.get("quickSearch").unwrap_or(&json!(0))).into(),
    );
    out.insert(
        "filterable".into(),
        bool_of(site.get("filterable").unwrap_or(&json!(0))).into(),
    );
    out.insert("categories".into(), categories(site.get("categories")));
    out.insert("timeoutMs".into(), timeout_ms.into());
    // 分组分隔条留在快照里（界面能当标题渲染），但不参与任何扇出。
    out.insert("enabled".into(), (runtime != "none").into());

    // 规范要求原样透传的字段：放进 `site_known` 只表示「不进 _raw」，还得真的
    // 复制一份，否则整个字段会从快照里消失。
    for passed in [
        "jar",
        "ext",
        "type",
        "ua",
        "filter",
        "playerType",
        "style",
        "indexs",
    ] {
        if let Some(value) = site.get(passed) {
            if !matches!(value, Value::Null) && !is_empty_value(value) {
                out.insert(passed.to_string(), value.clone());
            }
        }
    }
    // 只有配置**显式写了** `searchable` 才输出：聚合搜索据此跳过
    // `searchable: 0` 的源（TVBox 语义是「别对我发起搜索」）。
    if let Some(value) = site.get("searchable") {
        out.insert("searchableDeclared".into(), bool_of(value).into());
    }
    if let Some(value) = site.get("changeable") {
        out.insert("changeable".into(), bool_of(value).into());
    }
    if let Some(order) = site.get("order_num") {
        if !order.is_boolean() {
            if let Some(number) = int_of(order) {
                out.insert("orderNum".into(), number.into());
            }
        }
    }

    let mut rest = Map::new();
    for (key, value) in &site {
        if !site_known().contains(key.as_str()) && !SITE_ALIASES.iter().any(|(a, _)| a == key) {
            rest.insert(key.clone(), value.clone());
        }
    }
    if runtime == "cms" && !matches!(site.get("type").and_then(Value::as_i64), Some(0 | 1 | 4)) {
        rest.insert("needsProbe".into(), Value::Bool(true));
    }
    out.insert("_raw".into(), Value::Object(rest));
    Value::Object(out)
}

/// 归一化整份配置。`origin` 是导入来源（url / 文件路径 / `inline`），相对引用
/// 相对它解析。
pub fn normalize_config(raw: &Value, origin: &str) -> Result<Value, AppError> {
    let Value::Object(raw_obj) = raw else {
        return Err(AppError::new(
            code::DIALECT_UNKNOWN,
            "config must be a JSON object",
        ));
    };
    let mut config = raw_obj.clone();
    // 订阅地址自己也可能带笔误（`https://https://…`）：相对引用要用它当基准，
    // 先纠正再解析，否则 `./lib/iptv.m3u` 会拼到畸形主机上。
    //
    // 只影响**解析基准**：`origin` 本身继续参与 `short_hash`（配置 id）与默认
    // 命名。否则同一个订阅纠正前后会算出两个 id，重新导入变成多出一份重复配置。
    let base_owned = repair_url(origin).unwrap_or_else(|| origin.to_string());
    let base = base_owned.as_str();
    for (alias, canonical) in TOP_ALIASES {
        if !config.contains_key(canonical) && config.contains_key(alias) {
            if let Some(value) = config.get(alias).cloned() {
                config.insert(canonical.to_string(), value);
            }
        }
    }

    let spider_raw = config
        .get("spider")
        .filter(|v| truthy(Some(v)))
        .or_else(|| config.get("jar").filter(|v| truthy(Some(v))));
    let spider_value = spider_raw.and_then(|value| match value {
        Value::String(_) => match resolve_ref(base, value) {
            Value::String(text) => Some(text),
            _ => None,
        },
        _ => None,
    });

    let sites: Vec<Value> = match config.get("sites") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .map(|site| normalize_site(site, spider_value.as_deref(), base))
            .collect(),
        _ => Vec::new(),
    };
    // `csp_*` 站点自己没有 jar，配置级 `spider` 就是它们的类来源；导入期挂上，
    // 分类和屏蔽原因才能落到这些站点上（JVM 运行时已移除，分类保留）。
    let sites: Vec<Value> = match &spider_value {
        Some(spider) => sites
            .into_iter()
            .map(|mut site| {
                let is_jvm = site.get("runtime").and_then(Value::as_str) == Some("jvm");
                let has_jar = truthy(site.get("jar"));
                if is_jvm && !has_jar {
                    if let Some(obj) = site.as_object_mut() {
                        obj.insert("jar".into(), Value::String(spider.clone()));
                    }
                }
                site
            })
            .collect(),
        None => sites,
    };

    let lives = resolve_items(config.get("lives"), base);
    let parses = resolve_items(
        config
            .get("parses")
            .filter(|v| truthy(Some(v)))
            .or_else(|| config.get("parse")),
        base,
    );

    let mut rest = Map::new();
    for (key, value) in &config {
        if !config_known().contains(key.as_str()) {
            rest.insert(key.clone(), value.clone());
        }
    }

    let mut snapshot = json!({
        "id": short_hash(origin),
        "name": config_name(&config, origin),
        "importedAt": now_rfc3339(),
        "sites": sites,
        "lives": lives,
        "parses": parses,
        // 反盗链 CDN 的 host → header 表（UA/Referer 按 host 注入）。
        "headers": host_rules(config.get("headers")),
        "spider": match spider_value { Some(text) => Value::String(text), None => Value::Null },
        "wallpaper": config.get("wallpaper").cloned().unwrap_or(Value::Null),
        "flags": match config.get("flags") {
            Some(Value::Array(items)) => Value::Array(items.clone()),
            _ => Value::Array(Vec::new()),
        },
        "_raw": Value::Object(rest),
    });
    // 纠正落库前的最后一道：订阅里写歪的地址（`https://https://…` 这类）在这里
    // 治干净，之后所有下游（直播解析、播放、EPG）读到的都是可用地址。`_raw` 也要
    // 过——前端「查看原始配置」与重新归一化都会读它，留着坏地址等于留个后门。
    let repaired = repair_value(&mut snapshot);
    if repaired > 0 {
        tracing::warn!(repaired, "config import corrected malformed urls");
    }
    Ok(snapshot)
}

/// 合并多仓快照：站点 key 先到先得，直播与解析直接拼接。
///
/// 配置级字段（headers/spider/wallpaper/flags/_raw）同样来自每个仓库，不能丢：
/// 尤其 `headers`（反盗链 host → UA/Referer）是功能性数据，丢了会让依赖 Referer
/// 的封面/播放 403。策略与 sites 一致——可去重的按「先到先得」，列表型拼接，
/// 标量型取第一个有值的。
pub fn merge_repos(snapshots: &[Value]) -> Value {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut sites: Vec<Value> = Vec::new();
    let mut lives: Vec<Value> = Vec::new();
    let mut parses: Vec<Value> = Vec::new();
    let mut headers: Vec<Value> = Vec::new();
    let mut seen_host: BTreeSet<String> = BTreeSet::new();
    let mut flags: Vec<Value> = Vec::new();
    let mut spider: Option<Value> = None;
    let mut wallpaper: Option<Value> = None;
    let mut raw: Option<Value> = None;
    // MSRV 1.77.2：不用 Option::is_none_or（1.82+），match 手写等价判断。
    let present = |v: &Value| match v {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        _ => true,
    };
    for snapshot in snapshots {
        if let Some(items) = snapshot.get("sites").and_then(Value::as_array) {
            for site in items {
                let key = text_of(site.get("key"));
                if !key.is_empty() && seen.contains(&key) {
                    continue;
                }
                seen.insert(key);
                sites.push(site.clone());
            }
        }
        if let Some(items) = snapshot.get("lives").and_then(Value::as_array) {
            lives.extend(items.iter().cloned());
        }
        if let Some(items) = snapshot.get("parses").and_then(Value::as_array) {
            parses.extend(items.iter().cloned());
        }
        if let Some(items) = snapshot.get("headers").and_then(Value::as_array) {
            for header in items {
                let host = text_of(header.get("host"));
                if !host.is_empty() && seen_host.contains(&host) {
                    continue;
                }
                seen_host.insert(host);
                headers.push(header.clone());
            }
        }
        if let Some(items) = snapshot.get("flags").and_then(Value::as_array) {
            flags.extend(items.iter().cloned());
        }
        if spider.is_none() {
            if let Some(v) = snapshot.get("spider").filter(|v| present(v)) {
                spider = Some(v.clone());
            }
        }
        if wallpaper.is_none() {
            if let Some(v) = snapshot.get("wallpaper").filter(|v| present(v)) {
                wallpaper = Some(v.clone());
            }
        }
        if raw.is_none() {
            if let Some(v) = snapshot.get("_raw").filter(|v| present(v)) {
                raw = Some(v.clone());
            }
        }
    }
    let ids: Vec<String> = snapshots
        .iter()
        .map(|snapshot| text_of(snapshot.get("id")))
        .collect();
    json!({
        "id": short_hash(&ids.join("|")),
        "name": "merged",
        "importedAt": now_rfc3339(),
        "sites": sites,
        "lives": lives,
        "parses": parses,
        "headers": headers,
        "spider": spider.unwrap_or(Value::Null),
        "wallpaper": wallpaper.unwrap_or(Value::Null),
        "flags": flags,
        "_raw": raw.unwrap_or(Value::Null),
    })
}

/// 纠正**确定性畸形**的 http(s) 地址，只在 leading 区动手；`Some` = 改过了。
///
/// 三类（都是社区订阅里实测存在的写法，正常 URL 不可能长成这样）：
///   1. 重复前导 scheme：`https://https://host/x` → `https://host/x`。
///      `cluntop/tvbox` 的 `box.json` 第 10 条直播源就是这一类。合法的加速前缀
///      第二段 scheme 前面一定有 `/`（`https://gh-proxy.com/https://raw...`），
///      所以「scheme 紧跟 scheme」才是笔误；保留最内层——那才是贴着主机的一个。
///   2. scheme 后多余的斜杠：`https:///host/x` → `https://host/x`（空主机名必失败）。
///   3. scheme 后的空白：`https:// host/x` → `https://host/x`，顺带吃掉首尾空白。
///
/// 刻意**不做**：不补 scheme（`host/x` 归相对解析管）、不改大小写、不碰
/// `magnet:` / `ws:` / `data:` 等非 http(s) 协议——猜出来的地址比坏地址更难查。
///
/// **全局只有这一处**：纠正发生在导入转换（`normalize_config`）与启动自愈
/// （`ConfigStore::load` 重放同一函数并落库），请求路径不再兜底。数据在落库前
/// 就是干净的，下游（`live_parse`、播放、EPG）读到的永远是纠正后的地址。
pub fn repair_url(text: &str) -> Option<String> {
    let head_end = text.find("://")?;
    let raw_scheme = &text[..head_end];
    let scheme = raw_scheme.trim();
    if !is_scheme(scheme) {
        return None;
    }
    let mut rest = &text[head_end + 3..];
    // 空白与多余斜杠都只可能出现在主机名之前，反复剥直到落定；层数封顶，
    // 免得将来有人塞进一条病态长串把这里变成循环。
    for _ in 0..8 {
        // 先绑定 trim 结果：`trim_start().strip_prefix('/').unwrap_or(rest)` 里的
        // `rest` 是赋值前的旧值，直接写会把刚 trim 掉的结果又换回未 trim 的那份。
        let trimmed = rest.trim_start();
        rest = trimmed.strip_prefix('/').unwrap_or(trimmed);
        match strip_scheme_prefix(rest) {
            Some(inner) => rest = inner,
            None => break,
        }
    }
    let repaired = format!("{scheme}://{rest}");
    (repaired != text).then_some(repaired)
}

fn is_scheme(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower == "http" || lower == "https"
}

/// `http://x` / `https://x`（大小写不限）→ 去掉 scheme 后的剩余；否则 None。
///
/// 比的是**字节**而不是 `str` 切片：`rest` 是外部数据，`://` 后面完全可能是
/// 中文域名（`http://饭太硬.top/…`）。`rest[..8]` 按字节切，一旦落进多字节
/// 字符内部就 panic，而 release 是 `panic = "abort"` → 整个进程直接退出。
/// scheme 本身是纯 ASCII，字节前缀相等就必然落在字符边界上，`&rest[len..]`
/// 因此安全。
fn strip_scheme_prefix(rest: &str) -> Option<&str> {
    let bytes = rest.as_bytes();
    for scheme in ["https://", "http://"] {
        if bytes.len() >= scheme.len()
            && bytes[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes())
        {
            return Some(&rest[scheme.len()..]);
        }
    }
    None
}

/// 纠正一份**已入库**的快照，返回改动条数。字段覆盖与
/// `ghproxy::rewrite_snapshot` 一致（含 `_raw`），两处按同一顺序遍历，
/// 免得以后加字段时只改一处、另一处静默漏掉。
pub fn repair_snapshot(snapshot: &mut crate::config::ConfigSnapshot) -> usize {
    let mut changed = 0;
    for site in snapshot.sites.iter_mut() {
        changed += repair_value(site);
    }
    for item in snapshot.lives.iter_mut() {
        changed += repair_value(item);
    }
    for item in snapshot.parses.iter_mut() {
        changed += repair_value(item);
    }
    for item in snapshot.headers.iter_mut() {
        changed += repair_value(item);
    }
    for item in snapshot.flags.iter_mut() {
        changed += repair_value(item);
    }
    if let Some(spider) = snapshot.spider.as_mut() {
        if let Some(repaired) = repair_url(spider) {
            tracing::warn!(from = %spider, to = %repaired, "config url repaired");
            *spider = repaired;
            changed += 1;
        }
    }
    if let Some(wallpaper) = snapshot.wallpaper.as_mut() {
        if let Some(repaired) = repair_url(wallpaper) {
            tracing::warn!(from = %wallpaper, to = %repaired, "config url repaired");
            *wallpaper = repaired;
            changed += 1;
        }
    }
    changed + repair_value(&mut snapshot.raw)
}

/// 递归纠正一棵 JSON 子树里的地址，返回改动条数（形状不认识的一律跳过）。
/// 递归形状与 `ghproxy::rewrite_value` 保持一致：那里按主机改写，这里按笔误纠正，
/// 两条规则各自独立、都不依赖对方先跑过。
pub fn repair_value(value: &mut Value) -> usize {
    match value {
        Value::String(text) => match repair_url(text) {
            Some(repaired) => {
                tracing::warn!(from = %text, to = %repaired, "config url repaired");
                *text = repaired;
                1
            }
            None => 0,
        },
        Value::Array(items) => items.iter_mut().map(repair_value).sum(),
        Value::Object(map) => map.values_mut().map(repair_value).sum(),
        _ => 0,
    }
}

/// `./py/x.py`、`../lib/a.m3u`、`/jar/x.jar` 相对配置来源解析；其余原样返回。
pub fn resolve_ref(origin: &str, value: &Value) -> Value {
    let Value::String(text) = value else {
        return value.clone();
    };
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || !(trimmed.starts_with("./") || trimmed.starts_with("../") || trimmed.starts_with('/'))
    {
        return value.clone();
    }
    let base = base_dir(origin);
    if base.is_empty() {
        return value.clone();
    }
    let Ok(base_url) = url::Url::parse(&base) else {
        return value.clone();
    };
    match base_url.join(trimmed) {
        Ok(joined) if matches!(joined.scheme(), "http" | "https" | "file") => {
            Value::String(joined.to_string())
        }
        _ => value.clone(),
    }
}

/// 配置所在目录：`https://h/a/box.json` → `https://h/a/`。
fn base_dir(origin: &str) -> String {
    let origin = origin.trim();
    if !(origin.starts_with("http://")
        || origin.starts_with("https://")
        || origin.starts_with("file://"))
    {
        return String::new();
    }
    match origin.rsplit_once('/') {
        Some((head, tail)) if !tail.is_empty() => format!("{head}/"),
        _ => origin.to_string(),
    }
}

fn resolve_items(items: Option<&Value>, origin: &str) -> Vec<Value> {
    let Some(Value::Array(items)) = items else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| match item {
            Value::Object(obj) if obj.contains_key("url") => {
                let mut obj = obj.clone();
                if let Some(url) = obj.get("url").cloned() {
                    let mut resolved = resolve_ref(origin, &url);
                    // 直播源同样可能套着 TVBox 本机代理；能剥出公网地址就剥，
                    // `/c/<秒>/…` 这类转码路径剥不出来，原样保留。
                    if let Some(restored) = resolved.as_str().and_then(deproxy::restore) {
                        resolved = Value::String(restored);
                    }
                    obj.insert("url".into(), resolved);
                }
                Value::Object(obj)
            }
            other => other.clone(),
        })
        .collect()
}

/// 顶层 `headers` 表：`[{host, header:{...}}]`，空值过滤掉。
fn host_rules(value: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let host = text_of(obj.get("host")).trim().to_string();
        if host.is_empty() {
            continue;
        }
        let header = obj
            .get("header")
            .filter(|v| truthy(Some(v)))
            .or_else(|| obj.get("headers"));
        let Value::Object(pairs) = header_map(header) else {
            continue;
        };
        if pairs.is_empty() {
            continue;
        }
        out.push(json!({ "host": host, "header": Value::Object(pairs) }));
    }
    out
}

fn header_map(value: Option<&Value>) -> Value {
    let Value::Object(pairs) = stringify_map(value) else {
        return Value::Object(Map::new());
    };
    Value::Object(pairs)
}

fn stringify_map(value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return Value::Object(Map::new());
    };
    match value {
        Value::Object(map) => Value::Object(non_empty_pairs(map)),
        Value::String(text) if !text.trim().is_empty() => match serde_json::from_str::<Value>(text)
        {
            Ok(Value::Object(map)) => Value::Object(non_empty_pairs(&map)),
            _ => Value::Object(Map::new()),
        },
        _ => Value::Object(Map::new()),
    }
}

/// 把值统一成字符串并丢掉空值：上游配置里 `{"Referer": "x", "Empty": ""}`
/// 很常见，空头留着会让请求多带一个 `Empty:`（部分站点会 400）。
fn non_empty_pairs(map: &Map<String, Value>) -> Map<String, Value> {
    map.iter()
        .filter_map(|(key, value)| {
            let text = text_of(Some(value));
            if text.is_empty() {
                None
            } else {
                Some((key.clone(), Value::String(text)))
            }
        })
        .collect()
}

fn categories(value: Option<&Value>) -> Value {
    let Some(Value::Array(items)) = value else {
        return Value::Array(Vec::new());
    };
    let mut out = Vec::new();
    for item in items {
        match item {
            Value::Object(obj) => {
                let id = first_text(obj.get("type_id"), obj.get("id"));
                let name = first_text(obj.get("type_name"), obj.get("name"));
                out.push(json!({ "type_id": id, "type_name": name }));
            }
            Value::String(text) => {
                out.push(json!({ "type_id": text, "type_name": text }));
            }
            _ => {}
        }
    }
    Value::Array(out)
}

fn first_text(primary: Option<&Value>, fallback: Option<&Value>) -> String {
    let value = text_of(primary);
    if value.is_empty() {
        text_of(fallback)
    } else {
        value
    }
}

/// Python `str()` 的等价物：字符串原样，数字按文本，null 当空串。
fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(other) => other.to_string(),
    }
}

/// Python 真值：null / 0 / "" / false / [] / {} 为假。
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|n| n != 0.0).unwrap_or(true),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

fn bool_of(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::Null => false,
        other => matches!(
            other.to_string().trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
    }
}

fn int_of(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|n| n.trunc() as i64)),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        Value::Bool(flag) => Some(i64::from(*flag)),
        _ => None,
    }
}

/// `timeout` 是秒（社区配置里常写成 `"15"`），坏值退回 15s。
fn parse_timeout(value: Option<&Value>) -> i64 {
    match value {
        Some(value) if truthy(Some(value)) => int_of(value)
            .map(|n| n * 1000)
            .unwrap_or(DEFAULT_TIMEOUT_MS as i64),
        _ => DEFAULT_TIMEOUT_MS as i64,
    }
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// 配置名：`name` → 文件名主干 → 主机名 → 「本地配置」。
fn config_name(config: &Map<String, Value>, origin: &str) -> String {
    let explicit = text_of(config.get("name")).trim().to_string();
    if !explicit.is_empty() {
        return explicit;
    }
    let cleaned = origin.trim_end_matches('/');
    let tail = cleaned.rsplit('/').next().unwrap_or("");
    if !tail.is_empty() && !tail.starts_with("http") && !tail.contains('?') {
        let stem = tail.split('.').next().unwrap_or("");
        if !stem.is_empty() {
            return stem.to_string();
        }
    }
    for scheme in ["https://", "http://"] {
        if let Some(rest) = cleaned.strip_prefix(scheme) {
            let host = rest.split('/').next().unwrap_or("");
            if !host.is_empty() {
                return host.to_string();
            }
        }
    }
    "本地配置".to_string()
}

fn short_hash(text: &str) -> String {
    // XXH3（xxhash-rust）稳定指纹，非加密用途足够。2.0.0 起取代 sha1[..12]：
    // 换算法会让已导入配置换 id（收藏/历史对不上），用户重新初始化，已授权。
    let hash = xxhash_rust::xxh3::xxh3_64(text.as_bytes());
    format!("{hash:016x}")[..12].to_string()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn routes_follow_spec_priority() {
        assert_eq!(
            route(&site(json!({"api": "https://h/api.php/provide/vod"})), None),
            "cms"
        );
        assert_eq!(
            route(
                &site(json!({"api": "https://h/py/all.py", "jar": "py"})),
                None
            ),
            "python"
        );
        assert_eq!(route(&site(json!({"api": "./js/a.js"})), None), "quickjs");
        assert_eq!(route(&site(json!({"key": "csp_abc"})), None), "jvm");
        assert_eq!(route(&site(json!({"jar": "https://h/x.jar"})), None), "jvm");
        assert_eq!(route(&site(json!({"api": "csp_Xxx"})), None), "jvm");
        // 分组分隔条既不继承全局 spider，也不算 jvm。
        assert_eq!(
            route(
                &site(json!({"key": "1", "name": "--- 1 ---"})),
                Some("https://h/s.jar")
            ),
            "none"
        );
        // 空 api 且无 ext/jar 时先命中分隔条判定，与 sidecars/py/normalize.py 一致。
        assert_eq!(
            route(&site(json!({"api": ""})), Some("https://h/s.jar")),
            "none"
        );
        assert_eq!(route(&site(json!({"api": "https://h/api"})), None), "cms");
    }

    #[test]
    fn site_aliases_defaults_and_raw_are_normalized() {
        let raw = site(json!({
            "key": "a",
            "title": "站点A",
            "api": "https://h/api.php/provide/vod",
            "type": 3,
            "header": "{\"Referer\":\"https://h/\"}",
            "order_num": 7,
            "searchable": 0,
            "whatever": {"keep": true}
        }));
        let out = normalize_site(&raw, None, "https://h/box.json");
        assert_eq!(out["name"], "站点A");
        assert_eq!(out["runtime"], "cms");
        assert_eq!(out["headers"]["Referer"], "https://h/");
        assert_eq!(out["orderNum"], 7);
        assert_eq!(out["searchable"], false);
        assert_eq!(out["searchableDeclared"], false);
        assert_eq!(out["_raw"]["whatever"]["keep"], true);
        // type 3 不是已知采集方言 → 必须探活。
        assert_eq!(out["_raw"]["needsProbe"], true);
    }

    #[test]
    fn undeclared_searchable_defaults_to_true() {
        let out = normalize_site(&site(json!({"key": "a", "api": "https://h/api"})), None, "");
        assert_eq!(out["searchable"], true);
        assert!(out.get("searchableDeclared").is_none());
    }

    #[test]
    fn relative_paths_resolve_against_origin() {
        let raw = site(json!({"key": "a", "api": "./py/a.py", "ext": "../lib/x.json"}));
        let out = normalize_site(&raw, None, "https://h/dir/box.json");
        assert_eq!(out["api"], "https://h/dir/py/a.py");
        assert_eq!(out["runtime"], "python");
        assert_eq!(out["ext"], "https://h/lib/x.json");
    }

    #[test]
    fn config_aliases_and_relative_lives_resolve() {
        let raw = json!({
            "name": "测试配置",
            "list": [{"key": "a", "api": "https://h/api"}],
            "parse": [{"name": "p", "url": "./parse/a.json"}],
            "lives": [{"name": "央视频道", "url": "./lib/iptv.m3u"}],
            "headers": [{"host": "cdn.h", "header": {"Referer": "https://h/", "Empty": ""}}],
        });
        let out = normalize_config(&raw, "https://h/dir/box.json").expect("normalize");
        assert_eq!(out["name"], "测试配置");
        assert_eq!(out["sites"][0]["key"], "a");
        assert_eq!(out["lives"][0]["url"], "https://h/dir/lib/iptv.m3u");
        assert_eq!(out["parses"][0]["url"], "https://h/dir/parse/a.json");
        assert_eq!(out["headers"][0]["host"], "cdn.h");
        assert_eq!(out["headers"][0]["header"]["Referer"], "https://h/");
        assert!(out["headers"][0]["header"].get("Empty").is_none());
        assert_eq!(out["id"], short_hash("https://h/dir/box.json"));
    }

    #[test]
    fn repair_url_fixes_deterministic_typos() {
        // 社区订阅里的真实手误（cluntop/tvbox box.json 第 10 条直播源）。
        assert_eq!(
            repair_url("https://https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u"),
            Some(
                "https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u".to_string()
            )
        );
        // 多层嵌套保留最内层（贴着主机的）scheme，大小写不动。
        assert_eq!(
            repair_url("HTTPS://https://http://host/x"),
            Some("HTTPS://host/x".to_string())
        );
        assert_eq!(
            repair_url("https:///host/x"),
            Some("https://host/x".to_string())
        );
        assert_eq!(
            repair_url(" https:// host/x"),
            Some("https://host/x".to_string())
        );
    }

    #[test]
    fn repair_url_leaves_valid_and_unknown_shapes_alone() {
        for keep in [
            // 合法加速前缀：第二段 scheme 前面有 `/`，是代理写法，绝不能动。
            "https://gh-proxy.com/https://raw.githubusercontent.com/a/b/c.m3u",
            "https://ghfast.top/https://github.com/a/b/releases/download/v/x.apk",
            "https://raw.githubusercontent.com/a/b/main/c.m3u",
            "http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fcdn%2Fx.m3u8",
            // 非 http(s) 协议与相对路径一律不猜。
            "magnet:?xt=urn:btih:abc",
            "ws://host/live",
            "data:image/png;base64,AAAA",
            "./lib/iptv.m3u",
            "host/x.m3u",
            "",
            "https://",
        ] {
            assert_eq!(repair_url(keep), None, "不该改写 {keep:?}");
        }
    }

    #[test]
    fn repair_url_survives_non_ascii_host() {
        // cluntop/tvbox 的 jsm.json 顶层 wallpaper 就是中文域名：`://` 后面紧跟
        // `饭太硬`（9 字节）。按字节切 `[..8]` 会落进 `硬`（bytes 6..9）内部，
        // release 是 panic=abort，导入直接变成进程退出。这类地址本身不归
        // repair_url 管（合法 URL，只是 IDN），只能原样返回。
        for keep in [
            "http://饭太硬.top/深色壁纸/api.php",
            "https://中文域名.中国/x",
            "http://中",
            "https://a中bc/x",
        ] {
            assert_eq!(repair_url(keep), None, "不该改写 {keep:?}");
        }
        // 真正需要修的笔误在中文域名上同样要修得动。
        assert_eq!(
            repair_url("https://https://饭太硬.top/深色壁纸/api.php"),
            Some("https://饭太硬.top/深色壁纸/api.php".to_string())
        );
    }

    #[test]
    fn import_keeps_idn_wallpaper_and_does_not_panic() {
        // 端到端守卫：normalize_config 会对快照里每个字符串跑 repair_value，
        // 这里确保走到 wallpaper 时不再 panic，且值原样保留。
        let raw = json!({
            "sites": [],
            "wallpaper": "http://饭太硬.top/深色壁纸/api.php",
        });
        let out = normalize_config(&raw, "https://raw.githubusercontent.com/cluntop/tvbox/refs/heads/main/jsm.json")
            .expect("IDN wallpaper must not abort the import");
        assert_eq!(out["wallpaper"], "http://饭太硬.top/深色壁纸/api.php");
    }

    #[test]
    fn import_repairs_malformed_live_urls() {
        let raw = json!({
            "lives": [
                { "name": "YanG", "url": "https://https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u" },
                { "name": "ok", "url": "https://gh-proxy.com/https://raw.githubusercontent.com/a/b/c.m3u" },
            ],
            "sites": [{"key": "a", "api": "https:///h/api"}],
        });
        let out = normalize_config(&raw, "https://h/dir/box.json").expect("normalize");
        assert_eq!(
            out["lives"][0]["url"],
            "https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u"
        );
        // 合法代理写法原样保留。
        assert_eq!(
            out["lives"][1]["url"],
            "https://gh-proxy.com/https://raw.githubusercontent.com/a/b/c.m3u"
        );
        assert_eq!(out["sites"][0]["api"], "https://h/api");
    }

    #[test]
    fn malformed_origin_repairs_base_but_not_the_config_id() {
        // 订阅地址自己写歪时：相对解析要用纠正后的基准，但 id 必须继续按原样派生，
        // 否则同一个订阅纠正前后会算出两个 id，重新导入变成多出一份重复配置。
        let raw = json!({ "lives": [{ "name": "本地", "url": "./lib/iptv.m3u" }] });
        let out = normalize_config(&raw, "https://https://h/dir/box.json").expect("normalize");
        assert_eq!(out["lives"][0]["url"], "https://h/dir/lib/iptv.m3u");
        assert_eq!(out["id"], short_hash("https://https://h/dir/box.json"));
    }

    #[test]
    fn jvm_sites_inherit_the_global_spider() {
        let raw = json!({
            "spider": "https://h/dir/jar/spider.jar",
            "sites": [{"key": "csp_a", "name": "A", "api": "csp_A"}],
        });
        let out = normalize_config(&raw, "https://h/dir/box.json").expect("normalize");
        assert_eq!(out["sites"][0]["runtime"], "jvm");
        assert_eq!(out["sites"][0]["jar"], "https://h/dir/jar/spider.jar");
        assert_eq!(out["spider"], "https://h/dir/jar/spider.jar");
    }

    #[test]
    fn non_object_config_is_rejected() {
        let err = normalize_config(&json!([1, 2]), "").unwrap_err();
        assert_eq!(err.code.as_str(), code::DIALECT_UNKNOWN);
    }

    #[test]
    fn merge_keeps_first_site_for_duplicate_keys() {
        let first = json!({"id": "a", "sites": [{"key": "x", "name": "1"}], "lives": [{"n": 1}]});
        let second = json!({"id": "b", "sites": [{"key": "x", "name": "2"}, {"key": "y"}], "parses": [{"n": 2}]});
        let merged = merge_repos(&[first, second]);
        assert_eq!(merged["sites"].as_array().unwrap().len(), 2);
        assert_eq!(merged["sites"][0]["name"], "1");
        assert_eq!(merged["lives"].as_array().unwrap().len(), 1);
        assert_eq!(merged["parses"].as_array().unwrap().len(), 1);
        assert_eq!(merged["id"], short_hash("a|b"));
    }

    #[test]
    fn merge_keeps_config_level_fields() {
        let first = json!({
            "id": "a",
            "sites": [{"key": "x"}],
            "headers": [
                {"host": "cdn.one", "header": {"Referer": "https://one/"}},
                {"host": "shared", "header": {"UA": "first"}}
            ],
            "spider": "spider.js",
            "wallpaper": "wall.jpg",
            "flags": [{"n": 1}],
            "_raw": {"k": "v"}
        });
        let second = json!({
            "id": "b",
            "sites": [],
            "headers": [
                {"host": "cdn.two", "header": {"Referer": "https://two/"}},
                {"host": "shared", "header": {"UA": "second"}}
            ],
            "flags": [{"n": 2}]
        });
        let merged = merge_repos(&[first, second]);
        let headers = merged["headers"].as_array().unwrap();
        assert_eq!(headers.len(), 3, "两个仓库的 headers 都保留，同 host 先到先得");
        assert_eq!(headers[0]["host"], "cdn.one");
        assert_eq!(headers[1]["host"], "shared");
        assert_eq!(headers[1]["header"]["UA"], "first");
        assert_eq!(headers[2]["host"], "cdn.two");
        assert_eq!(merged["spider"], "spider.js");
        assert_eq!(merged["wallpaper"], "wall.jpg");
        assert_eq!(merged["flags"].as_array().unwrap().len(), 2);
        assert_eq!(merged["_raw"]["k"], "v");
    }
}
