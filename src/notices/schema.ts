/**
 * The notification log. A row exists from the moment a report is owed to its
 * recipient; `delivered_at NULL` is "not told yet". A session row gets its
 * `text` when it is rendered for delivery, and a settlement notice also its
 * `basis`, the `NoticeBasis` JSON of the report it told; a user row is raised
 * with its text, and `delivered_at` is when the user read it.
 *
 * A message row (`subject_kind = 'message'`) is its own subject, carries its
 * body exactly as sent from the moment it is sent (it is framed when it is
 * collected), and is addressed to the exact agent in `responsible_agent_ref`.
 * Only a message has a sender.
 */
const NOTIFICATIONS_TABLE_SQL = `CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('session','user')),
    recipient_provider TEXT,
    recipient_id TEXT NOT NULL,
    responsible_agent_ref TEXT,
    raised_at INTEGER NOT NULL,
    delivered_at INTEGER,
    text TEXT,
    review_submission_id TEXT REFERENCES briefing_submissions(id) ON DELETE RESTRICT,
    sender_agent_ref TEXT CHECK(sender_agent_ref IS NULL OR subject_kind = 'message'),
    basis TEXT CHECK(basis IS NULL OR subject_kind = 'auth_request'),
    CHECK((recipient_kind = 'session') = (recipient_provider IS NOT NULL)),
    CHECK((recipient_kind = 'session') = (responsible_agent_ref IS NOT NULL)),
    CHECK(recipient_kind = 'session' OR text IS NOT NULL),
    CHECK(delivered_at IS NULL OR text IS NOT NULL)
  )`;

const NOTIFICATIONS_INDEX_SQL: readonly string[] = [
  `CREATE INDEX idx_notifications_undelivered ON notifications(recipient_provider, recipient_id)
     WHERE delivered_at IS NULL AND recipient_kind = 'session'`,
  "CREATE INDEX idx_notifications_subject ON notifications(subject_kind, subject_id, raised_at)",
  "CREATE INDEX idx_notifications_raised ON notifications(raised_at)",
  `CREATE INDEX idx_notifications_undelivered_messages ON notifications(responsible_agent_ref)
     WHERE delivered_at IS NULL AND subject_kind = 'message'`,
];

export const NOTIFICATIONS_SCHEMA_SQL: readonly string[] = [NOTIFICATIONS_TABLE_SQL, ...NOTIFICATIONS_INDEX_SQL];

const NOTIFICATION_COLUMNS = `id, subject_kind, subject_id, recipient_kind, recipient_provider, recipient_id, responsible_agent_ref,
  raised_at, delivered_at, text, review_submission_id, sender_agent_ref`;

/** Issue 89135dc — `digest` gives way to `basis`; a delivered notice keeps a null basis. Run with foreign keys off. */
export const NOTIFICATIONS_BASIS_MIGRATION_SQL: readonly string[] = [
  "DROP INDEX idx_notifications_undelivered",
  "DROP INDEX idx_notifications_subject",
  "DROP INDEX idx_notifications_raised",
  "DROP INDEX idx_notifications_undelivered_messages",
  "ALTER TABLE notifications RENAME TO notifications_v260",
  NOTIFICATIONS_TABLE_SQL,
  `INSERT INTO notifications (${NOTIFICATION_COLUMNS}) SELECT ${NOTIFICATION_COLUMNS} FROM notifications_v260`,
  "DROP TABLE notifications_v260",
  ...NOTIFICATIONS_INDEX_SQL,
];

/** The table as migration v236 created it. */
export const NOTIFICATIONS_V236_SQL: readonly string[] = [
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
  NOTIFICATIONS_INDEX_SQL[0],
  NOTIFICATIONS_INDEX_SQL[1],
  NOTIFICATIONS_INDEX_SQL[2],
];

/** Migration v250's column. */
export const NOTICE_REVIEW_SUBMISSION_SQL =
  "ALTER TABLE notifications ADD COLUMN review_submission_id TEXT REFERENCES briefing_submissions(id) ON DELETE RESTRICT";

/** Migration v258's column and index. */
export const NOTICE_MESSAGE_SQL: readonly string[] = [
  "ALTER TABLE notifications ADD COLUMN sender_agent_ref TEXT CHECK(sender_agent_ref IS NULL OR subject_kind = 'message')",
  NOTIFICATIONS_INDEX_SQL[3],
];

/**
 * One row per wake attempt: a turn Mandible tried to start on an idle session
 * so that its hooks deliver what is owed. `outcome` is null while the attempt
 * runs; `cleared_at` is the first hook call from the session after a `woken`
 * attempt, which ends the attempt's hold on further wakes. No token is stored.
 */
export const SESSION_WAKES_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE session_wakes (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('claude','codex','antigravity')),
    session_id TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT CHECK(outcome IN ('woken','no_route','route_refused','provider_not_running','not_app_thread','entry_point_failed')),
    error TEXT,
    cleared_at INTEGER,
    CHECK((outcome IS NULL) = (finished_at IS NULL)),
    CHECK(error IS NULL OR outcome NOT IN ('woken','no_route')),
    CHECK(cleared_at IS NULL OR outcome = 'woken')
  )`,
  "CREATE INDEX idx_session_wakes_session ON session_wakes(provider, session_id, attempted_at)",
];

/**
 * Stored message text becomes the body: rows sent before framing moved to
 * collect carry the one-line prefix `Mandible: message <id> from <sender>: `,
 * which is a function of the row's own id and sender, so stripping it is exact.
 */
const LEGACY_MESSAGE_PREFIX = "('Mandible: message ' || substr(id, 1, 8) || ' from ' || coalesce(sender_agent_ref, 'a shell') || ': ')";
export const MESSAGE_BODY_MIGRATION_SQL: readonly string[] = [
  `UPDATE notifications SET text = substr(text, length(${LEGACY_MESSAGE_PREFIX}) + 1),
     digest = mandible_sha256(substr(text, length(${LEGACY_MESSAGE_PREFIX}) + 1))
   WHERE subject_kind = 'message' AND substr(text, 1, length(${LEGACY_MESSAGE_PREFIX})) = ${LEGACY_MESSAGE_PREFIX}`,
];
