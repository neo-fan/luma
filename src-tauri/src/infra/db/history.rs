use super::*;

/// `upsert_history` 的结果：写入方最终看到的行，**以及这次被删掉的行**。
///
/// 为什么要回传被删的键：内存缓存（`LibraryStore.history`）要保证与库里
/// 一致，以前靠「写完重读全表」实现——每条历史写入都 O(500)。改成由 SQL
/// 把自己删掉的东西报告出来，缓存按同一份报告施加，既 O(1) 又不会因为
/// `updated_at` 并列而对「谁被裁掉」产生两种理解。
pub struct HistoryUpsert {
    /// 合并了继承字段、已落库的最终行。
    pub merged: HistoryRow,
    /// 这次被删除的 `(site_key, vod_id)`：同名合并 + 超出 `MAX_HISTORY` 的裁剪。
    pub removed: Vec<(String, String)>,
}

impl Db {
    // ---- history ----------------------------------------------------------

    pub fn history(&self) -> Result<Vec<HistoryRow>, AppError> {
        self.with("load history", |conn| {
            let mut stmt = conn.prepare(
                "SELECT site_key, vod_id, name, pic, remarks, site_name,
                        play_url, position_ms, duration_ms, updated_at,
                        episode_name, play_from, resolution, rate, skip_json
                 FROM history",
            )?;
            let rows = stmt.query_map([], history_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// 写入一条播放历史。
    ///
    /// 历史以「剧名完全匹配」为单位去重：一部剧（哪怕是不同站点 / 不同 vod_id）
    /// 只保留最新一条。换源后 site_key+vod_id 会变，若仍按复合主键去重，
    /// 同一部剧会在历史页堆成多行、续播也只能认回原站点。
    /// 表主键保持 `(site_key, vod_id)` 不动（改主键需要重建表，会破坏已有库），
    /// 改为在同一事务里先删掉同名但不同 key 的旧行，再 UPSERT 当前行。
    pub fn upsert_history(&self, row: &HistoryRow) -> Result<HistoryUpsert, AppError> {
        self.with("upsert history", |conn| {
            let tx = conn.transaction()?;
            let name = row.name.trim();
            let mut merged = row.clone();
            merged.name = name.to_string();
            let mut removed: Vec<(String, String)> = Vec::new();
            if !name.is_empty() {
                // 换源时旧行会被删掉，但它可能已经补过封面 / 备注 / 站点名 /
                // 分辨率，也可能已经存过这部剧的倍速与跳过配置；这些都不该被
                // 一次「详情还没回来」的写入抹掉。先挑一条同名旧行把值继承
                // 过来，再删除所有同名旧行。
                let mut stmt = tx.prepare(
                    "SELECT pic, remarks, site_name, resolution, rate, skip_json FROM history
                     WHERE name = ?1 AND (site_key <> ?2 OR vod_id <> ?3)
                     ORDER BY updated_at DESC LIMIT 1",
                )?;
                let inherited: Option<(String, String, String, String, f64, String)> = stmt
                    .query_row(params![name, row.site_key, row.vod_id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
                    })
                    .optional()?;
                drop(stmt);
                if let Some((pic, remarks, site_name, resolution, rate, skip_json)) = inherited {
                    if merged.pic.is_empty() {
                        merged.pic = pic;
                    }
                    if merged.remarks.is_empty() {
                        merged.remarks = remarks;
                    }
                    if merged.site_name.is_empty() {
                        merged.site_name = site_name;
                    }
                    if merged.resolution.is_empty() {
                        merged.resolution = resolution;
                    }
                    // 倍速 0、跳过配置空串都表示「这次写入没带」，不是「用户清成了默认」。
                    if merged.rate == 0.0 {
                        merged.rate = rate;
                    }
                    if merged.skip_json.is_empty() {
                        merged.skip_json = skip_json;
                    }
                }
                // 被同名合并删掉的行先查出来（同一事务内，行数最多是这部剧的
                // 历史源数量，通常 1~3 行），报告给调用方做增量更新。
                let mut stmt = tx.prepare(
                    "SELECT site_key, vod_id FROM history
                     WHERE name = ?1 AND (site_key <> ?2 OR vod_id <> ?3)",
                )?;
                let rows = stmt
                    .query_map(params![name, row.site_key, row.vod_id], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })?
                    .filter_map(Result::ok)
                    .collect::<Vec<_>>();
                drop(stmt);
                removed.extend(rows);
                tx.execute(
                    "DELETE FROM history
                     WHERE name = ?1 AND (site_key <> ?2 OR vod_id <> ?3)",
                    params![name, row.site_key, row.vod_id],
                )?;
            }
            tx.execute(
                 "INSERT INTO history
                      (site_key, vod_id, name, pic, remarks, site_name,
                       play_url, position_ms, duration_ms, updated_at,
                       episode_name, play_from, resolution, rate, skip_json)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                  ON CONFLICT(site_key, vod_id) DO UPDATE SET
                      name = excluded.name,
                      -- 详情还没拉到时写入的是空封面；不能用空串覆盖掉库里已有的
                      -- 封面 / 备注 / 站点名，否则一次「先播放后详情」就把列表打回空白。
                      pic = CASE WHEN excluded.pic <> '' THEN excluded.pic ELSE pic END,
                      remarks = CASE WHEN excluded.remarks <> '' THEN excluded.remarks ELSE remarks END,
                      site_name = CASE WHEN excluded.site_name <> '' THEN excluded.site_name ELSE site_name END,
                      play_url = excluded.play_url,
                      position_ms = excluded.position_ms,
                      duration_ms = excluded.duration_ms,
                      updated_at = excluded.updated_at,
                      episode_name = excluded.episode_name,
                      play_from = excluded.play_from,
                      -- 分辨率只有真出画后才拿得到，空值（还没解码）不能抹掉已有值。
                      resolution = CASE WHEN excluded.resolution <> '' THEN excluded.resolution ELSE resolution END,
                      -- 倍速与跳过配置同理：空值 = 这次写入没带这个信息，不是用户清过。
                      -- 「真的清掉了」由调用方写显式值表达（rate 写 1.0 之外的合法值、
                      -- skip_json 写 `[]`）。
                      rate = CASE WHEN excluded.rate > 0 THEN excluded.rate ELSE rate END,
                      skip_json = CASE WHEN excluded.skip_json <> '' THEN excluded.skip_json ELSE skip_json END",
                 params![
                     merged.site_key,
                     merged.vod_id,
                     merged.name,
                     merged.pic,
                     merged.remarks,
                     merged.site_name,
                     merged.play_url,
                     merged.position_ms as i64,
                     merged.duration_ms as i64,
                     merged.updated_at as i64,
                     merged.episode_name,
                     merged.play_from,
                     merged.resolution,
                     merged.rate,
                     merged.skip_json,
                 ],
             )?;
            // Keep the newest MAX_HISTORY rows instead of rebuilding a Vec.
            // 先问「这次会裁掉谁」（正常路径 0～1 行），再删；被裁的键一并报告。
            let mut stmt = tx.prepare(
                "SELECT site_key, vod_id FROM history WHERE rowid NOT IN
                     (SELECT rowid FROM history ORDER BY updated_at DESC LIMIT ?1)",
            )?;
            let trimmed = stmt
                .query_map(params![MAX_HISTORY as i64], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            drop(stmt);
            if !trimmed.is_empty() {
                tx.execute(
                    "DELETE FROM history WHERE rowid NOT IN
                         (SELECT rowid FROM history ORDER BY updated_at DESC LIMIT ?1)",
                    params![MAX_HISTORY as i64],
                )?;
                removed.extend(trimmed);
            }
            tx.commit()?;
            Ok(HistoryUpsert {
                merged,
                removed,
            })
        })
    }

    /// 历史记录补元数据（封面 / 备注 / 站点名 / 片名）。与收藏同理：空参数
    /// 不覆盖，**`updated_at` 保持不变**——回填封面不能把老记录顶到列表最前。
    pub fn patch_history_meta(
        &self,
        site_key: &str,
        vod_id: &str,
        name: &str,
        pic: &str,
        remarks: &str,
        site_name: &str,
    ) -> Result<bool, AppError> {
        self.with("patch history meta", |conn| {
            let changed = conn.execute(
                "UPDATE history SET
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

    pub fn clear_history(&self) -> Result<(), AppError> {
        self.with("clear history", |conn| {
            conn.execute("DELETE FROM history", [])?;
            Ok(())
        })
    }

    /// 删除单条历史（历史页的「删除」按钮）。
    pub fn remove_history(&self, site_key: &str, vod_id: &str) -> Result<(), AppError> {
        self.with("remove history", |conn| {
            conn.execute(
                "DELETE FROM history WHERE site_key = ?1 AND vod_id = ?2",
                params![site_key, vod_id],
            )?;
            Ok(())
        })
    }
}
fn history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        site_key: row.get(0)?,
        vod_id: row.get(1)?,
        name: row.get(2)?,
        pic: row.get(3)?,
        remarks: row.get(4)?,
        site_name: row.get(5)?,
        play_url: row.get(6)?,
        position_ms: row.get::<_, i64>(7)? as u64,
        duration_ms: row.get::<_, i64>(8)? as u64,
        updated_at: row.get::<_, i64>(9)? as u64,
        episode_name: row.get(10)?,
        play_from: row.get(11)?,
        resolution: row.get(12)?,
        rate: row.get(13)?,
        skip_json: row.get(14)?,
    })
}
