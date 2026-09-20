CREATE TABLE IF NOT EXISTS ingest_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ingest_limits_window ON ingest_limits(window);
