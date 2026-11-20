/**
 * hls.js 的 `ErrorDetails` → 用户看得懂的中文。
 *
 * 直接抛 `manifestParsingError` 这类内部枚举名，用户只会把它当成 Luma 的 bug；
 * 实际上这一档几乎都是「源已经失效」：网盘解析接口以 200 返回
 * `{"code":201,"msg":"解析失败了"}`，或者 CDN 用 HTML 错误页顶替 m3u8，
 * hls.js 统一报 manifestParsingError。文案要指向「换源」，而不是「播放器坏了」。
 *
 * 未知枚举仍回退原始 details：排查真实配置时，原始英文名比「未知错误」有用。
 */
const HLS_ERROR_TEXT: Record<string, string> = {
  manifestParsingError: "播放列表解析失败（源返回的不是 m3u8，可能已失效）",
  manifestLoadError: "播放列表加载失败（源不可达或已失效）",
  manifestIncompatibleCodecsError: "播放列表的编码当前无法解码",
  levelParsingError: "子播放列表解析失败（源返回内容异常）",
  levelLoadError: "子播放列表加载失败（源不可达）",
  levelEmptyError: "源返回了空白播放列表",
  audioTrackLoadError: "音轨列表加载失败",
  audioTrackParsingError: "音轨列表解析失败",
  subtitleTrackLoadError: "字幕加载失败",
  subtitleTrackParsingError: "字幕解析失败",
  fragLoadError: "视频分片加载失败（源不稳定）",
  fragParsingError: "视频分片解析失败（资源可能已损坏）",
  fragGapTimeoutError: "视频流中断时间过长",
  keyLoadError: "解密密钥加载失败（防盗链拒绝）",
  bufferAppendError: "解码缓冲写入失败",
  bufferAddCodecError: "当前浏览器不支持该视频编码",
  bufferStalledError: "缓冲卡住，长时间没有新数据",
  bufferSeekOverHole: "跳转位置之后缺少分片",
  networkError: "网络错误（源不可达）",
  otherError: "未知错误",
};

export function describeHlsError(details: string | undefined): string {
  if (!details) {
    return "未知错误";
  }
  return HLS_ERROR_TEXT[details] ?? details;
}

/**
 * 时间型失败：hls.js 只是「等太久」，不构成「这条线路坏了」的证据。
 *
 * fatal 不等于确定：`manifestLoadTimeOut` / `fragLoadTimeOut` / `networkError`
 * 这些在慢源冷启（首个分片 9MB+、上游接口 18s 才回）时必然出现，hls 自己会
 * 重试。旧实现见到 fatal 就跳走，用户看到的就是「明明能播却被换线」。
 *
 * 这些一律交给播放页的停滞看门狗去**独立复核**：只有复核拿到明确失败
 * （HTTP 4xx/5xx、内容不是 m3u8、分片是占位图）才换源。
 */
const TIMING_FAILURES = new Set([
  "manifestLoadError",
  "manifestLoadTimeOut",
  "levelLoadError",
  "levelLoadTimeOut",
  "fragLoadError",
  "fragLoadTimeOut",
  "keyLoadError",
  "bufferStalledError",
  "fragGapTimeoutError",
  "networkError",
]);

export function isTimingFailure(details: string | undefined): boolean {
  return Boolean(details && TIMING_FAILURES.has(details));
}

/* ------------------------------------------------------------------------- *
 * 直播失败归类
 * ------------------------------------------------------------------------- */

/**
 * 直播失败的归类。与点播/搜索的 `FailureKind`（`lib/failureReason.ts`）分开：
 * 直播没有「站点」这一层，用户能采取的动作只有「刷新 / 换线路 / 换频道」，
 * 所以分类维度是**失败发生在哪一步**，而不是「哪个站点出了什么事」。
 */
export type LiveFailureReason =
  | "timeout" // 源站超时 / 无响应
  | "plugin" // 需要源侧插件解析（网盘 token、私有 scheme）
  | "sniff" // 页面型地址，嗅探不到播放源
  | "lines" // 该频道所有线路都试过且失败
  | "network" // 网络不可达
  | "decode" // 解码失败 / 内核不支持该编码
  | "unknown"; // 兜底

/** 失败发生时所在的阶段。阶段比原始 message 更可靠，优先参与判定。 */
export type LiveFailureStage =
  | "resolve" // 问源拿真实播放地址（playerContent / 解析池 / resolve_play）
  | "sniff" // 页面型地址的第 4 级嗅探
  | "play" // 播放内核（hls.js / mpegts.js）报错
  | "single-line" // 单线路等待 4s 仍没出画：本轮没有可自动切换的目标
  | "probe-limit" // 本轮自动换线次数用完：停止换线，下一步动作在用户手上
  | "exhausted"; // 该频道所有线路都试过

export interface LiveFailureInput {
  /** Rust `AppError.code`；`resolveError` 只带 message 时为空。 */
  code?: string;
  /** 原始报错全文（可能含 URL / 枚举名，只参与归类，不进主文案）。 */
  message?: string;
  /** 失败阶段；缺省按 message 关键词判断。 */
  stage?: LiveFailureStage;
}

export interface LiveFailureInfo {
  reason: LiveFailureReason;
  /** 主文案：一句人话讲清哪一步失败 / 结论。 */
  message: string;
  /** 归因 + 下一步动作；不重复主文案，也不塞原始报错。 */
  hint: string;
}

const LIVE_FAILURE_TEXT: Record<
  LiveFailureReason,
  { message: string; hint: string }
> = {
  timeout: {
    message: "源站响应超时，暂时没拿到播放地址。",
    hint: "源侧冷启动或网络较慢；已保留当前线路，点刷新可重试，先别急着换台。",
  },
  plugin: {
    message:
      "这条线路需要源侧插件解析（网盘 token），内置播放器无法直接播放。",
    hint: "地址是网盘 / 私有插件 token，只有源自己的解析接口能换成直链；请换一条线路或换一个直播源。",
  },
  sniff: {
    message: "该地址是页面而不是播放流，没能嗅探到可用的播放源。",
    hint: "页面型地址要靠源站跳到真实视频流；请换一条线路，或换一个支持该站的直播源。",
  },
  lines: {
    message: "该频道的所有线路都无法播放。",
    hint: "已经自动试过这个频道的全部线路；请在左侧换一个频道，或换一个直播源。",
  },
  network: {
    message: "网络不可达，连不上源站。",
    hint: "检查网络或代理是否正常；恢复后点刷新重试。",
  },
  decode: {
    message: "播放内核解码失败，当前环境放不了这个流。",
    hint: "可能是编码 / 封装不被内置播放器支持（如 H.265）；换一条线路或换源再试。",
  },
  unknown: {
    message: "播放失败，原因未能确定。",
    hint: "可以点刷新重试，或换一条线路 / 换一个直播源。",
  },
};

/** 单线路判死的结论：没有可自动切换的目标，动作是换频道而不是换线路。 */
const SINGLE_LINE_FAILURE: LiveFailureInfo = {
  reason: "unknown",
  message: "这条线路没能出画，可以换一个频道。",
  hint: "该频道只有一条线路，没有可自动切换的目标；请换一个频道，或换一个直播源。",
};

/**
 * 本轮自动换线的尝试预算用完（线路很多、并非全部试过）。
 *
 * 口径必须精确：自动恢复**只会换线路，从不自动换台/换源**——所以文案说清
 * 「还有线路没试」但已停止，下一步（换台或点刷新重试）由用户决定；
 * 绝不能写成「所有线路都试过」那种假结论。
 */
const PROBE_LIMIT_FAILURE: LiveFailureInfo = {
  reason: "lines",
  message: "这个频道连着几条线路都没能出画，已停止自动换线。",
  hint: "自动恢复只会换线路，不会替你换台；请在左侧换一个频道，或点刷新再试一轮。",
};

/** 错误码 → 归类。只收「明确指向某类失败」的码；泛化码交给 message 关键词。 */
const LIVE_CODE_REASON: Record<string, LiveFailureReason> = {
  SITE_TIMEOUT: "timeout",
  RUNTIME_UNAVAILABLE: "plugin",
  PLAY_RESOLVE_FAIL: "unknown",
};

/**
 * message 特征 → 归类，按顺序匹配、第一个命中即返回。
 *
 * 顺序按「越具体越靠前」：所有线路失效 / 嗅探是结论性文案；网盘 token 与
 * 解码是动作性文案；超时和网络兜住剩下的传输类失败。
 */
const LIVE_MESSAGE_PATTERNS: Array<[RegExp, LiveFailureReason]> = [
  [/所有线路|全部线路|线路都(?:无法|不能)/u, "lines"],
  [
    /嗅探|sniff|页面型|页面地址|网页地址|found no media|不是播放流/iu,
    "sniff",
  ],
  [/网盘|token|源侧插件|插件解析|解析器|parsers?\b|scheme|解析接口/iu, "plugin"],
  [
    /解码|codec|不支持该视频编码|不支持\s*(?:HLS|FLV)|MEDIA_ERR|SRC_NOT_SUPPORTED|解码组件/iu,
    "decode",
  ],
  [/超时|timed?\s*out|timeout|deadline exceeded|无响应/iu, "timeout"],
  [
    /网络|network|dns|unreachable|refused|econn|不可达|断网|offline|连接失败/iu,
    "network",
  ],
];

function fromReason(reason: LiveFailureReason): LiveFailureInfo {
  return { reason, ...LIVE_FAILURE_TEXT[reason] };
}

/**
 * 归类一次直播失败。
 *
 * 判定顺序：阶段（最可靠）→ 明确错误码 → message 特征 → 单线路结论 → 兜底。
 * 纯函数，不读运行时状态，可以直接在渲染里调用，也方便单测。
 */
export function classifyLiveFailure(
  input: LiveFailureInput = {},
): LiveFailureInfo {
  const { code, message, stage } = input;

  // 「所有线路都试过」「页面型地址嗅探失败」是调用方已经确证的结论，直接采信。
  if (stage === "exhausted") {
    return fromReason("lines");
  }
  if (stage === "probe-limit") {
    return PROBE_LIMIT_FAILURE;
  }
  if (stage === "sniff") {
    return fromReason("sniff");
  }

  const trimmedCode = (code ?? "").trim();
  const codeReason = trimmedCode ? LIVE_CODE_REASON[trimmedCode] : undefined;
  if (codeReason && codeReason !== "unknown") {
    return fromReason(codeReason);
  }

  const raw = (message ?? "").trim();
  for (const [pattern, reason] of LIVE_MESSAGE_PATTERNS) {
    if (pattern.test(raw)) {
      return fromReason(reason);
    }
  }

  // 单线路判死时没有可换的目标：只有在 message 看不出原因时才用结论文案。
  if (stage === "single-line") {
    return SINGLE_LINE_FAILURE;
  }

  if (codeReason) {
    return fromReason(codeReason);
  }
  return fromReason("unknown");
}

/** 只要主文案时的便捷入口；需要 reason / hint 用 `classifyLiveFailure`。 */
export function liveFailureMessage(input: LiveFailureInput = {}): string {
  return classifyLiveFailure(input).message;
}
