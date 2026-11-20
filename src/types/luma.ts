/**
 * 归一化数据契约（规格书 6.2 + 7.1）。
 *
 * 本文件是前端唯一的数据形状来源；字段变更须同步：
 *   contracts/luma.schema.json（真源）
 *   src-tauri/src/error.rs 等 serde 结构
 *   sidecars/py 的输出 JSON
 * 三者由 tests/offline/contract_check.py 比对（v1.1 R8）。
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
  /** 归一化后的可搜标记：配置没写时按可搜算（见 `searchableDeclared`）。 */
  searchable: boolean;
  /**
   * 配置里**显式**写了 `searchable` 才出现，值即声明本身。
   * TVBox 各分支对缺省语义相反（Box 默认 0 不可搜 / FongMi 默认 1 可搜），
   * 所以「跳过不可搜源」只能看这个字段，`false` 才是作者明确说别搜。
   */
  searchableDeclared?: boolean;
  quickSearch: boolean;
  filterable: boolean;
  categories: CategoryClass[];
  timeoutMs: number;
  /** 崩溃/超时次数超阈值后置 false；导入时的支持范围屏蔽同样置 false。 */
  enabled: boolean;
  /** 存在时说明该源在运行配置中被主动屏蔽（jar / Android dex），导入配置仍保留它。 */
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
  /**
   * 采集站自带的豆瓣 subject id（字符串形态，`0`/缺失都归一成空串）。
   *
   * 实测 20 个 CMS 站 260 条样本里 62% 有值、且形态全部是 6~9 位数字，
   * 反查 `subject_abstract` 抽检 6/6 指向同一部作品 —— 豆瓣富化因此可以
   * 按 id 直取，标题匹配退成兜底。py/js 源没有这个字段，走原路径。
   */
  vod_douban_id?: string;
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
  classes?: CategoryClass[];
}

/** 对外暴露的 7 个 spider 方法（6.2；与 8.4 的 12 个 jar 反射方法不是同一集合） */
export type SpiderMethod =
  | "homeContent"
  | "homeVideoContent"
  | "categoryContent"
  | "detailContent"
  | "searchContent"
  | "playerContent"
  | "liveContent"
  /** TVBox 本地代理方法（`Spider.proxy(Map)`）：Rust/py 适配层都实现了，前端不直接调。 */
  | "proxy";

/** 播放目标（6.2） */
export interface PlayTarget {
  kind: "webview" | "proxy" | "external";
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
  /**
   * 聚合搜索逐站流式回传（仅 siteKey='all' 且 method='searchContent'）：
   * 每有一个站点完成就 emit `search-chunk`（payload = 单行 result JSON），
   * 前端陆续上屏；最终 IPC 返回值仍是完整聚合（真相源）。
   */
  stream?: boolean;
  /**
   * 本次搜索的代次标识。后端原样回带在 `search-chunk` 事件里，前端据此
   * 丢弃上一轮仍在飞的结果——「搜索中改词重搜」时两轮 IPC 会重叠，
   * 没有这个标识，旧词的站点结果会混进新词的结果列表。
   */
  streamId?: string;
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
 * 下列类型对应 Rust 侧 serde 结构与 contracts/luma.schema.json（契约真源）。
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
  /** 只有网络地址导入的配置能定时回拉；file / 粘贴文本恒为 false。 */
  refreshable: boolean;
  /** 上次检查的墙钟毫秒（含无变化与失败），从未检查过则缺省。 */
  lastCheckedAt?: number;
  /** 上次内容真的变化并落库的时刻。 */
  lastChangedAt?: number;
  /** 上次检查失败的原因；成功后清空。 */
  refreshError?: string;
}

/** 订阅自动刷新的全局设置 + active 配置的检查状态（config_refresh_settings）。 */
export interface RefreshSettings {
  /** 小时；0 = 关闭。 */
  intervalHours: number;
  configId?: string;
  lastCheckedAt?: number;
  lastChangedAt?: number;
  error?: string;
  /** 下次到期时刻；关闭或无 active 时缺省。 */
  nextDueAt?: number;
}

/** 一次订阅刷新检查的结果（config_refresh / config-refreshed 事件）。 */
export interface RefreshOutcome {
  configId: string;
  name: string;
  /** false 表示远端内容没变，站点缓存无需替换。 */
  changed: boolean;
  sites: number;
  enabled: number;
  checkedAt: number;
  snapshot?: ConfigSnapshot;
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
  /** 最近观看的集数名，历史页直接展示，详情页按它回查续播。 */
  episodeName?: string;
  /** 最近观看的线路名（`vod_play_from` 的一段），换源后仍能定位。 */
  playFrom?: string;
  /** 播放时解码出的画面分辨率（`1080P` / `2K` / `4K`）；没真出过画就是空。 */
  resolution?: string;
  positionMs?: number;
  durationMs?: number;
  /**
   * 这部剧的倍速（0 或缺省 = 没设过，播放侧按 1.0 起播）。
   *
   * 记在 history 行上而不是全局偏好里：这一行按剧名合并，换源、换线路都跟着走，
   * 倍速因此天然跨源共享；写入时空值**不会覆盖**库里已有值。
   */
  rate?: number;
  /**
   * 这部剧的跳过片头/片尾配置（`SkipSegment[]` 的 JSON 文本）。
   *
   * 空串 = 这次写入没带（不覆盖）；`"[]"` = 用户真的清空过片段。宿主侧只存文本，
   * 结构由 `src/lib/skipSegments.ts` 解释与校验。
   */
  skipJson?: string;
  /** 剧个性配置扩展位（JSON 文本）。 */
  prefsJson?: string;
  /** 收藏标记：收藏只是播放记录上的一个 flag（历史页据此显示收藏 icon）。 */
  favorite?: boolean;
  /** 订阅裸地址快照（弱引用：订阅删了，记录仍可展示）。 */
  subscriptionAddress?: string;
  /** 豆瓣 id（可选）：有就记，不参与剧名合并。 */
  doubanId?: string;
  /** 语义集号（从集名解析）；不是数组下标，倒序线路也正确。 */
  episodeNumber?: number | null;
  updatedAt: number;
}

/** 单个站点的首页结果（8.2） */
/** CMS `ac=list` 的 class[] 会同时给父子两级；py/js 源通常没有 type_pid。 */
export interface CategoryClass {
  type_id: string;
  type_name: string;
  /** 父级分类 id，0 / 缺失表示顶层。运行时可能是数字。 */
  type_pid?: string | number;
}

export interface HomeResult {
  classes: CategoryClass[];
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
  /** 默认线路（lines[0]）。 */
  url: string;
  /** 同频道在源里的全部可播放地址（m3u 同名条目 / `$` 分隔 / 容器 urls 合并），按序即线路序号。 */
  lines: string[];
  logo?: string;
  epg?: string;
  /** 后端原始字段（聚合前拆分的逐条地址），归一化时转为 lines。 */
  urls?: string[];
  /**
   * 频道级请求头：m3u 的 `#EXTINF ... http-user-agent` / `http-referer`。
   * 部分源站（咪咕系央视/卫视）不带它就 404，带了对的 UA 才回播放列表；
   * 没声明时不出现，播放时回落到 `lives[].ua`。
   */
  ua?: string;
  referer?: string;
  /** 频道级 Cookie（m3u 的 `http-cookie` / `http-header="Cookie=…"`）。 */
  cookie?: string;
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

/** 单个节目（XMLTV programme 归一化）。 */
export interface EpgProgram {
  /** ISO 8601 时间（已按 xmltv 时区换算）。 */
  start: string;
  /** ISO 8601 时间；缺省为空串。 */
  stop?: string;
  title: string;
  desc?: string;
}

/** 某频道的节目单（按频道名匹配后的结果）。 */
export interface EpgResult {
  channel: string;
  date?: string;
  programs: EpgProgram[];
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
  /** 所属通道：`app`（宿主）/ `ui`（前端）/ `spider`（适配层）。 */
  channel: string;
  /** 相对日志根目录的路径，例如 `app/luma.2026-11-15.log`。 */
  name: string;
  bytes: number;
}

export interface Diagnostics {
  version: string;
  /** 发布通道：`stable` / `beta` / `dev`（宿主按 identifier 推导）。 */
  channel: string;
  /** 最近提交 short hash（与前端同源，便于比对前后端是否同构建）。 */
  buildHash: string;
  /** 本次运行的启动时刻（epoch 秒字符串）：界面上的 build 号统一显示它。 */
  startedAt: string;
  /** exe 编译完成时刻（epoch 秒）：仅供诊断排障，不作为界面 build 号。 */
  buildTime: string;
  os: string;
  arch: string;
  dataDir: string;
  logDir: string;
  dbPath: string;
  config: DiagnosticsConfig | null;
  logFiles: DiagnosticsLogFile[];
  logBytes: number;
}

/** 站点体检单站结果（内部诊断命令，非归一化契约，故不进 schema PAIRS）。 */
export interface SiteHealthRow {
  siteKey: string;
  siteName: string;
  /** ok=可达；failed=请求出错；timeout=超时；skipped=墙钟预算内未跑完被中止。 */
  status: "ok" | "failed" | "timeout" | "skipped";
  /** 单站耗时 ms；skipped 为 0。 */
  tookMs: number;
  /** 失败/超时原因；ok 时省略。 */
  message?: string;
  /** homeContent 返回的内容条数（list/classes 之和），仅 ok 时有值。 */
  count?: number;
}

/** 站点体检聚合结果。 */
export interface SiteHealthResult {
  configId: string;
  rows: SiteHealthRow[];
  ok: number;
  failed: number;
  skipped: number;
  total: number;
  /** 整次体检墙钟 ms。 */
  tookMs: number;
}

/** GitHub 加速代理候选（内置，顺序即推荐顺序）。 */
export interface GhProxyChoice {
  id: string;
  label: string;
  /** 加速前缀；空串 = 直连。 */
  prefix: string;
  note: string;
}

/** 单次测速结果。`status` 为 0 表示网络层失败（见 error）。 */
export interface GhProbeResult {
  id: string;
  prefix: string;
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
}

/** 设置页「GitHub 加速」状态。 */
export interface GhProxyState {
  /** 当前生效前缀；空串 = 直连。 */
  prefix: string;
  choices: GhProxyChoice[];
  /** 全部配置里不重复的 GitHub 链接条数。 */
  links: number;
  /** 已有配置总数。 */
  configs: number;
  /** 本次切换实际改写的配置数（只读查询时为 0）。 */
  changed: number;
  /** active 运行快照：URL 改写过，前端缓存必须整份替换。 */
  snapshot?: ConfigSnapshot | null;
}

/** 一个本机目录的占用（设置页「存储与清理」）。 */
export interface DirUsage {
  bytes: number;
  files: number;
}

/** 一次手动清理的结果。 */
export interface ClearOutcome {
  freedBytes: number;
  remaining: DirUsage;
  /** 正被占用、既删不掉也清不空的条目数（通常是当天正在写的日志）。 */
  skipped: number;
}

export interface StorageUsage {
  logs: DirUsage;
  reports: DirUsage;
  imageCache: DirUsage;
}

export type StorageTarget = "logs" | "reports" | "imageCache";
