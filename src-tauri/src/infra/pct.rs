//! Percent-encoding 的统一实现（RFC 3986 unreserved 之外全编码）。
//!
//! 此前这个「encodeURIComponent 保守版」在仓库里有三份逐字相同的实现
//! （反代 `urlencode`、CMS 查询串 `encode`、豆瓣 `percent_encode`），外加
//! 一份解码。同一套规则抄三遍的代价不是行数，是改字段/改转义口径时要同时
//! 记得改三处（2026-11-16 评审 P2）。解码侧保留「非法 UTF-8 回落原文」的
//! 宽容语义——头值不是表单数据，宁可带着 `%ZZ` 原样发出去，也不能因为
//! 一个坏转义把整个请求头丢掉。

/// unreserved：`A-Z a-z 0-9 - _ . ~`，其余按 UTF-8 字节逐个转义。
pub(crate) fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 3);
    for byte in raw.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
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
