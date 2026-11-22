-- Distinct active installation counts by country, separate from heartbeat totals.
CREATE TABLE IF NOT EXISTS daily_country_dau (
  date TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  country TEXT NOT NULL,
  PRIMARY KEY (date, installation_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_country_dau_date ON daily_country_dau(date);
