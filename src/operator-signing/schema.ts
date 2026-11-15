import { BRIEFING_GROUP_SCHEMA_SQL } from "../feedback/schema.js";
import { ledgerOriginColumnSql } from "../ledger-origin-schema.js";

/**
 * Signing-key custody. An `ssh_key` credential states whether Mandible can
 * invoke it here (`enclave`: an approval key held in this Mac's Secure Enclave,
 * whose wrapped-key file lives at a path derived from its fingerprint) or only
 * holds its public material (`external`). The operator's active signing keys
 * are enclave approval keys only; `external` rows of the operator are revoked
 * history. Other credential types carry none.
 */
export const USER_CREDENTIALS_TABLE_SQL = `CREATE TABLE user_credentials (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        type            TEXT NOT NULL,
        fingerprint     TEXT NOT NULL,
        public_material TEXT,
        label           TEXT,
        status          TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','revoked')),
        created_at      INTEGER NOT NULL,
        revoked_at      INTEGER,
        metadata_json   TEXT NOT NULL DEFAULT '{}'
                          CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
        custody         TEXT CHECK(custody IN ('enclave','external')),
        CHECK((custody IS NOT NULL) = (type = 'ssh_key'))
      )`;

export const USER_CREDENTIALS_INDEX_SQL: readonly string[] = [
  "CREATE UNIQUE INDEX idx_user_credentials_active_fingerprint\n        ON user_credentials(fingerprint) WHERE status = 'active'",
  "CREATE INDEX idx_user_credentials_user\n        ON user_credentials(user_id)",
];

export const OPERATOR_TRUST_CHANGE_KINDS = [
  "approval_key_enrollment",
  "signer_add",
  "signer_revoke",
  "protected_branches",
] as const;

/** Every change to whom the gate trusts or what it covers, with its authorization. Insert-only. */
export const OPERATOR_TRUST_CHANGES_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE operator_trust_changes (
        id               TEXT PRIMARY KEY,
        operator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        kind             TEXT NOT NULL
                           CHECK(kind IN (${OPERATOR_TRUST_CHANGE_KINDS.map((kind) => `'${kind}'`).join(",")})),
        authorization    TEXT NOT NULL CHECK(authorization IN ('signed','bootstrap')),
        statement        TEXT NOT NULL,
        signatures_json  TEXT NOT NULL
                           CHECK(json_valid(signatures_json) AND json_type(signatures_json)='array'),
        created_at       INTEGER NOT NULL
      )`,
  "CREATE INDEX idx_operator_trust_changes_created ON operator_trust_changes(created_at DESC)",
  "CREATE TRIGGER operator_trust_changes_immutable_update BEFORE UPDATE ON operator_trust_changes BEGIN SELECT RAISE(ABORT, 'operator trust changes are immutable'); END",
  "CREATE TRIGGER operator_trust_changes_immutable_delete BEFORE DELETE ON operator_trust_changes BEGIN SELECT RAISE(ABORT, 'operator trust changes are immutable'); END",
];

/** Review dispositions become courtesy actions, so their evidence may be the local operator's interface session. */
function COURTESY_REVIEW_DISPOSITION_MIGRATION_SQL(): string[] {
  const table = "briefing_group_review_dispositions";
  const create = BRIEFING_GROUP_SCHEMA_SQL.find((sql) => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`))!;
  const own = BRIEFING_GROUP_SCHEMA_SQL.filter((sql) =>
    sql.startsWith(`CREATE TRIGGER IF NOT EXISTS ${table}_`) || sql.startsWith(`CREATE INDEX IF NOT EXISTS idx_${table}_`));
  const referencing = BRIEFING_GROUP_SCHEMA_SQL.filter((sql) =>
    sql.startsWith("CREATE TRIGGER") && !own.includes(sql) && new RegExp(`\\b${table}\\b`).test(sql));
  return [
    ...referencing.map((sql) => `DROP TRIGGER ${sql.split(/\s+/)[5]}`),
    create.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_next (`),
    `ALTER TABLE ${table}_next ADD COLUMN ${ledgerOriginColumnSql}`,
    `INSERT INTO ${table}_next SELECT * FROM ${table}`,
    `DROP TABLE ${table}`,
    `ALTER TABLE ${table}_next RENAME TO ${table}`,
    ...own,
    ...referencing,
  ];
}

/** The standard SQLite table rebuild: references from other tables keep naming `user_credentials`. */
export const OPERATOR_SIGNING_CUSTODY_MIGRATION_SQL: string[] = [
  USER_CREDENTIALS_TABLE_SQL.replace("CREATE TABLE user_credentials (", "CREATE TABLE user_credentials_next ("),
  `INSERT INTO user_credentials_next (id, user_id, type, fingerprint, public_material, label, status, created_at, revoked_at, metadata_json, custody)
     SELECT id, user_id, type, fingerprint, public_material, label, status, created_at, revoked_at, metadata_json,
       CASE WHEN type = 'ssh_key' THEN 'external' END
     FROM user_credentials`,
  "DROP TABLE user_credentials",
  "ALTER TABLE user_credentials_next RENAME TO user_credentials",
  ...USER_CREDENTIALS_INDEX_SQL,
  ...OPERATOR_TRUST_CHANGES_SCHEMA_SQL,
  ...COURTESY_REVIEW_DISPOSITION_MIGRATION_SQL(),
];

const NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const NAME_BEFORE_EMAIL = "trim(substr(display_name, 1, instr(display_name, '<') - 1))";

/**
 * Mandible approvals are Touch ID only. The operator's external signers (keys
 * held elsewhere, such as YubiKeys, and approval keys an enrollment replaced)
 * are revoked; shrinking the trust set needs no signature, and merges they
 * signed before now still verify. A display name of the form `Name <email>`,
 * which cannot author a Git commit, becomes `Name`.
 */
export const TOUCH_ID_ONLY_OPERATOR_MIGRATION_SQL: readonly string[] = [
  `UPDATE user_credentials SET status = 'revoked', revoked_at = ${NOW_MS}
     WHERE type = 'ssh_key' AND custody = 'external' AND status = 'active'
       AND user_id = (SELECT value FROM settings WHERE key = 'user.operator_id')`,
  `UPDATE users SET display_name = ${NAME_BEFORE_EMAIL}, updated_at = ${NOW_MS}
     WHERE display_name LIKE '%<%>' AND ${NAME_BEFORE_EMAIL} <> '' AND ${NAME_BEFORE_EMAIL} NOT GLOB '*[<>]*'`,
];
