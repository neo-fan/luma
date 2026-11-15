//! 配置解密链（原 `sidecars/py/decrypt.py`，2026-11-14 迁入 Rust）。
//!
//! 顺序固定，任一段失败就落到下一段，全部失败才报错：
//!   1. 图片马：`<二进制头>**<base64(JSONC)>`（服务端用 image/* 塞配置）
//!   2. 明文 JSON / JSONC（注释、尾逗号）
//!   3. `****` 外壳：base64 后与固定 key 异或
//!   4. `<数字>**` 外壳：base64 后可选 gzip
//!   5. 纯 base64（可选 gzip）
//!
//! 每一段都用 `serde_json` 真解析一次才认账 —— 只看前缀会把「看起来像密文
//! 的坏 JSON」当成功，导入到一半才炸。JSONC 在这里就洗干净（宿主全线用
//! 严格 JSON），所以下游拿到的永远是能 `serde_json::from_str` 的文本。

use crate::error::{code, AppError};
use serde_json::Value;

/// TVBox 社区固定的异或 key（`****` 外壳）；这是外部协议字段，非本项目品牌名。
const XOR_KEY: &[u8] = b"tvbox-stub-key";

/// 解密结果：洗干净的 JSON 文本 + 实际命中的那一段（写日志用）。
#[derive(Debug)]
pub struct Decrypted {
    pub plain: String,
    pub method: &'static str,
}

pub fn decrypt(raw: &str) -> Result<Decrypted, AppError> {
    let text = raw.trim_matches('\u{feff}').trim();
    if text.is_empty() {
        return Err(AppError::new(code::CONFIG_DECRYPT_FAIL, "empty payload"));
    }

    if let Some(plain) = image_seed(text) {
        return Ok(Decrypted { plain, method: "image-seed" });
    }

    if let Some(plain) = validated(text) {
        return Ok(Decrypted { plain, method: "plain" });
    }

    if let Some(body) = text.strip_prefix("****") {
        if let Some(data) = decode_b64(body) {
            if let Ok(plain) = String::from_utf8(xor(&data)) {
                if let Some(cleaned) = validated(&plain) {
                    return Ok(Decrypted { plain: cleaned, method: "xor-base64" });
                }
            }
        }
    }

    if let Some(rest) = digit_prefix(text) {
        if let Some(data) = decode_b64(rest) {
            let inflated = maybe_gunzip(&data).unwrap_or(data);
            if let Ok(plain) = String::from_utf8(inflated) {
                if let Some(cleaned) = validated(&plain) {
                    return Ok(Decrypted { plain: cleaned, method: "digit-gzip" });
                }
            }
        }
    }

    if let Some(data) = decode_b64(text) {
        if let Some(inflated) = maybe_gunzip(&data) {
            if let Ok(plain) = String::from_utf8(inflated) {
                if let Some(cleaned) = validated(&plain) {
                    return Ok(Decrypted { plain: cleaned, method: "gzip+base64" });
                }
            }
        }
        if let Ok(plain) = String::from_utf8(data) {
            if let Some(cleaned) = validated(&plain) {
                return Ok(Decrypted { plain: cleaned, method: "base64" });
            }
        }
    }

    Err(AppError::new(
        code::CONFIG_DECRYPT_FAIL,
        "all decrypt stages failed",
    ))
}

/// 交给 `serde_json` 判一次：能解析成对象才算这一步成立，返回要落库的文本。
///
/// 先试原文再试洗过注释的版本：干净 JSON 只扫一遍，JSONC 才付第二次扫描。
fn validated(text: &str) -> Option<String> {
    if parses_as_object(text) {
        return Some(text.to_string());
    }
    let stripped = strip_jsonc(text);
    if stripped != text && parses_as_object(&stripped) {
        return Some(stripped);
    }
    None
}

fn parses_as_object(text: &str) -> bool {
    matches!(
        serde_json::from_str::<Value>(text),
        Ok(Value::Object(_))
    )
}

/// 去掉 `//`、`/* */` 注释与 `}`/`]` 前的尾逗号，字符串内部一个字符都不动。
pub fn strip_jsonc(text: &str) -> String {
    // 按字符走，不按字节：`out.push(byte as char)` 会把「央视」的每个 UTF-8
    // 字节各变成一个字符，配置里的中文站名全变 `����`（2026-11-14 实测）。
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(current) = chars.next() {
        if in_string {
            out.push(current);
            match current {
                // 转义：连下一个字符一起原样搬走，别让 `\"` 提前结束字符串。
                '\\' => {
                    if let Some(escaped) = chars.next() {
                        out.push(escaped);
                    }
                }
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        if current == '"' {
            in_string = true;
            out.push('"');
            continue;
        }
        if current == '/' {
            match chars.peek() {
                Some('/') => {
                    chars.next();
                    // 行注释吃到行尾，换行本身保留（不影响 JSON 结构）。
                    for inner in chars.by_ref() {
                        if inner == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    let mut previous_star = false;
                    for inner in chars.by_ref() {
                        if previous_star && inner == '/' {
                            break;
                        }
                        previous_star = inner == '*';
                    }
                    continue;
                }
                _ => {}
            }
        }
        out.push(current);
    }
    drop_trailing_commas(&out)
}
/// 去掉 `,` 与 `}` / `]` 之间的空白（含注释删掉后新出现的空档）。
///
/// 同样按字符走：这里的输出会直接变成 `imported_json`，任何一个中文字符被
/// 拆成字节替换符都等于把用户配置写坏。
fn drop_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut index = 0usize;
    while index < chars.len() {
        let current = chars[index];
        if in_string {
            out.push(current);
            if current == '\\' && index + 1 < chars.len() {
                out.push(chars[index + 1]);
                index += 2;
                continue;
            }
            if current == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if current == '"' {
            in_string = true;
            out.push('"');
            index += 1;
            continue;
        }
        if current == ',' {
            let mut look = index + 1;
            while look < chars.len() && chars[look].is_whitespace() {
                look += 1;
            }
            if look < chars.len() && (chars[look] == '}' || chars[look] == ']') {
                index += 1; // 丢弃逗号，空白由后续循环照抄
                continue;
            }
        }
        out.push(current);
        index += 1;
    }
    out
}
/// `<二进制头>**<base64>` 的图片马：前置字节必须是不可打印数据，才认。
fn image_seed(text: &str) -> Option<String> {
    let marker = text.find("**")?;
    if marker == 0 || marker > 8192 {
        return None;
    }
    let prefix = &text[..marker];
    let looks_textual = prefix.is_ascii() && !prefix.chars().any(char::is_control);
    if looks_textual {
        return None;
    }
    let cleaned: String = text[marker + 2..]
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
        .collect();
    if cleaned.len() < 8 {
        return None;
    }
    let data = decode_b64(&cleaned)?;
    for candidate in [Some(data.clone()), maybe_gunzip(&data)] {
        let Some(candidate) = candidate else { continue };
        if candidate.is_empty() {
            continue;
        }
        // 图片里夹带的文本多半是 GBK（作者在中文 Windows 上生成的），
        // 硬按 UTF-8 解会把站名变成方块；统一走 textio 的洗编码逻辑。
        let plain = crate::textio::decode(&candidate);
        let stripped = strip_jsonc(&plain);
        if parses_as_object(&stripped) {
            return Some(stripped);
        }
    }
    None
}

/// base64 解码：先剔掉空白与非字母表字符（`validate=False` 语义），再补 `=`。
fn decode_b64(text: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let cleaned: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let mut padded = cleaned;
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(padded.as_bytes())
        .ok()
}

fn maybe_gunzip(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read as _;
    if data.len() < 2 || data[0] != 0x1f || data[1] != 0x8b {
        return None;
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data).read_to_end(&mut out).ok()?;
    Some(out)
}

fn xor(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(index, byte)| byte ^ XOR_KEY[index % XOR_KEY.len()])
        .collect()
}

/// `<数字>**` 前缀（TVBox 的「带版本号的 gzip」外壳），返回 `**` 之后的部分。
fn digit_prefix(text: &str) -> Option<&str> {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || !text[digits..].starts_with("**") {
        return None;
    }
    Some(&text[digits + 2..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn b64(data: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(data)
    }

    const CONFIG: &str = r#"{"sites":[{"key":"a","name":"央视"}]}"#;

    #[test]
    fn plain_json_passes_through() {
        let out = decrypt(CONFIG).expect("plain");
        assert_eq!(out.method, "plain");
        assert_eq!(out.plain, CONFIG);
    }

    #[test]
    fn jsonc_is_cleaned() {
        let raw = "{\n  // 站点\n  \"sites\": [1, 2,], /* 尾逗号 */\n}";
        let out = decrypt(raw).expect("jsonc");
        assert_eq!(out.method, "plain");
        assert_eq!(
            serde_json::from_str::<Value>(&out.plain).expect("strict json"),
            jsonish()
        );
        assert!(!out.plain.contains("//"));
    }

    fn jsonish() -> Value {
        serde_json::json!({"sites": [1, 2]})
    }

    #[test]
    fn string_inner_comment_markers_are_kept() {
        let raw = r#"{"url":"https://x/y?q=1//2","name":"a/*b*/"}"#;
        let out = decrypt(raw).expect("plain");
        assert!(out.plain.contains("https://x/y?q=1//2"));
        assert!(out.plain.contains("a/*b*/"));
    }

    #[test]
    fn xor_shell_is_decoded() {
        let encrypted = xor(CONFIG.as_bytes());
        let raw = format!("****{}", b64(&encrypted));
        let out = decrypt(&raw).expect("xor");
        assert_eq!(out.method, "xor-base64");
        assert_eq!(out.plain, CONFIG);
    }

    #[test]
    fn digit_prefixed_shell_is_decoded() {
        let raw = format!("12**{}", b64(CONFIG.as_bytes()));
        let out = decrypt(&raw).expect("digit");
        assert_eq!(out.method, "digit-gzip");
        assert_eq!(out.plain, CONFIG);
    }

    #[test]
    fn gzip_base64_shell_is_decoded() {
        use std::io::Write as _;
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(CONFIG.as_bytes()).expect("gzip");
        let raw = b64(&encoder.finish().expect("gz bytes"));
        let out = decrypt(&raw).expect("gzip");
        assert_eq!(out.method, "gzip+base64");
        assert_eq!(out.plain, CONFIG);
    }

    #[test]
    fn base64_shell_is_decoded() {
        let out = decrypt(&b64(CONFIG.as_bytes())).expect("base64");
        assert_eq!(out.method, "base64");
        assert_eq!(out.plain, CONFIG);
    }

    #[test]
    fn image_seed_is_decoded() {
        // 图片头用几段非 ASCII 字节模拟（真实是 JPEG/PNG 二进制）。
        let mut raw = String::new();
        raw.push_str("\u{8}\u{fffd}\u{fffd}");
        raw.push_str("**");
        raw.push_str(&b64(CONFIG.as_bytes()));
        let out = decrypt(&raw).expect("image seed");
        assert_eq!(out.method, "image-seed");
        assert_eq!(out.plain, CONFIG);
    }

    #[test]
    fn empty_payload_fails_with_decrypt_code() {
        let err = decrypt("   ").unwrap_err();
        assert_eq!(err.code.as_str(), code::CONFIG_DECRYPT_FAIL);
    }

    #[test]
    fn garbage_fails_on_every_stage() {
        let err = decrypt("这不是配置").unwrap_err();
        assert_eq!(err.code.as_str(), code::CONFIG_DECRYPT_FAIL);
        assert!(err.message.contains("all decrypt stages failed"));
    }

    #[test]
    fn json_array_is_not_a_config() {
        // 只有对象算配置：数组多半是别的东西（或坏掉的外壳）。
        assert!(decrypt("[1,2,3]").is_err());
    }
}
