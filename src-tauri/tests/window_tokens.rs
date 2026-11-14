//! 标题栏配色必须与设计 token 一致。
//!
//! 背景：Windows 原生标题栏的颜色由 Rust 侧 DWM 调用写死（CSS 管不到），
//! 而设计 token 改过好几轮（`#0b0d12` → `#0a0a0b`）。两边一旦漂移，窗口顶部
//! 就会多出一条色差，用户第一眼就能看见「标题栏和主题不一样」。
//! 这里直接读 `src/styles.css` 校验，改 token 忘了改常量就会红。

use luma_lib::window::{CAPTION_BORDER_RGB, CAPTION_RGB, CAPTION_TEXT_RGB};

/// 从 `styles.css` 的 `:root` 段里取某个 token 的十六进制值。
fn token(css: &str, name: &str) -> (u8, u8, u8) {
    let key = format!("--{name}:");
    let start = css
        .find(&key)
        .unwrap_or_else(|| panic!("styles.css 缺少 token {key}"));
    let rest = &css[start + key.len()..];
    let hash = rest.find('#').expect("token 值应为 #rrggbb");
    let hex = &rest[hash + 1..hash + 7];
    let parse = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&hex[range], 16).expect("token 值应为十六进制")
    };
    (parse(0..2), parse(2..4), parse(4..6))
}

#[test]
fn caption_matches_design_tokens() {
    let css = include_str!("../../src/styles.css");
    assert_eq!(CAPTION_RGB, token(css, "bg"), "标题栏底色需等于 --bg");
    assert_eq!(CAPTION_TEXT_RGB, token(css, "text"), "标题栏文字需等于 --text");
    assert_eq!(
        CAPTION_BORDER_RGB,
        token(css, "border"),
        "窗口边框需等于 --border"
    );
}
