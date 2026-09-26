-- Soft delete for admin Inbox messages.
--
-- Deleted rows leave the list and stop counting toward total/unread, but the
-- message text is retained so a misclick is recoverable via the Undo toast.
ALTER TABLE feedback ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_feedback_deleted_at ON feedback(deleted_at);
