use super::*;

impl Db {
    // ---- favourites -------------------------------------------------------

    pub fn favorites(&self) -> Result<Vec<FavoriteRow>, AppError> {
        self.with("load favourites", |conn| {
            let mut stmt = conn.prepare(
                "SELECT site_key, vod_id, name, pic, remarks, site_name, added_at
                 FROM favorites",
            )?;
            let rows = stmt.query_map([], favorite_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// Returns `true` when the row ended up favourited. The existence check and
    /// the mutation share one transaction, so two rapid toggles cannot both see
    /// the same old state.
    ///
    /// **收藏按片名**：同一部片换到别的源后 `site_key + vod_id` 全变了，
    /// 用复合主键判重会让星标显示「未收藏」、再点一次又多出一行同名收藏。
    /// 与 `upsert_history` 同口径：以 `name` 为业务身份，`site_key/vod_id`
    /// 退化为「最近一次是从哪个源收藏的」定位信息。
    pub fn toggle_favorite(&self, row: &FavoriteRow) -> Result<bool, AppError> {
        self.with("toggle favourite", |conn| {
            let tx = conn.transaction()?;
            let name = row.name.trim();
            let exists = if name.is_empty() {
                // 源没给片名时退回原来的复合键，绝不能把空名互相合并。
                tx.query_row(
                    "SELECT 1 FROM favorites WHERE site_key = ?1 AND vod_id = ?2",
                    params![row.site_key, row.vod_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            } else {
                tx.query_row(
                    "SELECT 1 FROM favorites WHERE name = ?1",
                    params![name],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            };
            if exists {
                // 连「同名但来自其它源」的历史收藏一起清掉，避免重复条目。
                if name.is_empty() {
                    tx.execute(
                        "DELETE FROM favorites WHERE site_key = ?1 AND vod_id = ?2",
                        params![row.site_key, row.vod_id],
                    )?;
                } else {
                    tx.execute("DELETE FROM favorites WHERE name = ?1", params![name])?;
                }
            } else {
                tx.execute(
                    "INSERT INTO favorites
                         (site_key, vod_id, name, pic, remarks, site_name, added_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        row.site_key,
                        row.vod_id,
                        row.name,
                        row.pic,
                        row.remarks,
                        row.site_name,
                        row.added_at as i64,
                    ],
                )?;
            }
            tx.commit()?;
            Ok(!exists)
        })
    }

    /// 只补元数据（封面 / 备注 / 站点名 / 片名），用于列表页回填早先没存
    /// 封面的记录。**空参数不覆盖已有值**，也不碰 `added_at`：收藏顺序不能
    /// 因为一次补封面就整体重排。
    pub fn patch_favorite_meta(
        &self,
        site_key: &str,
        vod_id: &str,
        name: &str,
        pic: &str,
        remarks: &str,
        site_name: &str,
    ) -> Result<bool, AppError> {
        self.with("patch favourite meta", |conn| {
            let changed = conn.execute(
                "UPDATE favorites SET
                     name = CASE WHEN ?3 <> '' THEN ?3 ELSE name END,
                     pic = CASE WHEN ?4 <> '' THEN ?4 ELSE pic END,
                     remarks = CASE WHEN ?5 <> '' THEN ?5 ELSE remarks END,
                     site_name = CASE WHEN ?6 <> '' THEN ?6 ELSE site_name END
                 WHERE site_key = ?1 AND vod_id = ?2",
                params![site_key, vod_id, name, pic, remarks, site_name],
            )?;
            Ok(changed > 0)
        })
    }
}
fn favorite_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FavoriteRow> {
    Ok(FavoriteRow {
        site_key: row.get(0)?,
        vod_id: row.get(1)?,
        name: row.get(2)?,
        pic: row.get(3)?,
        remarks: row.get(4)?,
        site_name: row.get(5)?,
        added_at: row.get::<_, i64>(6)? as u64,
    })
}
