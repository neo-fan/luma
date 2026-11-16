//! Percent-encoding 的统一入口（RFC 3986 unreserved 之外全编码）。
//!
//! 此前这个「encodeURIComponent 保守版」在仓库里有三份逐字相同的实现
//! （反代 `urlencode`、CMS 查询串 `encode`、豆瓣 `percent_encode`），外加
//! 一份解码。同一套规则抄三遍的代价不是行数，是改字段/改转义口径时要同时
//! 记得改三处（2026-11-16 评审 P2）。
//!
//! 编码交给 `percent-encoding`，但**用修正过的 unreserved 集**：库的
//! `NON_ALPHANUMERIC` 连 `- _ . ~` 也编掉（实测 `a-b` → `a%2Db`），与这里的
//! 口径不同，所以 `remove` 回那四个字节。替换前它编出的串与手搓实现不一致，
//! 被 `pct::tests::encode_keeps_unreserved_only` 直接打回（2026-11-17）。
//!
//! **解码刻意不用库**：这里要的是「坏转义或非法 UTF-8 就整串原样退回」——
//! 头值不是表单数据，宁可带着 `%ZZ` 发出去，也不能因为一个坏转义丢掉整个
//! 请求头。库给的 `decode_utf8_lossy` 是另一种语义（插 U+FFFD，原文已经
//! 回不来），`decode` 系列也只处理合法序列，套上去反而要为这条宽容语义
//! 写更多适配代码，所以保留这段显式实现。

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

/// RFC 3986 的 unreserved 集。库给的 `NON_ALPHANUMERIC` 连 `- _ . ~` 一起编掉
/// （实测 `a-b` → `a%2Db`），这里显式放回来，口径与替换前的手搓实现逐字一致，
/// 由 `pct::tests::encode_keeps_unreserved_only` 钉住。
const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// unreserved：`A-Z a-z 0-9 - _ . ~`，其余按 UTF-8 字节逐个转义。
pub(crate) fn percent_encode(raw: &str) -> String {
    utf8_percent_encode(raw, UNRESERVED).to_string()
}

/// `%XX` → 字节；`+` 保持字面量（头值不是表单数据）。连续 `%XX` 解出来的
/// 字节流按 `textio::decode_relaxed` 解释，非法 UTF-8 时回落原文。
pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    crate::textio::decode_relaxed(&out).unwrap_or_else(|| input.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_keeps_unreserved_only() {
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(
            percent_encode("http://a b/?x=1&y=2"),
            "http%3A%2F%2Fa%20b%2F%3Fx%3D1%26y%3D2"
        );
        // 中文按 UTF-8 字节转义（配置与查询串里最常见）。
        assert_eq!(percent_encode("庆"), "%E5%BA%86");
    }

    #[test]
    fn decode_round_trips_non_ascii() {
        assert_eq!(percent_decode("%E5%BA%86%E4%BD%99%E5%B9%B4"), "庆余年");
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[test]
    fn decode_keeps_invalid_sequences_and_invalid_utf8_raw() {
        // 坏转义/非法 UTF-8：原样保留，不报错也不丢整个值。
        assert_eq!(percent_decode("%FF%FE"), "%FF%FE");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%2"), "%2");
    }

    #[test]
    fn plus_stays_literal() {
        // 头值里 `+` 是数据不是空格的表单编码（form urlencoded 才那样解）。
        assert_eq!(percent_decode("a+b"), "a+b");
        assert_eq!(percent_encode("a+b"), "a%2Bb");
    }
}
