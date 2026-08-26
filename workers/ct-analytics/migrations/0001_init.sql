-- Time-series aggregates by day and dimension.
-- dimension ∈ ('heartbeats','update_checks','version','os','country')
-- bucket = '' for scalar dimensions (heartbeats, update_checks); the version/os/country value otherwise.
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT NOT NULL,
  dimension TEXT NOT NULL,
  bucket TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, dimension, bucket)
);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_dim ON daily_stats(date, dimension);

-- One row per (date, installation_id) - DAU = COUNT(*) per date.
CREATE TABLE IF NOT EXISTS daily_dau (
  date TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  PRIMARY KEY (date, installation_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_dau_date ON daily_dau(date);

-- All-time scalar counters (e.g. total_installations).
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
