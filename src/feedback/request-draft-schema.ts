export const REQUEST_REVIEW_DRAFT_SCHEMA_SQL = [
  `CREATE TABLE request_review_drafts (
    request_id TEXT NOT NULL REFERENCES auth_requests(id),
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    path TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    text TEXT,
    conflict TEXT CHECK (conflict IN ('overlap', 'detached')),
    CHECK (conflict IS NULL OR text IS NOT NULL),
    PRIMARY KEY (request_id, actor_user_id, path)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE request_review_change_edits (
    request_id TEXT NOT NULL REFERENCES auth_requests(id),
    parent_sha TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    PRIMARY KEY (request_id, commit_sha)
  ) STRICT, WITHOUT ROWID`,
  `CREATE TABLE review_submission_change_edits (
    submission_id TEXT PRIMARY KEY REFERENCES briefing_submissions(id),
    request_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    FOREIGN KEY (request_id, commit_sha) REFERENCES request_review_change_edits(request_id, commit_sha)
  ) STRICT, WITHOUT ROWID`,
];
