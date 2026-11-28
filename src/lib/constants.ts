/**
 * 跨模块共享的业务常量（前端唯一真源）。
 *
 * 收录标准：**同一语义被两个以上模块用到**。模块内专用的常量（如播放列表 TTL、
 * 存储键、片头片尾预设）仍留在各自模块，避免把内聚性拆散塞进一个大杂烩。
 *
 * 特别注意「同值不同义」：两个地方都是 5000ms 不代表该共用同一个常量——
 * 历史写入节流和线路探活超时是两件事，改一个不该连带改另一个。下面的命名
 * 一律带业务限定词。
 */

// ---- 播放时序（跨 hook / 状态机 / 页面） ----

/** 续播最小位置：不足 3 秒视为「刚开始」，不值得跳，从头播。 */
export const RESUME_MIN_POSITION_MS = 3_000;
/** 播放进度写入历史的节流间隔。 */
export const HISTORY_WRITE_THROTTLE_MS = 5_000;
/** 原地换源（等首帧）的封顶超时，与 vodSessionMachine 的 after 对齐。 */
export const SWITCH_SOURCE_CAP_MS = 15_000;
/**
 * 原地换集时「新地址挂上」的封顶超时（ArtPlayer `switchUrl` 的 resolve）。
 *
 * 它内部等新地址的 `loadedmetadata`：死链上永不 resolve，整条切换协程会挂住、
 * 串行队列的 running 永不释放，之后的换集 / 换线只进 pending 不执行。比出画
 * 封顶短——这一段只确认「地址已挂上」，真正等画面的是 `SWITCH_SOURCE_CAP_MS`。
 */
export const SWITCH_URL_ATTACH_CAP_MS = 8_000;
/** 播放器 / 搜索页的短周期 UI 轮询间隔。 */
export const SHORT_UI_TICK_MS = 500;

// ---- 网络 / 探活 ----

/** 线路探活的单站缺省超时（playProbe 默认参数）。 */
export const PROBE_DEFAULT_TIMEOUT_MS = 5_000;

// ---- 容量 / 截断 ----

/** 日志批量发送队列上限，超出丢最旧。 */
export const LOG_MAX_QUEUE = 200;
/** 日志单条 context 文本截断长度。 */
export const LOG_CONTEXT_CLIP_LEN = 1_200;
/** 单条日志消息截断长度。 */
export const LOG_MESSAGE_CLIP_LEN = 2_000;
