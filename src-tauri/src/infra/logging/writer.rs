use super::*;

/// 按 UTC 日期命名的追加文件。中国用户 08:00 前的日志会落在前一天的文件里，
/// 这对排障足够，也避免了引入时区 crate。
pub(super) struct DailyFile {
    dir: PathBuf,
    state: Mutex<FileState>,
}

struct FileState {
    date: String,
    file: File,
}

impl DailyFile {
    pub(super) fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let date = utc_date();
        let file = open_file(dir, &date)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            state: Mutex::new(FileState { date, file }),
        })
    }

    fn write_line(&self, buf: &[u8]) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let date = utc_date();
        if state.date != date {
            state.date = date.clone();
            state.file = open_file(&self.dir, &date)?;
            prune(&self.dir);
        }
        state.file.write_all(buf)?;
        state.file.flush()
    }
}

fn open_file(dir: &Path, date: &str) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("luma-{date}.log")))
}

/// `fmt` 每写一行都会 clone 一次 writer；用 Arc 共享同一个文件句柄。
pub(super) struct SharedWriter(pub(super) Arc<DailyFile>);

impl<'a> fmt::MakeWriter<'a> for SharedWriter {
    type Writer = SharedWriter;

    fn make_writer(&'a self) -> Self::Writer {
        SharedWriter(self.0.clone())
    }
}

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_line(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("luma-") && name.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= KEEP_FILES {
        return;
    }
    files.sort();
    for old in &files[..files.len() - KEEP_FILES] {
        let _ = fs::remove_file(old);
    }
}

/// UTC 日期（YYYY-MM-DD）。手写公历换算，避免为文件名引入时间库。
fn utc_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

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
