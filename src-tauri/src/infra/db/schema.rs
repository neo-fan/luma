use super::*;

impl Db {
    pub(super) fn create_schema(&self) -> Result<(), AppError> {
        self.with("create schema", |conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS meta (
                     key   TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS configs (
                     id            TEXT PRIMARY KEY,
                     name          TEXT NOT NULL,
                     imported_at   TEXT NOT NULL,
                     imported_json TEXT NOT NULL,
                     runtime_json  TEXT NOT NULL DEFAULT '',
                     source_json   TEXT NOT NULL,
                     updated_at    INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS favorites (
                     site_key  TEXT NOT NULL,
                     vod_id    TEXT NOT NULL,
                     name      TEXT NOT NULL,
                     pic       TEXT NOT NULL DEFAULT '',
                     remarks   TEXT NOT NULL DEFAULT '',
                     site_name TEXT NOT NULL DEFAULT '',
                     added_at  INTEGER NOT NULL,
                     PRIMARY KEY (site_key, vod_id)
                 );
                 CREATE TABLE IF NOT EXISTS history (
                     site_key    TEXT NOT NULL,
                     vod_id      TEXT NOT NULL,
                     name        TEXT NOT NULL,
                     pic         TEXT NOT NULL DEFAULT '',
                     remarks     TEXT NOT NULL DEFAULT '',
                     site_name   TEXT NOT NULL DEFAULT '',
                     play_url    TEXT NOT NULL DEFAULT '',
                     episode_name TEXT NOT NULL DEFAULT '',
                     play_from   TEXT NOT NULL DEFAULT '',
                     position_ms INTEGER NOT NULL DEFAULT 0,
                     duration_ms INTEGER NOT NULL DEFAULT 0,
                     resolution  TEXT NOT NULL DEFAULT '',
                     updated_at  INTEGER NOT NULL,
                     PRIMARY KEY (site_key, vod_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_favorites_added
                     ON favorites(added_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_history_updated
                     ON history(updated_at DESC);",
            )?;
            // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a
            // database created before episode/line tracking keeps its 10-column
            // `history` until the columns are added explicitly.
            Self::ensure_history_columns(conn)
        })
    }

    /// Additive, idempotent migration for `history`.
    pub(super) fn ensure_history_columns(conn: &Connection) -> rusqlite::Result<()> {
        let existing: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(history)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for column in ["episode_name", "play_from", "resolution"] {
            if !existing.iter().any(|name| name == column) {
                conn.execute(
                    &format!("ALTER TABLE history ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"),
                    [],
                )?;
            }
        }
        Ok(())
    }
}
