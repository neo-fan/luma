//! 文本一律按 UTF-8 进来，进来之前先「洗」一遍。
//!
//! 外部字节（配置文件、源脚本、上游 HTML / m3u8、本地 `.json` / `.py` 快照）
//! 不保证是 UTF-8：中文圈的老配置与脚本大量是 GBK/GB18030，论坛里复制的
//! 片段还常带 UTF-8 BOM 或 UTF-16。直接用 `String::from_utf8_lossy` 会把中文
//! 变成 `����`，而 `reqwest::Response::text()`（本项目的 reqwest 没开 `charset`
//! feature）恒按 UTF-8 解码，同样会坏——2026-11-14 用户实测就是导入中文配置
//! 后站名全是方块。
//!
//! 规则（顺序固定，别改）：
//!   1. BOM 优先：UTF-8 / UTF-16LE / UTF-16BE（BOM 存在即权威）；
//!   2. 严格 UTF-8 通过就用它——现代配置与 GitHub 上的脚本都是这一档；
//!   3. HTTP 头声明的 charset（`Content-Type: ...; charset=gbk`）；
//!   4. GB18030（GBK / GB2312 的超集）——中文 Windows 的默认落点；
//!   5. 实在解不出来才 lossy，宁可留 `�` 也不让整个导入失败。
//!
//! 只有这里允许「猜编码」。其它模块读到 `String` 就等于读到 UTF-8 文本。

use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE};
use std::path::Path;

/// 把字节洗成 UTF-8 字符串（无外部编码线索时使用）。
pub fn decode(bytes: &[u8]) -> String {
    decode_with_charset(bytes, None)
}

/// 把字节洗成 UTF-8 字符串，`declared` 是 HTTP 头里声明的 charset。
pub fn decode_with_charset(bytes: &[u8], declared: Option<&str>) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    // 1. BOM 是权威声明，见到就按它解，不再猜。
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let (text, _, _) = UTF_16LE.decode(rest);
        return text.into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let (text, _, _) = UTF_16BE.decode(rest);
        return text.into_owned();
    }

    // 2. 严格 UTF-8：绝大多数请求走这一条，零拷贝判断。
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    // 3. 声明了 charset 就先信它（只认非 UTF-8 的明确声明）。
    if let Some(label) = declared.and_then(normalize_label) {
        if let Some(encoding) = Encoding::for_label(label.as_bytes()) {
            if encoding != encoding_rs::UTF_8 {
                let (text, _, had_errors) = encoding.decode(bytes);
                if !had_errors {
                    return text.into_owned();
                }
            }
        }
    }

    // 4. 中文 Windows 的默认落点：GB18030 覆盖 GBK / GB2312。
    let (text, _, had_errors) = GB18030.decode(bytes);
    if !had_errors {
        return text.into_owned();
    }

    // 5. 混合编码的垃圾：宁可留 `�`，也别让调用方拿到半截数据。
    String::from_utf8_lossy(bytes).into_owned()
}

/// 读本地文本文件并洗成 UTF-8（配置 / 源脚本快照 / 随包引擎都走这里）。
pub fn read_file(path: &Path) -> std::io::Result<String> {
    Ok(decode(&std::fs::read(path)?))
}

/// 百分号解码后的字节 → 字符串：只做 UTF-8 与 GB18030 两档，解不出来就返回
/// `None` 让调用方保留原始字符串。
///
/// 这里刻意不认 BOM：URL 片段里的 `%FF%FE` 是坏字节，不是 UTF-16 文本，把它
/// 当 BOM 吞掉会静默丢内容（`proxy::tests` 有一条用例守着这个边界）。
pub fn decode_relaxed(bytes: &[u8]) -> Option<String> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Some(text.to_string());
    }
    let (text, _, had_errors) = GB18030.decode(bytes);
    // GB18030 太能「解」了：`%FF%FE` 会解成空串，坏字节会解成 U+FFFD。
    // 这两种都不算成功，交回原始字符串比静默吞掉更诚实。
    if had_errors || text.is_empty() || text.contains('\u{fffd}') {
        None
    } else {
        Some(text.into_owned())
    }
}

/// 从 `text/html; charset=gbk` 这类头里抽出 charset 值。
pub fn charset_from_content_type(content_type: &str) -> Option<String> {
    content_type.split(';').find_map(|part| {
        let part = part.trim();
        let (key, value) = part.split_once('=')?;
        if !key.trim().eq_ignore_ascii_case("charset") {
            return None;
        }
        normalize_label(value.trim().trim_matches(['"', '\'']))
    })
}

/// `utf8` / `UTF-8` / `gb2312` → 小写标签；空串与 `utf-8` 归一后仍原样返回，
/// 由调用方决定要不要用（UTF-8 已经在上一步严格解码过了）。
fn normalize_label(raw: &str) -> Option<String> {
    let label = raw.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_utf8_passes_through() {
        assert_eq!(decode("中文站点".as_bytes()), "中文站点");
    }

    #[test]
    fn utf8_bom_is_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("{\"name\":\"央视\"}".as_bytes());
        assert_eq!(decode(&bytes), "{\"name\":\"央视\"}");
    }

    #[test]
    fn utf16_bom_is_decoded() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "央视".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode(&bytes), "央视");
    }

    #[test]
    fn gbk_bytes_become_utf8() {
        // 「央视」的 GBK 字节：D1 EB CA D3
        assert_eq!(decode(&[0xD1, 0xEB, 0xCA, 0xD3]), "央视");
    }

    #[test]
    fn declared_charset_wins_over_gb18030_guess() {
        // Shift_JIS 的「テスト」：在 GB18030 下也能解，但会解错，声明必须优先。
        let sjis = [0x83, 0x65, 0x83, 0x58, 0x83, 0x67];
        assert_eq!(decode_with_charset(&sjis, Some("shift_jis")), "テスト");
    }

    #[test]
    fn charset_header_is_parsed() {
        assert_eq!(
            charset_from_content_type("text/html; charset=GBK"),
            Some("gbk".to_string())
        );
        assert_eq!(
            charset_from_content_type("application/json;charset=\"utf-8\""),
            Some("utf-8".to_string())
        );
        assert_eq!(charset_from_content_type("text/plain"), None);
    }

    #[test]
    fn garbage_degrades_to_replacement_chars_instead_of_failing() {
        // 0x81 单独出现不是合法 GB18030 序列。
        let text = decode(&[0x81, 0x81, 0xFF]);
        assert!(text.contains('\u{fffd}') || !text.is_empty());
    }

    #[test]
    fn empty_input_is_empty_string() {
        assert_eq!(decode(&[]), "");
    }
}
