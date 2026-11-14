use super::*;

/// Upper bound for a user-visible config name. Long enough for a host plus a
/// label, short enough that the settings list never wraps into three lines.
pub(crate) const MAX_NAME_CHARS: usize = 48;

/// Trim + length-limit a user-supplied name, dropping control characters so a
/// pasted newline cannot break the settings list layout.
pub(crate) fn clean_name(value: &str) -> String {
    let mut out: String = value.trim().chars().take(MAX_NAME_CHARS).collect();
    out.retain(|ch| !ch.is_control());
    out.trim().to_string()
}

/// Host of a URL without the `www.` prefix: the default config name.
///
/// Users usually keep several configs from different providers, and the
/// domain is what tells them apart — the TVBox `name` field is often just
/// "box" or missing entirely.
///
/// Parsed by hand on purpose: `url::Url` IDNA-encodes the host, so an
/// internationalized domain would be labelled `xn--…`. The raw authority keeps
/// whatever the user actually typed.
pub(crate) fn host_of(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let rest = trimmed
        .split_once("://")
        .map(|(_, tail)| tail)
        .unwrap_or(trimmed);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Drop `user:pass@` and the port; keep an IPv6 literal in brackets.
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, tail)| tail);
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        inner.split(']').next().map(|hex| format!("[{hex}]"))?
    } else {
        host_port.split(':').next().unwrap_or("").to_string()
    };
    let host = host.trim_start_matches("www.").trim_end_matches('.');
    if host.is_empty()
        || !host
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '.' | '_' | '[' | ']'))
    {
        // Spaces / punctuation mean the user is still typing a URL: let the
        // normalizer's own name win instead of showing garbage.
        return None;
    }
    Some(host.to_string())
}

/// Default name for a freshly imported config.
///
/// URL imports use the domain; file/text imports keep whatever the normalizer
/// derived (config `name`, file stem, or "本地配置"), because there is no host
/// to show.
pub(crate) fn default_name(source: &ConfigSource, fallback: &str) -> String {
    if source.kind == "url" {
        if let Some(host) = host_of(&source.value) {
            return clean_name(&host);
        }
    }
    clean_name(fallback)
}
