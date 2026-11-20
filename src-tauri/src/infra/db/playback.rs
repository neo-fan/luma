use super::*;

/// `upsert_playback` 的结果：最终落库的行 + 本次因容量裁剪掉的 title_key。
///
/// 回传被裁的键，让内存缓存按同一份报告增量更新，不必写完重读全表。
pub struct PlaybackUpsert {
    pub merged: PlaybackRow,
    pub removed: Vec<String>,
}

/// 单表查询的列顺序（与 `playback_from_row` 严格一致）。
const SELECT_COLS: &str = "id, title_key, title, subscription_address, subscription_id, \
     site_key, site_name, vod_id, line_name, episode_name, episode_number, play_url, \
     pic, remarks, douban_id, position_ms, duration_ms, resolution, rate, skip_json, \
     prefs_json, favorite, favorite_at, created_at, updated_at";

impl Db {
    /// 全部播放记录（历史页）：最近观看优先。
    pub fn playback(&self) -> Result<Vec<PlaybackRow>, AppError> {
        self.with("load playback", |conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {SELECT_COLS} FROM playback ORDER BY updated_at DESC"
            ))?;
            let rows = stmt.query_map([], playback_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// 收藏页：favorite = 1，按收藏时间倒序。
    pub fn favorite_playback(&self) -> Result<Vec<PlaybackRow>, AppError> {
        self.with("load favorite playback", |conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {SELECT_COLS} FROM playback WHERE favorite = 1 ORDER BY favorite_at DESC"
            ))?;
            let rows = stmt.query_map([], playback_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// 写入一条播放记录（按 `title_key` UPSERT）。
    ///
    /// 收藏 flag / 收藏时间 / 创建时间**不被覆盖**：播放行为不该取消收藏，
    /// 也不该把「收藏时间」刷成「最近播放时间」。
    pub fn upsert_playback(&self, row: &PlaybackRow) -> Result<PlaybackUpsert, AppError> {
        self.with("upsert playback", |conn| {
            let tx = conn.transaction()?;
            let title_key = row.title_key.trim().to_string();
            tx.execute(
                "INSERT INTO playback (
                     title_key, title, subscription_address, subscription_id,
                     site_key, site_name, vod_id, line_name, episode_name, episode_number,
                     play_url, pic, remarks, douban_id, position_ms, duration_ms, resolution,
                     rate, skip_json, prefs_json, favorite, favorite_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
                 ON CONFLICT(title_key) DO UPDATE SET
                     title = excluded.title,
                     subscription_address = excluded.subscription_address,
                     subscription_id = excluded.subscription_id,
                     site_key = excluded.site_key,
                     site_name = CASE WHEN excluded.site_name <> '' THEN excluded.site_name ELSE site_name END,
                     vod_id = excluded.vod_id,
                     line_name = excluded.line_name,
                     episode_name = excluded.episode_name,
                     episode_number = COALESCE(excluded.episode_number, episode_number),
                     play_url = excluded.play_url,
                     pic = CASE WHEN excluded.pic <> '' THEN excluded.pic ELSE pic END,
                     remarks = CASE WHEN excluded.remarks <> '' THEN excluded.remarks ELSE remarks END,
                     douban_id = CASE WHEN excluded.douban_id <> '' THEN excluded.douban_id ELSE douban_id END,
                     position_ms = excluded.position_ms,
                     duration_ms = excluded.duration_ms,
                     resolution = CASE WHEN excluded.resolution <> '' THEN excluded.resolution ELSE resolution END,
                     rate = CASE WHEN excluded.rate > 0 THEN excluded.rate ELSE rate END,
                     skip_json = CASE WHEN excluded.skip_json <> '' THEN excluded.skip_json ELSE skip_json END,
                     prefs_json = CASE WHEN excluded.prefs_json NOT IN ('', '{}') THEN excluded.prefs_json ELSE prefs_json END,
                     updated_at = excluded.updated_at",
                params![
                    title_key,
                    row.title,
                    row.subscription_address,
                    row.subscription_id,
                    row.site_key,
                    row.site_name,
                    row.vod_id,
                    row.line_name,
                    row.episode_name,
                    row.episode_number,
                    row.play_url,
                    row.pic,
                    row.remarks,
                    row.douban_id,
                    row.position_ms as i64,
                    row.duration_ms as i64,
                    row.resolution,
                    row.rate,
                    row.skip_json,
                    row.prefs_json,
                    if row.favorite { 1i64 } else { 0i64 },
                    row.favorite_at.map(|v| v as i64),
                    row.created_at as i64,
                    row.updated_at as i64,
                ],
            )?;

            // 容量裁剪：只裁非收藏行，收藏永远不因 500 条上限被删。
            // 两条语句都排除本次写入的 title_key：调用方若传了过期 updated_at
            // （时钟回拨 / 恢复的旧会话），刚写入的行仍必须留在库里，否则下方
            // `query_row` 回读 merged 会 QueryReturnedNoRows → 整笔写入回滚。
            let removed: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT title_key FROM playback
                     WHERE favorite = 0 AND title_key <> ?2 AND id NOT IN (
                         SELECT id FROM playback WHERE favorite = 0
                         ORDER BY updated_at DESC LIMIT ?1
                     )",
                )?;
                // 解码失败必须上抛：吞掉 Err 会让「待裁剪行集合」与随后的
                // DELETE 实际删除集合分叉，缓存按 removed 增量更新后与库静默不一致。
                let collected = stmt.query_map(
                    params![MAX_HISTORY as i64, title_key],
                    |r| r.get::<_, String>(0),
                )?
                .collect::<rusqlite::Result<Vec<String>>>()?;
                collected
            };
            if !removed.is_empty() {
                tx.execute(
                    "DELETE FROM playback
                     WHERE favorite = 0 AND title_key <> ?2 AND id NOT IN (
                         SELECT id FROM playback WHERE favorite = 0
                         ORDER BY updated_at DESC LIMIT ?1
                     )",
                    params![MAX_HISTORY as i64, title_key],
                )?;
            }

            let merged = tx.query_row(
                &format!("SELECT {SELECT_COLS} FROM playback WHERE title_key = ?1"),
                params![title_key],
                playback_from_row,
            )?;
            tx.commit()?;
            Ok(PlaybackUpsert { merged, removed })
        })
    }

    /// 收藏 / 取消收藏：**只改 flag，不删行**；行不存在则新建一条无进度记录。
    pub fn toggle_playback_favorite(&self, seed: &PlaybackRow) -> Result<bool, AppError> {
        self.with("toggle playback favorite", |conn| {
            let tx = conn.transaction()?;
            // 与 upsert_playback 同口径：title_key 去首尾空白，避免同一部片
            // 因调用方传入带空白的 key 而产生两行 / 星标错乱。
            let title_key = seed.title_key.trim();
            let current: Option<bool> = tx
                .query_row(
                    "SELECT favorite FROM playback WHERE title_key = ?1",
                    params![title_key],
                    |r| Ok(r.get::<_, i64>(0)? != 0),
                )
                .optional()?;
            let next = !current.unwrap_or(false);
            match current {
                Some(_) => {
                    // 收藏/取消都跟随「最近一次操作的源」：收藏是剧级的，但行上
                    // 的 site/vod 定位要指向用户刚才那一条，否则按 (site, vod)
                    // 判断星标会对不上（换源后 vod_id 变了）。
                    tx.execute(
                        "UPDATE playback SET favorite = ?1,
                             favorite_at = CASE WHEN ?1 = 1 THEN ?2 ELSE NULL END,
                             site_key = ?3,
                             site_name = ?4,
                             vod_id = ?5,
                             title = ?6
                         WHERE title_key = ?7",
                        params![
                            if next { 1i64 } else { 0i64 },
                            now_ms() as i64,
                            seed.site_key.as_str(),
                            seed.site_name.as_str(),
                            seed.vod_id.as_str(),
                            seed.title.as_str(),
                            title_key,
                        ],
                    )?;
                }
                None => {
                    tx.execute(
                        "INSERT INTO playback (
                             title_key, title, subscription_address, subscription_id,
                             site_key, site_name, vod_id, line_name, episode_name, episode_number,
                             play_url, pic, remarks, douban_id, position_ms, duration_ms, resolution,
                             rate, skip_json, prefs_json, favorite, favorite_at, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                                   ?13, ?14, 0, 0, ?15, 0, '', '{}', 1, ?16, ?16, ?16)",
                        params![
                            title_key,
                            seed.title,
                            seed.subscription_address,
                            seed.subscription_id,
                            seed.site_key,
                            seed.site_name,
                            seed.vod_id,
                            seed.line_name,
                            seed.episode_name,
                            seed.episode_number,
                            seed.play_url,
                            seed.pic,
                            seed.remarks,
                            seed.douban_id,
                            seed.resolution,
                            now_ms() as i64,
                        ],
                    )?;
                }
            }
            tx.commit()?;
            Ok(next)
        })
    }

    /// 补元数据（封面 / 备注 / 站点名 / 豆瓣 id）。空值不覆盖，且**不动**
    /// `updated_at`——回填封面不该把老记录顶到列表最前。
    pub fn patch_playback_meta(
        &self,
        title_key: &str,
        title: &str,
        pic: &str,
        remarks: &str,
        site_name: &str,
        douban_id: &str,
    ) -> Result<bool, AppError> {
        self.with("patch playback meta", |conn| {
            let changed = conn.execute(
                "UPDATE playback SET
                     title = CASE WHEN ?2 <> '' THEN ?2 ELSE title END,
                     pic = CASE WHEN ?3 <> '' THEN ?3 ELSE pic END,
                     remarks = CASE WHEN ?4 <> '' THEN ?4 ELSE remarks END,
                     site_name = CASE WHEN ?5 <> '' THEN ?5 ELSE site_name END,
                     douban_id = CASE WHEN ?6 <> '' THEN ?6 ELSE douban_id END
                 WHERE title_key = ?1",
                params![title_key, title, pic, remarks, site_name, douban_id],
            )?;
            Ok(changed > 0)
        })
    }

    /// 清除播放记录：只删非收藏，收藏行连进度一起保留。
    pub fn clear_playback(&self) -> Result<usize, AppError> {
        self.with("clear playback", |conn| {
            Ok(conn.execute("DELETE FROM playback WHERE favorite = 0", [])?)
        })
    }

    /// 按 (site_key, vod_id) 删除单条（历史页删除入口）。
    ///
    /// 直接查库而非依赖调用方缓存：缓存可能因写后 reload 的窗口期 / 并发
    /// 尚未包含该行，从缓存找 key 会「查不到 → 静默成功」而 DB 行残留。
    /// 返回删除行数，供调用方决定是否刷新缓存。
    pub fn remove_playback_ref(&self, site_key: &str, vod_id: &str) -> Result<usize, AppError> {
        self.with("remove playback by ref", |conn| {
            Ok(conn.execute(
                "DELETE FROM playback WHERE site_key = ?1 AND vod_id = ?2",
                params![site_key, vod_id],
            )?)
        })
    }
}

fn playback_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlaybackRow> {
    Ok(PlaybackRow {
        id: row.get(0)?,
        title_key: row.get(1)?,
        title: row.get(2)?,
        subscription_address: row.get(3)?,
        subscription_id: row.get(4)?,
        site_key: row.get(5)?,
        site_name: row.get(6)?,
        vod_id: row.get(7)?,
        line_name: row.get(8)?,
        episode_name: row.get(9)?,
        episode_number: row.get(10)?,
        play_url: row.get(11)?,
        pic: row.get(12)?,
        remarks: row.get(13)?,
        douban_id: row.get(14)?,
        position_ms: row.get::<_, i64>(15)? as u64,
        duration_ms: row.get::<_, i64>(16)? as u64,
        resolution: row.get(17)?,
        rate: row.get(18)?,
        skip_json: row.get(19)?,
        prefs_json: row.get(20)?,
        favorite: row.get::<_, i64>(21)? != 0,
        favorite_at: row.get::<_, Option<i64>>(22)?.map(|v| v as u64),
        created_at: row.get::<_, i64>(23)? as u64,
        updated_at: row.get::<_, i64>(24)? as u64,
    })
}
