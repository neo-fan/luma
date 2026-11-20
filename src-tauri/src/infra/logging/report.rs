use super::*;

/// 每个日志文件最多带多少行到反馈文件里。7 个文件 × 400 行足够定位，
/// 又不会把用户的历史日志整包发出来。
const REPORT_TAIL_LINES: usize = 400;

/// 反馈文件的时间戳：系统时区，文件名用紧凑格式（Windows 文件名不能带 `:`）。
///
/// 以前这里手搓了一套 UTC 天文日换算（`civil_from_days`）来拼文件名和标题，
/// 与日志行的时间口径还不一致：标题写着 UTC，用户按本地时间读。现在统一走
/// `chrono::Local`，日志行、文件名、标题三者同一个时钟。
fn local_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

fn local_iso() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S %:z").to_string()
}

/// 生成反馈文件（命令层在 `domain/diagnostics.rs`）。
pub(crate) fn write_report(config: Option<diagnostics::ConfigDigest>) -> Result<String, AppError> {
    let diag = diagnostics::collect(config);
    let dir = crate::store::data_dir().join("reports");
    fs::create_dir_all(&dir).map_err(|err| {
        AppError::new(code::INTERNAL, "create report dir failed").with_cause(err.to_string())
    })?;
    let path = dir.join(format!("luma-report-{}.txt", local_stamp()));

    let mut text = String::new();
    text.push_str("Luma 反馈文件（可整份发送，无需额外说明）\n");
    text.push_str(&format!("生成时间: {}\n", local_iso()));
    text.push_str(&format!(
        "版本: {}\n通道: {}\n平台: {}/{}\n",
        diag.version, diag.channel, diag.os, diag.arch
    ));
    text.push('\n');
    text.push_str("== 诊断 ==\n");
    text.push_str(&serde_json::to_string_pretty(&diag).unwrap_or_else(|_| "{}".to_string()));
    text.push_str("\n\n== 日志（每份最后 ");
    text.push_str(&REPORT_TAIL_LINES.to_string());
    text.push_str(" 行）==\n");
    for info in &diag.log_files {
        let raw = crate::textio::read_file(&log_dir().join(&info.name)).unwrap_or_default();
        let lines: Vec<&str> = raw.lines().collect();
        let start = lines.len().saturating_sub(REPORT_TAIL_LINES);
        text.push_str(&format!("\n--- {} ({} 字节) ---\n", info.name, info.bytes));
        text.push_str(&lines[start..].join("\n"));
        text.push('\n');
    }

    fs::write(&path, text).map_err(|err| {
        AppError::new(code::INTERNAL, "write report failed").with_cause(err.to_string())
    })?;
    // 文件选中失败不影响「已生成」这个事实，用户仍能在设置页看到路径。
    let _ = reveal(&path);
    Ok(path.display().to_string())
}
