use std::process::Command;

fn main() {
    tauri_build::build();

    // 前后端统一的 build 号：取最近一次提交的 short hash 与提交时间。
    // 前端用 vite.config.ts 以完全相同的方式注入，设置页对比两者 hash 是否
    // 一致即可确认「双击的 exe 与跑的前端是不是同一次构建」。
    //
    // 优先读环境变量（重编脚本显式注入，避免 cargo 子进程取不到 git 时回退 unknown）；
    // 没有则现场调一次 git；都没有（打包机无 .git）才回退 unknown。
    let (hash, time) = match (std::env::var("LUMA_BUILD_HASH"), std::env::var("LUMA_BUILD_TIME")) {
        (Ok(h), Ok(t)) if !h.is_empty() && !t.is_empty() => (h, t),
        _ => git_build_info(),
    };
    println!("cargo:rustc-env=BUILD_HASH={hash}");
    println!("cargo:rustc-env=BUILD_TIME={time}");
}

/// 一次 git 调用同时拿到 short hash 与提交时间，避免引入额外 crate。
fn git_build_info() -> (String, String) {
    if let Ok(out) = Command::new("git")
        .args([
            "log",
            "-1",
            "--format=%h|%cd",
            "--date=format:%Y-%m-%dT%H:%M:%S%z",
        ])
        .output()
    {
        if out.status.success() {
            let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some((hash, time)) = line.split_once('|') {
                return (hash.to_string(), time.to_string());
            }
        }
    }
    ("unknown".to_string(), "unknown".to_string())
}
