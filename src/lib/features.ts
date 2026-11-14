/**
 * 临时功能开关（2026-11-13）：整体屏蔽「外部播放」。
 *
 * 关闭时同时收掉三条路径，避免出现「入口没了但还会自动弹外部程序」或
 * 「错误提示让用户去点一个不存在的按钮」这种自相矛盾的界面：
 *  1. 播放器信息卡的「外部播放」图标按钮不渲染；
 *  2. `playExternal()` 早退，不会调到 `open_external`；
 *  3. 所有失败引导文案改用 `PLAY_FAILURE_HINT`。
 *
 * 后端 command（`open_external`）与图标资源一律保留，恢复时只要把这个常量
 * 改回 `true`，调用点和文案会一起回来，不用逐个文件找。
 *
 * 注：随包 mpv 兜底已按产品决策移除（2026-11-14），解码失败一律走换线路 /
 * 换源，不再拉起任何外部进程。
 */
export const EXTERNAL_PLAY_ENABLED = false;

/** 播放失败时的引导语：开关关闭后不能再把用户指向外部播放。 */
export const PLAY_FAILURE_HINT = EXTERNAL_PLAY_ENABLED
  ? "可尝试外部播放"
  : "可尝试换源或稍后重试";

/** 非内置可播地址的兜底提示（播放器舞台遮罩）。 */
export const EXTERNAL_PLAY_FALLBACK = EXTERNAL_PLAY_ENABLED
  ? {
      title: "该地址需要在外部播放器中打开",
      desc: "内置播放器只支持 HLS / FLV / 直链媒体，其余格式请交给系统播放器。",
    }
  : {
      title: "该地址无法在内置播放器中播放",
      desc: "请换一条线路或换源重试；内置播放器支持 HLS / FLV / 直链媒体。",
    };
