/***
 * gbk 编解码薄封装（Luma 自研，替代上游无出处、自带压缩码表的 gbk.js）。
 * 实际编解码委托宿主注入的 __luma_gbk_encode / __luma_gbk_decode，底层走
 * encoding_rs::GBK（MPL-2.0，本 sidecar 已是依赖）。
 *
 * 契约与旧 gbkTool 保持一致：
 *   strTool = gbkTool();
 *   strTool.encode(str) // 字符串 -> GBK 百分号串（ASCII 原样、高位 %XX）
 *   strTool.decode(pct) // GBK 百分号串 -> 字符串
 *
 * @returns {{encode: (function(*): *), decode: (function(*): *)}}
 */
export function gbkTool() {
  return {
    encode: function (str) {
      var s = String(str == null ? "" : str);
      if (typeof globalThis.__luma_gbk_encode === "function") {
        return globalThis.__luma_gbk_encode(s);
      }
      // 宿主函数缺失时的保守兜底：原样返回，避免抛错中断整站。
      return s;
    },
    decode: function (str) {
      var s = String(str == null ? "" : str);
      if (typeof globalThis.__luma_gbk_decode === "function") {
        return globalThis.__luma_gbk_decode(s);
      }
      return s;
    },
  };
}
