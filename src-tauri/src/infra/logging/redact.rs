use super::*;

/// URL 只保留 scheme + host + path：query 里常有 token / 签名，不能落盘。
pub fn redact_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let head = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    truncate_chars(head, 160)
}

/// 把任意文本里的 http(s) URL 换成脱敏形式；错误信息也走这里。
pub fn sanitize(text: &str) -> String {
    truncate_chars(&redact_urls(text), MAX_CONTEXT)
}

/// 只做 URL 脱敏、不裁长度：给落盘通道当最后一道闸（一整行日志可能是几百行
/// 栈，截断会把排障信息切掉；上下文级别的裁剪在写入方各自负责）。
pub fn redact_urls(text: &str) -> String {
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
    out
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
