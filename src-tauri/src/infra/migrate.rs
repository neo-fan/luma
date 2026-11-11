//! One-time data migration from the pre-rename app ("TVBox Desktop").
//!
//! Old layout: `%APPDATA%\tvbox-desktop\tvbox.db` (plus `-wal` / `-shm`) and
//! JSON backups. New layout: `<data dir>\luma.db`.
//!
//! The old directory is **never modified or deleted**. A `VACUUM INTO`
//! snapshot is used instead of copying the raw database file: under WAL mode
//! the main file alone does not contain recently committed rows, and copying
//! db + wal while an older process is still running can produce a torn tail.
//! `VACUUM INTO` asks SQLite for a consistent read snapshot (including
//! committed WAL frames) and writes one self-contained database file.

use crate::error::{code, AppError};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LEGACY_DIR: &str = "tvbox-desktop";
pub const LEGACY_DB: &str = "tvbox.db";
pub const MARKER: &str = ".migrated-from-tvbox";
const JSON_BACKUPS: &[&str] = &["active.json", "favorites.json", "history.json"];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    /// Legacy directory that supplied the database (or the JSON backups).
    pub source: Option<PathBuf>,
    pub configs: usize,
    pub favorites: usize,
    pub history: usize,
    pub json_backups: usize,
}

/// Migrate into `target/luma.db` when it does not exist yet.
///
/// `legacy_dir` overrides the `%APPDATA%` lookup; it exists so the unit tests
/// never touch the developer's real data. Failure is logged but never aborts
/// startup: an empty new database is preferable to a crashed app.
pub fn from_tvbox(target: &Path, new_db: &Path, legacy_dir: Option<&Path>) -> Result<Report, AppError> {
    std::fs::create_dir_all(target).map_err(|err| {
        AppError::new(code::INTERNAL, "create data dir failed").with_cause(err.to_string())
    })?;
    // Re-running is cheap and safe: once luma.db exists this is a no-op. If a
    // user deletes the new database, the next launch simply migrates again.
    if new_db.exists() {
        return Ok(Report::default());
    }

    let roots = legacy_roots(target, legacy_dir);
    for legacy in &roots {
        let old_db = legacy.join(LEGACY_DB);
        if !old_db.is_file() {
            continue;
        }
        match snapshot(&old_db, new_db) {
            Ok(mut report) => {
                report.json_backups = copy_json_backups(legacy, target);
                report.source = Some(legacy.clone());
                write_marker(target, legacy);
                tracing::info!(
                    source = %legacy.display(),
                    configs = report.configs,
                    favourites = report.favorites,
                    history = report.history,
                    "migrated legacy tvbox.db into luma.db"
                );
                return Ok(report);
            }
            Err(err) => {
                // A failed VACUUM can leave a partial target file behind.
                let _ = std::fs::remove_file(new_db);
                tracing::warn!(
                    error = %err,
                    source = %old_db.display(),
                    "legacy database snapshot failed; trying the next candidate"
                );
            }
        }
    }

    // No old database (a user coming straight from the JSON era): carry the
    // backups over so `db.rs::migrate_legacy` can import them on this launch.
    for legacy in &roots {
        let copied = copy_json_backups(legacy, target);
        if copied > 0 {
            write_marker(target, legacy);
            tracing::info!(source = %legacy.display(), copied, "migrated legacy json backups");
            return Ok(Report {
                source: Some(legacy.clone()),
                json_backups: copied,
                ..Report::default()
            });
        }
    }
    Ok(Report::default())
}

/// Candidate legacy directories, most relevant first:
/// 1. an explicit override (tests),
/// 2. the target `data/` itself — portable upgrades keep the same folder,
/// 3. `%APPDATA%\tvbox-desktop` — the old installed/dev location.
fn legacy_roots(target: &Path, explicit: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = explicit {
        push_unique(&mut roots, dir.to_path_buf());
    }
    push_unique(&mut roots, target.to_path_buf());
    if explicit.is_none() {
        if let Ok(appdata) = std::env::var("APPDATA") {
            if !appdata.trim().is_empty() {
                push_unique(&mut roots, PathBuf::from(appdata).join(LEGACY_DIR));
            }
        }
    }
    roots
}

/// Ask SQLite for a consistent snapshot of `old_db` into `new_db`.
fn snapshot(old_db: &Path, new_db: &Path) -> Result<Report, String> {
    // Prefer a read-only handle so the old database (possibly still open in an
    // older process) is neither checkpointed nor modified. Older SQLite builds
    // refuse read-only WAL access when the -shm file is missing, hence the
    // read/write fallback; VACUUM INTO never changes the source database.
    let source = Connection::open_with_flags(old_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .or_else(|_| Connection::open(old_db))
        .map_err(|err| err.to_string())?;
    let literal = new_db.to_string_lossy().replace('\'', "''");
    let result = source
        .execute(
            "VACUUM INTO ?1",
            rusqlite::params![new_db.to_string_lossy().as_ref()],
        )
        .map(|_| ())
        .or_else(|_| source.execute_batch(&format!("VACUUM INTO '{literal}'")))
        .map_err(|err| err.to_string());
    drop(source);
    result?;

    let check = Connection::open_with_flags(new_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| err.to_string())?;
    let count = |table: &str| {
        check
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize
    };
    Ok(Report {
        configs: count("configs"),
        favorites: count("favorites"),
        history: count("history"),
        ..Report::default()
    })
}

/// Keep the pre-SQLite JSON files as a backup in the new data directory. They
/// are never deleted from the old one; `db.rs` only reads them on a fresh DB.
fn copy_json_backups(from: &Path, to: &Path) -> usize {
    if from == to {
        return 0;
    }
    let mut copied = 0;
    for name in JSON_BACKUPS {
        let src = from.join(name);
        if src.is_file() && std::fs::copy(&src, to.join(name)).is_ok() {
            copied += 1;
        }
    }
    let configs = from.join("configs");
    if configs.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&configs) {
            for entry in entries.flatten() {
                let src = entry.path();
                if src.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                let Some(name) = src.file_name() else { continue };
                if std::fs::create_dir_all(to.join("configs")).is_err() {
                    break;
                }
                if std::fs::copy(&src, to.join("configs").join(name)).is_ok() {
                    copied += 1;
                }
            }
        }
    }
    copied
}

fn write_marker(target: &Path, source: &Path) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(
        target.join(MARKER),
        format!("migrated_at_unix={stamp}\nsource={}\n", source.display()),
    );
}

fn push_unique(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if !roots.contains(&path) {
        roots.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("luma-migrate-{label}-{stamp}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Keep the connection open: rows stay in the WAL, which is exactly the
    /// state a raw file copy would mishandle.
    fn legacy_db(dir: &Path) -> Connection {
        let conn = Connection::open(dir.join(LEGACY_DB)).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE configs (id TEXT);
             CREATE TABLE favorites (site_key TEXT);
             CREATE TABLE history (site_key TEXT);
             INSERT INTO configs VALUES ('box');
             INSERT INTO favorites VALUES ('cms');
             INSERT INTO history VALUES ('cms');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn snapshot_includes_committed_wal_rows_and_keeps_the_original() {
        let legacy = temp("wal");
        let target = temp("wal-target");
        let _keep_open = legacy_db(&legacy);
        let old_db = legacy.join(LEGACY_DB);
        let old_size = std::fs::metadata(&old_db).unwrap().len();
        std::fs::write(legacy.join("active.json"), "box").unwrap();
        let configs = legacy.join("configs");
        std::fs::create_dir_all(&configs).unwrap();
        std::fs::write(configs.join("box.json"), "{}").unwrap();

        let new_db = target.join("luma.db");
        let report = from_tvbox(&target, &new_db, Some(&legacy)).unwrap();
        assert_eq!(report.source.as_deref(), Some(legacy.as_path()));
        assert_eq!((report.configs, report.favorites, report.history), (1, 1, 1));
        assert_eq!(report.json_backups, 2);

        let check = Connection::open_with_flags(&new_db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let rows: i64 = check
            .query_row("SELECT count(*) FROM configs WHERE id = 'box'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "committed WAL rows must survive the rename");
        assert!(old_db.is_file(), "the legacy database must not be deleted");
        assert_eq!(std::fs::metadata(&old_db).unwrap().len(), old_size);
        assert!(target.join(MARKER).is_file());
        assert!(target.join("configs/box.json").is_file());
        drop(check);

        // A second launch is a no-op, even though the old files are still there.
        let again = from_tvbox(&target, &new_db, Some(&legacy)).unwrap();
        assert_eq!(again, Report::default());
        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn json_only_upgrade_copies_backups_without_faking_a_database() {
        let legacy = temp("json");
        let target = temp("json-target");
        let configs = legacy.join("configs");
        std::fs::create_dir_all(&configs).unwrap();
        std::fs::write(configs.join("old.json"), "{}").unwrap();
        std::fs::write(legacy.join("favorites.json"), "{\"items\":[]}").unwrap();

        let new_db = target.join("luma.db");
        let report = from_tvbox(&target, &new_db, Some(&legacy)).unwrap();
        assert!(report.source.is_some());
        assert_eq!(report.json_backups, 2);
        assert!(!new_db.exists(), "db.rs::migrate_legacy creates the database itself");
        assert!(target.join("favorites.json").is_file());
        assert!(target.join("configs/old.json").is_file());
        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn portable_upgrade_finds_old_db_in_the_same_data_dir() {
        let target = temp("portable");
        let _keep_open = legacy_db(&target);
        let new_db = target.join("luma.db");
        let report = from_tvbox(&target, &new_db, Some(&target)).unwrap();
        assert_eq!(report.configs, 1);
        assert!(new_db.is_file());
        let _ = std::fs::remove_dir_all(&target);
    }
}
