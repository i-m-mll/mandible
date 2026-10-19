import type { Db } from "../db.js";
import type { LedgerIssueResolution, LedgerIssueStatus } from "./types.js";

const comments = (issueId: string) =>
  `COALESCE((SELECT group_concat(body, char(10) ORDER BY created_at) FROM ledger_comments WHERE issue_id = ${issueId} AND deleted_at IS NULL), '')`;
const refreshComments = (issueId: string) =>
  `UPDATE issue_search SET comments = ${comments(issueId)} WHERE rowid = (SELECT rowid FROM ledger_issues WHERE id = ${issueId});`;

/** One full-text document per issue, keyed by its rowid and kept current by triggers on the ledger write path. */
export const ISSUE_SEARCH_SCHEMA_SQL: readonly string[] = [
  "CREATE VIRTUAL TABLE IF NOT EXISTS issue_search USING fts5(title, body, comments, tokenize='unicode61 remove_diacritics 2')",
  "CREATE TRIGGER IF NOT EXISTS issue_search_issue_insert AFTER INSERT ON ledger_issues BEGIN INSERT INTO issue_search(rowid, title, body, comments) VALUES (NEW.rowid, NEW.title, NEW.body, ''); END",
  "CREATE TRIGGER IF NOT EXISTS issue_search_issue_update AFTER UPDATE OF title, body ON ledger_issues BEGIN UPDATE issue_search SET title = NEW.title, body = NEW.body WHERE rowid = NEW.rowid; END",
  "CREATE TRIGGER IF NOT EXISTS issue_search_issue_delete AFTER DELETE ON ledger_issues BEGIN DELETE FROM issue_search WHERE rowid = OLD.rowid; END",
  `CREATE TRIGGER IF NOT EXISTS issue_search_comment_insert AFTER INSERT ON ledger_comments BEGIN ${refreshComments("NEW.issue_id")} END`,
  `CREATE TRIGGER IF NOT EXISTS issue_search_comment_update AFTER UPDATE OF body, deleted_at ON ledger_comments BEGIN ${refreshComments("NEW.issue_id")} END`,
  `CREATE TRIGGER IF NOT EXISTS issue_search_comment_delete AFTER DELETE ON ledger_comments BEGIN ${refreshComments("OLD.issue_id")} END`,
  "DELETE FROM issue_search",
  `INSERT INTO issue_search(rowid, title, body, comments) SELECT rowid, title, body, ${comments("ledger_issues.id")} FROM ledger_issues`,
];

export interface IssueSearchHit {
  id: string;
  display_id: string;
  status: LedgerIssueStatus;
  resolution: LedgerIssueResolution | null;
  kind: string;
  project_id: string;
  project: string;
  title: string;
  excerpt: string;
  score: number;
}

/** Every word must occur as a word prefix somewhere in the issue's title, body, or comments. */
export function issueSearchExpression(text: string): string | null {
  const terms = text.split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .map((word) => `"${word.replaceAll('"', '""')}"*`);
  return terms.length > 0 ? terms.join(" ") : null;
}

/**
 * Issues whose title holds every word come first, then BM25 order, which FTS5
 * normalizes by whole-document length. Excerpts are cut only for the returned page.
 */
export function searchLedgerIssues(db: Db, input: {
  expression: string;
  projectIds: readonly string[];
  status: LedgerIssueStatus | "all";
  limit: number;
}): IssueSearchHit[] {
  return db.prepare(
    `WITH page AS (
       SELECT i.rowid AS doc, i.id, COALESCE(NULLIF(i.short_id, ''), substr(i.id, 1, 7)) AS display_id,
              i.status, i.resolution, i.kind, i.project_id,
              COALESCE(NULLIF(p.project_key, ''), p.display_name) AS project, i.title,
              i.rowid IN (SELECT rowid FROM issue_search WHERE issue_search MATCH 'title : (' || ?1 || ')') AS in_title,
              bm25(issue_search, 10.0, 2.0, 1.0) AS score
       FROM issue_search
       JOIN ledger_issues i ON i.rowid = issue_search.rowid
       JOIN ledger_projects p ON p.id = i.project_id
       WHERE issue_search MATCH ?1 AND i.deleted_at IS NULL
         AND (?2 = 'all' OR i.status = ?2)
         AND i.project_id IN (SELECT value FROM json_each(?3))
       ORDER BY in_title DESC, score, i.id LIMIT ?4
     )
     SELECT page.id, page.display_id, page.status, page.resolution, page.kind, page.project_id, page.project,
            page.title, snippet(issue_search, -1, '', '', '…', 16) AS excerpt, page.score
     FROM page JOIN issue_search ON issue_search.rowid = page.doc
     WHERE issue_search MATCH ?1
     ORDER BY page.in_title DESC, page.score, page.id`,
  ).all(input.expression, input.status, JSON.stringify(input.projectIds), input.limit) as IssueSearchHit[];
}
