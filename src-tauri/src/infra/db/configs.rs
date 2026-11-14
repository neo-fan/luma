use super::*;

impl Db {
    // ---- configs ----------------------------------------------------------

    pub fn config_rows(&self) -> Result<Vec<ConfigRow>, AppError> {
        self.with("load configs", |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, imported_at, imported_json, runtime_json, source_json
                 FROM configs ORDER BY updated_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ConfigRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    imported_at: row.get(2)?,
                    imported_json: row.get(3)?,
                    runtime_json: row.get(4)?,
                    source_json: row.get(5)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    pub(super) fn upsert_config(conn: &Connection, row: ConfigWrite<'_>) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO configs
                 (id, name, imported_at, imported_json, runtime_json, source_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 imported_at = excluded.imported_at,
                 imported_json = excluded.imported_json,
                 runtime_json = excluded.runtime_json,
                 source_json = excluded.source_json,
                 updated_at = excluded.updated_at",
            params![
                row.id,
                row.name,
                row.imported_at,
                row.imported_json,
                row.runtime_json,
                row.source_json,
                now_ms() as i64,
            ],
        )?;
        Ok(())
    }

    /// Rewrite one config row **without** touching the active marker.
    ///
    /// Used by rename: the row's `imported`/`runtime` JSON both carry the name,
    /// so the caller re-serialises them, but renaming must never switch which
    /// config is live.
    pub fn update_config(&self, row: ConfigWrite<'_>) -> Result<(), AppError> {
        self.with("update config", |conn| {
            let tx = conn.transaction()?;
            Self::upsert_config(&tx, row)?;
            tx.commit()
        })
    }

    /// Write a config AND switch the active id in one transaction. Previously
    /// these were two separate files, so a crash between them could leave the
    /// active marker pointing at a config that was never there.
    pub fn activate_config(&self, row: ConfigWrite<'_>) -> Result<(), AppError> {
        self.with("activate config", |conn| {
            let tx = conn.transaction()?;
            Self::upsert_config(&tx, row)?;
            Self::meta_set(&tx, META_ACTIVE, row.id)?;
            tx.commit()
        })
    }

    /// Remove a config; when it was active, atomically pick the newest
    /// remaining one. Returns the id that should become active (if any).
    pub fn delete_config(&self, id: &str) -> Result<Option<String>, AppError> {
        self.with("delete config", |conn| {
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM configs WHERE id = ?1", params![id])?;
            let was_active = tx
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    params![META_ACTIVE],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .as_deref()
                == Some(id);
            let next = if was_active {
                let candidate = tx
                    .query_row(
                        "SELECT id FROM configs ORDER BY imported_at DESC, updated_at DESC LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                match &candidate {
                    Some(next_id) => Self::meta_set(&tx, META_ACTIVE, next_id)?,
                    None => Self::meta_delete(&tx, META_ACTIVE)?,
                }
                candidate
            } else {
                None
            };
            tx.commit()?;
            Ok(next)
        })
    }

    /// Persist a runtime derivation (see `ConfigStore::load`).
    pub fn set_runtime_json(&self, id: &str, runtime_json: &str) -> Result<(), AppError> {
        self.with("save runtime snapshot", |conn| {
            conn.execute(
                "UPDATE configs SET runtime_json = ?2 WHERE id = ?1",
                params![id, runtime_json],
            )?;
            Ok(())
        })
    }
}
