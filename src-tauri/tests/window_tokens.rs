//! 标题栏配色必须与设计 token 一致。
//!
//! 背景：Windows 原生标题栏的颜色由 Rust 侧 DWM 调用写死（CSS 管不到），
//! 而设计 token 改过好几轮（`#0b0d12` → `#0a0a0b`）。两边一旦漂移，窗口顶部
//! 就会多出一条色差，用户第一眼就能看见「标题栏和主题不一样」。
//! 这里直接读 `src/styles/` 校验，改 token 忘了改常量就会红。
//!
//! 样式在 1.0.4 拆成 `src/styles/*.css`：不能再 `include_str!` 写死某一个文件，
//! 按目录全量扫描，token 换文件也不用改测试。

use std::fs;
use std::path::{Path, PathBuf};

use luma_lib::window::{CAPTION_BORDER_RGB, CAPTION_RGB, CAPTION_TEXT_RGB};

/// 读 `src/styles/` 下的全部 CSS（文件名排序，让同名 token 的覆盖顺序稳定）。
fn styles_css() -> String {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/styles");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("读不到 {}: {err}", dir.display()))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "css"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "{} 下没有 CSS 文件", dir.display());
    files
        .iter()
        .map(|path| {
            fs::read_to_string(path)
                .unwrap_or_else(|err| panic!("读不到 {}: {err}", path.display()))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 从 `:root` 段里取某个 token 的十六进制值。
fn token(css: &str, name: &str) -> (u8, u8, u8) {
    let key = format!("--{name}:");
    let start = css
        .find(&key)
        .unwrap_or_else(|| panic!("CSS 缺少 token {key}"));
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
    let css = styles_css();
    assert_eq!(CAPTION_RGB, token(&css, "bg"), "标题栏底色需等于 --bg");
    assert_eq!(
        CAPTION_TEXT_RGB,
        token(&css, "text"),
        "标题栏文字需等于 --text"
    );
    assert_eq!(
        CAPTION_BORDER_RGB,
        token(&css, "border"),
        "窗口边框需等于 --border"
    );
}
