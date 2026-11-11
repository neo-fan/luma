/**
 * 归一化数据契约（规格书 6.2 + 7.1）。
 *
 * 本文件是前端唯一的数据形状来源；字段变更须同步：
 *   contracts/tvbox.schema.json（真源）
 *   src-tauri/src/error.rs 等 serde 结构
 *   sidecars/py 的输出 JSON
 * 三者由 tests/e2e/contract_check.py 比对（v1.1 R8）。
 */

/** 站点运行时分派结果（6.2） */
export type RuntimeKind = "cms" | "python" | "quickjs" | "jvm";

/** 统一错误码（6.3 表格 + v1.1 补充字段） */
export interface AppError {
  code: string;
  message: string;
  cause?: string;
  /** 原始配置是否已留存，便于诊断（7.2 错误帧） */
  rawSaved?: boolean;
  details?: Record<string, unknown>;
}

/** 归一化后的站点（6.2） */
export interface Site {
  key: string;
  name: string;
  runtime: RuntimeKind;
  api: string;
  jar?: string;
  type?: number;
  /** 原样透传，常为加密 jar 参数；丢失会导致大批 jar 源失效（8.5） */
  ext?: string;
  headers: Record<string, string>;
  searchable: boolean;
  quickSearch: boolean;
  filterable: boolean;
  categories: { type_id: string; type_name: string }[];
  timeoutMs: number;
  /** 崩溃/超时次数超阈值后置 false；导入时的支持范围屏蔽同样置 false。 */
  enabled: boolean;
  /** 存在时说明该源在运行配置中被主动屏蔽（jar / JS 源），导入配置仍保留它。 */
  disabledReason?: string;
  /** TVBox `changeable`：false 表示该源不允许跨站换源。 */
  changeable?: boolean;
  /** TVBox `playerType`：源建议的播放内核（原样透传）。 */
  playerType?: number | string;
  /** TVBox `order_num`：站点排序权重。 */
  orderNum?: number;
}

/** 点播条目（6.2，保留 TVBox 原始字段名） */
export interface VodInfo {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_content?: string;
  vod_year?: string;
  vod_area?: string;
  vod_actor?: string;
  vod_director?: string;
  type_name?: string;
  /** 线路名，$$$ 分隔 */
  vod_play_from: string;
  /** 剧集，"名称$地址#..."，$$$ 分隔线路 */
  vod_play_url: string;
}

/** 聚合结果页（6.2） */
export interface ResultPage {
  list: VodInfo[];
  filters: Record<
    string,
    { key: string; name: string; value: { n: string; v: string }[] }[]
  >;
  pagecount: number;
  page: number;
  limit: number;
  total: number;
  classes?: { type_id: string; type_name: string }[];
}

/** 对外暴露的 6 个 spider 方法（6.2；与 8.4 的 12 个 jar 反射方法不是同一集合） */
export type SpiderMethod =
  | "homeContent"
  | "categoryContent"
  | "detailContent"
  | "searchContent"
  | "playerContent"
  | "liveContent";

/** 播放目标（6.2） */
export interface PlayTarget {
  kind: "webview" | "proxy" | "mpv" | "external";
  url: string;
  headers: Record<string, string>;
  parse?: "hls" | "mpegts" | "direct";
}

/** 配置来源（7.1） */
export interface ConfigSource {
  kind: "url" | "file" | "text";
  value: string;
  /** 导入时用户填写的配置名；后端落库前会清空（名字存在快照里）。 */
  name?: string;
}

/** spider 调用请求（7.1） */
export interface SpiderRequest {
  /** 'all' 表示聚合所有启用站点 */
  siteKey: string;
  method: SpiderMethod;
  /** 原样透传给底层方法 */
  args: unknown[];
  /** 默认 15000，墙钟 */
  timeoutMs?: number;
}

/** HTTP 拉取请求（7.1） */
export interface FetchRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * 下列类型对应 Rust 侧 serde 结构与 contracts/tvbox.schema.json（契约真源）。
 * 字段随真实配置兼容需求增补，改动时三处须同步。
 */

/** 归一化后的配置快照，含 sites / lives / parses / flags 等配置级字段。 */
export interface ConfigSnapshot {
  id: string;
  name: string;
  importedAt: string;
  sites: Site[];
  lives: unknown[];
  parses: unknown[];
}

/** 配置管理列表项 */
export interface ConfigMeta {
  id: string;
  name: string;
  source: ConfigSource;
  importedAt: string;
}

/** HTTP 拉取结果（http_fetch 返回） */
export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 播放地址解析请求（resolve_play 入参） */
export interface PlayRequest {
  siteKey: string;
  url: string;
  ua?: string;
  referer?: string;
  cookie?: string;
}

/** 播放目标（resolve_play 返回） */
export interface PlayResolved {
  url: string;
  proxyUrl: string;
  /** hls / flv / file / page */
  kind: string;
  headers: [string, string][];
}

/** parses[] 通用解析请求（TVBox `parse=1` / `jx=1` 时使用） */
export interface ParseRequest {
  siteKey: string;
  /** playerContent 返回的播放页 / 线路值 */
  url: string;
  /** 线路名，用于 ext.flag 匹配 */
  flag?: string;
  headers?: Record<string, string>;
}

/** 解析池命中结果 */
export interface ParseResolved {
  url: string;
  /** 命中的解析器名，用于「解析来自 xxx」提示 */
  parser: string;
  /** json / webview */
  kind: string;
  headers: [string, string][];
  /** 已尝试且失败的解析器，形如 `name: reason` */
  tried: string[];
}

/** 本地反代状态（7.5） */
export interface ProxyStatus {
  port: number;
  baseUrl: string;
  allowLocal: boolean;
}

/** 收藏 / 历史共用的条目引用 */
export interface VodRef {
  siteKey: string;
  vodId: string;
  name: string;
  pic?: string;
  remarks?: string;
  siteName?: string;
}

export interface FavoriteItem extends VodRef {
  addedAt: number;
}

export interface HistoryItem extends VodRef {
  playUrl?: string;
  positionMs?: number;
  durationMs?: number;
  updatedAt: number;
}

/** 单个站点的首页结果（8.2） */
export interface HomeResult {
  classes: { type_id: string; type_name: string }[];
  list: VodInfo[];
  filters: ResultPage["filters"];
}


/** 直播源（lives[] 条目，7.x） */
export interface LiveSource {
  name: string;
  /** 列表地址；`channels` 型分组容器没有 url。 */
  url?: string;
  type?: number;
  ua?: string;
  playerType?: number | string;
  timeZone?: string;
  timeout?: number;
  /** EPG 模板，形如 `https://epg/...?ch={name}&date={date}`。 */
  epg?: string;
  logo?: string;
  pass?: string;
  /** 分组容器：`{"group": "x", "channels": [{"name", "urls": []}]}`。 */
  group?: string;
  channels?: { name?: string; urls?: string[] }[];
}

export interface LiveChannel {
  name: string;
  url: string;
  logo?: string;
  epg?: string;
}

export interface LiveGroup {
  name: string;
  channels: LiveChannel[];
}

export interface LiveListResult {
  groups: LiveGroup[];
  source?: string;
  count?: number;
}

/** 试运行诊断（`diagnostics` command）：版本 / 目录 / 当前配置规模 / 日志。 */
export interface DiagnosticsConfig {
  id: string;
  name: string;
  sites: number;
  enabled: number;
  blocked: number;
  jvm: number;
  quickjs: number;
  lives: number;
  parses: number;
  headers: number;
}

export interface DiagnosticsLogFile {
  name: string;
  bytes: number;
}

export interface Diagnostics {
  version: string;
  os: string;
  arch: string;
  dataDir: string;
  logDir: string;
  dbPath: string;
  config: DiagnosticsConfig | null;
  logFiles: DiagnosticsLogFile[];
  logBytes: number;
}
