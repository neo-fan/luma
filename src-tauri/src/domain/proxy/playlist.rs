use super::*;

/// Headers/params that must travel with every rewritten playlist URI.
#[derive(Clone, Default)]
pub(super) struct Fwd {
    pub(super) ua: Option<String>,
    pub(super) referer: Option<String>,
    pub(super) cookie: Option<String>,
    pub(super) extra: Option<String>,
}

impl Fwd {
    pub(super) fn suffix(&self) -> String {
        let mut out = String::new();
        for (key, value) in [
            ("ua", self.ua.as_deref()),
            ("referer", self.referer.as_deref()),
            ("cookie", self.cookie.as_deref()),
            ("h", self.extra.as_deref()),
        ] {
            if let Some(value) = value.filter(|text| !text.is_empty()) {
                out.push_str(&format!("&{key}={}", urlencode(value)));
            }
        }
        out
    }
}

pub(super) fn wrap_url(port: u16, target: &str, fwd: &Fwd) -> String {
    format!(
        "http://127.0.0.1:{port}/proxy?url={}{}",
        urlencode(target),
        fwd.suffix()
    )
}

/// Resolve a playlist URI against the manifest URL. Absolute http(s) URLs are
/// already final and must pass through unchanged (they often carry signed query
/// parameters); everything else is joined with the manifest's base.
pub(super) fn absolutize(base: &Url, uri: &str) -> String {
    let trimmed = uri.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    base.join(trimmed)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| trimmed.to_string())
}

/// Does this body actually look like an HLS playlist?
///
/// The `is_playlist` gate only looks at the URL and `content-type`, and a dead
/// source keeps answering `200` — netdisk resolvers return JSON, CDNs return an
/// HTML error page. Only a body whose first meaningful line is `#EXTM3U` can be
/// handed to hls.js; tolerating a BOM / leading blank lines because some
/// encoders prepend them.
pub(super) fn looks_like_playlist(text: &str) -> bool {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .is_some_and(|line| line.starts_with("#EXTM3U"))
}

/// First `limit` bytes on one line, for log lines and error bodies.
pub(super) fn preview_text(text: &str, limit: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(limit)
        .collect();
    flat.trim().to_string()
}

/// Wrap every media line of an HLS playlist into the local proxy. Without this
/// the webview would request segments (and `#EXT-X-KEY` URIs) directly from the
/// CDN, losing the anti-leech headers and hitting CORS.
pub(super) fn rewrite_playlist(text: &str, base: &Url, port: u16, fwd: &Fwd) -> String {
    let mut out = String::with_capacity(text.len() + 256);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        if trimmed.starts_with('#') {
            if trimmed.contains("URI=\"") {
                out.push_str(&rewrite_tag_uris(trimmed, base, port, fwd));
            } else {
                out.push_str(trimmed);
            }
            out.push('\n');
            continue;
        }
        out.push_str(&wrap_url(port, &absolutize(base, trimmed), fwd));
        out.push('\n');
    }
    out
}

/// Rewrite every `URI="..."` in an HLS tag (e.g. `#EXT-X-KEY`) to point at the
/// local proxy. One tag can carry more than one URI, so the scan resumes at the
/// closing quote instead of returning after the first hit.
pub(super) fn rewrite_tag_uris(line: &str, base: &Url, port: u16, fwd: &Fwd) -> String {
    let mut out = String::with_capacity(line.len() + 64);
    let mut rest = line;
    while let Some(position) = rest.find("URI=\"") {
        // +5 skips the literal `URI="`; `tail` now starts at the value.
        let (head, tail) = rest.split_at(position + 5);
        out.push_str(head);
        if let Some(end) = tail.find('"') {
            let uri = &tail[..end];
            out.push_str(&wrap_url(port, &absolutize(base, uri), fwd));
            rest = &tail[end..];
        } else {
            // Unterminated quote: keep the original tail verbatim rather than
            // emitting a broken playlist.
            rest = tail;
            break;
        }
    }
    out.push_str(rest);
    out
}
