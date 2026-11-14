use std::process::Command;

fn main() {
    tauri_build::build();

    // 前后端统一的 build 号：构建时刻时间戳（epoch 秒）+ 提交 short hash。
    // 时间戳回答「这个包是不是刚构建的」，hash 回答「前后端是不是同源代码」。
    // 前端 vite.config.ts 用同一套语义注入（见 __BUILD_TIME__ / __BUILD_HASH__）。
    //
    // 注意：cargo 只在 build script 声明的 rerun 条件变化时才重跑本文件，
    // 而 tauri_build 只声明了配置类文件。这里补上 git 元数据，否则提交之后
    // 不重新跑 build script，hash 会一直是第一次配置时的值。
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    println!("cargo:rerun-if-env-changed=LUMA_BUILD_HASH");
    println!("cargo:rerun-if-env-changed=LUMA_BUILD_TIME");

    // 优先读环境变量（重编脚本显式注入，避免 cargo 子进程取不到 git 时回退 unknown）；
    // 时间戳始终优先用构建时刻，不用 git 提交时间——用户要的是「这个 exe 什么时候编的」。
    let hash = match std::env::var("LUMA_BUILD_HASH") {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => git_hash(),
    };
    let time = match std::env::var("LUMA_BUILD_TIME") {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => now_epoch_secs(),
    };
    println!("cargo:rustc-env=BUILD_HASH={hash}");
    println!("cargo:rustc-env=BUILD_TIME={time}");
}

/// 构建时刻（epoch 秒）。只作为兜底：运行时诊断优先读 exe 文件 mtime，
/// 那个值不受 build script 缓存影响，永远对应真实的编译完成时刻。
fn now_epoch_secs() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

/// 提交 short hash。`git rev-parse` 在没有提交的仓库会打印 "HEAD" 而非报错，
/// 所以只接受十六进制串，其余情况统一回退 unknown。
fn git_hash() -> String {
    if let Ok(out) = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
    {
        if out.status.success() {
            let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !hash.is_empty() && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return hash;
            }
        }
    }
    "unknown".to_string()
}
