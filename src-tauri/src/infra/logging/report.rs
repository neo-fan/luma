use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

/// 每个日志文件最多带多少行到反馈文件里。7 个文件 × 400 行足够定位，
/// 又不会把用户的历史日志整包发出来。
const REPORT_TAIL_LINES: usize = 400;

/// Howard Hinnant 的 `civil_from_days`：把 1970-01-01 起的天数转成公历。
pub(super) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (y + i64::from(month <= 2), month as u32, day as u32)
}

fn utc_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// 生成反馈文件（命令层在 `domain/diagnostics.rs`）。
pub(crate) fn write_report(config: Option<diagnostics::ConfigDigest>) -> Result<String, AppError> {
    let diag = diagnostics::collect(config);
    let dir = crate::store::data_dir().join("reports");
    fs::create_dir_all(&dir)
        .map_err(|err| AppError::new(code::INTERNAL, "create report dir failed").with_cause(err.to_string()))?;
    let path = dir.join(format!("luma-report-{}.txt", utc_stamp()));

    let mut text = String::new();
    text.push_str("Luma 反馈文件（可整份发送，无需额外说明）\n");
    text.push_str(&format!("生成时间(UTC): {}\n", utc_stamp()));
    text.push_str(&format!("版本: {}\n平台: {}/{}\n", diag.version, diag.os, diag.arch));
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

    fs::write(&path, text)
        .map_err(|err| AppError::new(code::INTERNAL, "write report failed").with_cause(err.to_string()))?;
    // 文件选中失败不影响「已生成」这个事实，用户仍能在设置页看到路径。
    let _ = reveal(&path);
    Ok(path.display().to_string())
}
