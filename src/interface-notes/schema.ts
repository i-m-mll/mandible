/** Interface notes: `comment_id NULL` is unfiled; a filed note belongs to one comment. */
export const INTERFACE_NOTES_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE interface_notes (
    id TEXT PRIMARY KEY,
    comment_id TEXT REFERENCES ledger_comments(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    target_json TEXT NOT NULL CHECK(json_valid(target_json) AND json_type(target_json) = 'object'),
    pin_json TEXT NOT NULL CHECK(json_valid(pin_json) AND json_type(pin_json) = 'object' AND json_extract(pin_json, '$.id') = id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX idx_interface_notes_comment ON interface_notes(comment_id)",
];
