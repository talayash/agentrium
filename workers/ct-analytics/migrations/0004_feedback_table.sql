CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  app_version TEXT    NOT NULL,
  os          TEXT    NOT NULL,
  country     TEXT    NOT NULL,
  ip_hash     TEXT    NOT NULL,
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts      ON feedback(ts);
CREATE INDEX IF NOT EXISTS idx_feedback_read_at ON feedback(read_at);
CREATE INDEX IF NOT EXISTS idx_feedback_ip_hash ON feedback(ip_hash);
