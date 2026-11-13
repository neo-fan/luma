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
