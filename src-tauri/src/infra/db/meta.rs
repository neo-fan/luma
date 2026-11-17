use super::*;

impl Db {
    // ---- meta -------------------------------------------------------------

    pub(super) fn meta_get(&self, key: &str) -> Result<Option<String>, AppError> {
        self.with("read meta", |conn| {
            conn.query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
    }

    pub(super) fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub(super) fn meta_delete(conn: &Connection, key: &str) -> rusqlite::Result<()> {
        conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// 通用 meta 读：订阅刷新把「上次检查/上次变化/错误」存在 meta 里，
    /// 而不是给 `configs` 加列——这三项是运行时状态，不是配置本体，也不
    /// 参与 imported/runtime 双快照语义。
    pub fn meta_read(&self, key: &str) -> Result<Option<String>, AppError> {
        self.meta_get(key)
    }

    pub fn meta_write(&self, key: &str, value: &str) -> Result<(), AppError> {
        self.with("write meta", |conn| Self::meta_set(conn, key, value))
    }

    pub fn meta_remove(&self, key: &str) -> Result<(), AppError> {
        self.with("remove meta", |conn| Self::meta_delete(conn, key))
    }

    /// 按键前缀批量读取（`refresh_state:` 一次取全部配置的刷新状态，
    /// 避免配置列表逐行查库）。
    pub fn meta_scan(&self, prefix: &str) -> Result<Vec<(String, String)>, AppError> {
        self.with("scan meta", |conn| {
            let mut stmt = conn.prepare("SELECT key, value FROM meta WHERE key LIKE ?1")?;
            let rows = stmt.query_map(params![format!("{prefix}%")], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    pub fn active_config_id(&self) -> Result<Option<String>, AppError> {
        self.meta_get(META_ACTIVE)
    }

    pub fn set_active_config_id(&self, id: Option<&str>) -> Result<(), AppError> {
        self.with("set active config", |conn| match id {
            Some(id) => Self::meta_set(conn, META_ACTIVE, id),
            None => Self::meta_delete(conn, META_ACTIVE),
        })
    }
}
