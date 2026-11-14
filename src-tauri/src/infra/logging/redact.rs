use super::*;

/// URL 只保留 scheme + host + path：query 里常有 token / 签名，不能落盘。
pub fn redact_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let head = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    truncate_chars(head, 160)
}

/// 把任意文本里的 http(s) URL 换成脱敏形式；错误信息也走这里。
pub fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = find_url(rest) {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let end = tail
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | ')' | ']'))
            .unwrap_or(tail.len());
        out.push_str(&redact_url(&tail[..end]));
        rest = &tail[end..];
    }
    out.push_str(rest);
    truncate_chars(&out, MAX_CONTEXT)
}

fn find_url(text: &str) -> Option<usize> {
    match (text.find("http://"), text.find("https://")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

pub(super) fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max).collect();
    out.push('…');
    out
}
