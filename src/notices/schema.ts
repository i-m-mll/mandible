/**
 * The notification log. A row exists from the moment a report is owed to its
 * recipient; `delivered_at NULL` is "not told yet". A session row gets its
 * `digest` and `text` when it is rendered for delivery; a user row is raised
 * with its text, and `delivered_at` is when the user read it.
 */
export const NOTIFICATIONS_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('session','user')),
    recipient_provider TEXT,
    recipient_id TEXT NOT NULL,
    responsible_agent_ref TEXT,
    raised_at INTEGER NOT NULL,
    delivered_at INTEGER,
    digest TEXT,
    text TEXT,
    CHECK((recipient_kind = 'session') = (recipient_provider IS NOT NULL)),
    CHECK((recipient_kind = 'session') = (responsible_agent_ref IS NOT NULL)),
    CHECK(recipient_kind = 'session' OR text IS NOT NULL),
    CHECK(delivered_at IS NULL OR text IS NOT NULL),
    CHECK((digest IS NULL) = (recipient_kind = 'user' OR text IS NULL))
  )`,
  `CREATE INDEX idx_notifications_undelivered ON notifications(recipient_provider, recipient_id)
     WHERE delivered_at IS NULL AND recipient_kind = 'session'`,
  "CREATE INDEX idx_notifications_subject ON notifications(subject_kind, subject_id, raised_at)",
  "CREATE INDEX idx_notifications_raised ON notifications(raised_at)",
];
