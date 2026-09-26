-- Per-fingerprint resolution state for the admin Errors tab.
--
-- A row exists only while the group is marked resolved; un-resolving deletes
-- it. Whether a group is actually quiet is decided at read time by comparing
-- resolved_at against MAX(errors.ts), so a recurrence reopens the group with
-- no background job. resolved_version records which app version was newest
-- when the resolve happened and is display metadata only - it takes no part
-- in the reopen decision.
CREATE TABLE IF NOT EXISTS error_state (
  fingerprint      TEXT PRIMARY KEY,
  resolved_at      TEXT NOT NULL,
  resolved_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_error_state_resolved_at ON error_state(resolved_at);
