use super::*;

/// 2.0 数据模型版本号（`PRAGMA user_version`）。升级时一次性丢弃不兼容数据。
const SCHEMA_VERSION: i64 = 2;

impl Db {
    pub(super) fn create_schema(&self) -> Result<(), AppError> {
        self.with("create schema", |conn| {
            let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS meta (
                     key   TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );
                 -- 订阅快照（过渡期沿用 configs：sites/lives 是半结构化 JSON，
                 -- 拆表会丢未知字段）。2.0 起订阅唯一性由裸地址决定。
                 CREATE TABLE IF NOT EXISTS configs (
                     id            TEXT PRIMARY KEY,
                     name          TEXT NOT NULL,
                     imported_at   TEXT NOT NULL,
                     imported_json TEXT NOT NULL,
                     runtime_json  TEXT NOT NULL DEFAULT '',
                     source_json   TEXT NOT NULL,
                     updated_at    INTEGER NOT NULL
                 );
                 -- 订阅：唯一性 = 裸地址；kind=text 时 address 为 inline:<hash>，
                 -- 正文在 payload。这是 2.0 的目标存储，与 configs 并存一个过渡期。
                 CREATE TABLE IF NOT EXISTS subscriptions (
                     id              TEXT PRIMARY KEY,
                     kind            TEXT NOT NULL,
                     address         TEXT NOT NULL,
                     payload         TEXT NOT NULL DEFAULT '',
                     name            TEXT NOT NULL,
                     enabled         INTEGER NOT NULL DEFAULT 1,
                     imported_json   TEXT NOT NULL DEFAULT '',
                     runtime_json    TEXT NOT NULL DEFAULT '',
                     refresh_hours   INTEGER NOT NULL DEFAULT 12,
                     last_checked_at INTEGER,
                     last_changed_at INTEGER,
                     refresh_error   TEXT,
                     created_at      INTEGER NOT NULL,
                     updated_at      INTEGER NOT NULL
                 );
                 -- 播放记录单表：收藏只是 favorite flag；按 title_key（归一化剧名）合并。
                 CREATE TABLE IF NOT EXISTS playback (
                     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                     title_key            TEXT NOT NULL,
                     title                TEXT NOT NULL,
                     subscription_address TEXT NOT NULL DEFAULT '',
                     subscription_id      TEXT NOT NULL DEFAULT '',
                     site_key             TEXT NOT NULL,
                     site_name            TEXT NOT NULL DEFAULT '',
                     vod_id               TEXT NOT NULL,
                     line_name            TEXT NOT NULL DEFAULT '',
                     episode_name         TEXT NOT NULL DEFAULT '',
                     episode_number       INTEGER,
                     play_url             TEXT NOT NULL DEFAULT '',
                     pic                  TEXT NOT NULL DEFAULT '',
                     remarks              TEXT NOT NULL DEFAULT '',
                     douban_id            TEXT NOT NULL DEFAULT '',
                     position_ms          INTEGER NOT NULL DEFAULT 0,
                     duration_ms          INTEGER NOT NULL DEFAULT 0,
                     resolution           TEXT NOT NULL DEFAULT '',
                     rate                 REAL NOT NULL DEFAULT 0,
                     skip_json            TEXT NOT NULL DEFAULT '',
                     prefs_json           TEXT NOT NULL DEFAULT '{}',
                     favorite             INTEGER NOT NULL DEFAULT 0,
                     favorite_at          INTEGER,
                     created_at           INTEGER NOT NULL,
                     updated_at           INTEGER NOT NULL
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_address
                     ON subscriptions(address);
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_title
                     ON playback(title_key);
                 CREATE INDEX IF NOT EXISTS idx_pb_favorite
                     ON playback(favorite, favorite_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_pb_updated
                     ON playback(updated_at DESC);",
            )?;

            if version < SCHEMA_VERSION {
                // 2.0 破坏性升级：旧收藏/历史分表不兼容，直接丢弃；订阅地址仍保留在
                // configs 里。清掉 refresh_state 让订阅在下一个 60s tick 立即重新
                // 拉取 + 重新解析（用户要求「保留地址、重新加载订阅」）。
                conn.execute_batch(
                    "DROP TABLE IF EXISTS favorites;
                     DROP TABLE IF EXISTS history;
                     DELETE FROM meta WHERE key LIKE 'refresh_state:%';",
                )?;
                // 只在真正升级过时推进版本号。无条件写会把 user_version > 当前
                // 的库（未来版本 / 回滚后重开）降级，导致下次启动重跑破坏性迁移。
                conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
            }
            Ok(())
        })
    }
}
