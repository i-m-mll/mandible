/**
 * Interface notes: `comment_id NULL` is unfiled; a filed note belongs to one comment; `app` is the interface it
 * was made on, and `origin` the embedding page's origin for a note made through the embed (null on Mandible's own).
 */
/**
 * The operator's decisions on other apps: one row per app of a project, `pending` until the operator allows it
 * in Mandible's own interface. `origin` and `directory` are where the latest page that asked was served from,
 * shown to the operator and never part of the decision.
 */
export const INTERFACE_NOTE_EMBED_GRANTS_SQL = `CREATE TABLE interface_note_embed_grants (
    project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE CASCADE,
    app TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'granted')),
    origin TEXT NOT NULL,
    directory TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY (project_id, app)
  )`;

export const INTERFACE_NOTES_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE interface_notes (
    id TEXT PRIMARY KEY,
    comment_id TEXT REFERENCES ledger_comments(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    target_json TEXT NOT NULL CHECK(json_valid(target_json) AND json_type(target_json) = 'object'),
    pin_json TEXT NOT NULL CHECK(json_valid(pin_json) AND json_type(pin_json) = 'object' AND json_extract(pin_json, '$.id') = id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
    , app TEXT NOT NULL DEFAULT 'mandible', origin TEXT)`,
  "CREATE INDEX idx_interface_notes_comment ON interface_notes(comment_id)",
  INTERFACE_NOTE_EMBED_GRANTS_SQL,
];
