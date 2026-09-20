-- Atomic admission counters keyed by scope. `window` is a minute count since
-- the epoch: per-minute rows (global, ip:<ip>) store the current minute, and
-- per-day rows (err_day:<ip>) store the UTC day start in the same unit so the
-- cron sweep `window < now_minute - 1440` only removes past days.
CREATE TABLE IF NOT EXISTS ingest_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ingest_limits_window ON ingest_limits(window);
