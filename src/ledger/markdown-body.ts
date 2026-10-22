import type { Db } from "../db.js";
import { LedgerStore } from "./store.js";
import type { LedgerActorInput } from "./types.js";
import { resolveProjectIds } from "./project-registry.js";

export const MARKDOWN_BODY_ESCAPE_POLICY_SETTING = "ledger.markdown_body_escape_policy";
export const DEFAULT_MARKDOWN_BODY_ESCAPE_POLICY: MarkdownBodyEscapePolicy = "warn";

export type MarkdownBodyEscapePolicy = "allow" | "warn" | "reject";

export interface MarkdownBodyEscapeDetection {
  suspicious: boolean;
  reason: string;
  literal_newline_count: number;
  actual_newline_count: number;
}

export type MarkdownBodyAuditEntityType = "issue" | "comment";

export interface MarkdownBodyAuditScope {
  issue_refs?: string[];
  project_refs?: string[];
  repo_refs?: string[];
  comment_ids?: string[];
  include_comments?: boolean;
}

export interface MarkdownBodyAuditFinding {
  entity_type: MarkdownBodyAuditEntityType;
  entity_id: string;
  issue_id: string;
  issue_display_id: string;
  project_id: string;
  title: string;
  ordinal: number | null;
  detection: MarkdownBodyEscapeDetection;
  normalized_body: string;
  changed: boolean;
}

export interface MarkdownBodyAuditResult {
  dry_run: true;
  findings: MarkdownBodyAuditFinding[];
  counts: {
    issue_bodies: number;
    comments: number;
    changed: number;
  };
}

interface NormalizeMarkdownBodyBaseOptions {
  scope?: MarkdownBodyAuditScope;
  normalize_all_matches?: boolean;
}

export type NormalizeMarkdownBodyOptions = NormalizeMarkdownBodyBaseOptions & (
  | { apply?: false; actor?: never }
  | { apply: true; actor: LedgerActorInput }
);

export interface NormalizeMarkdownBodyResult extends MarkdownBodyAuditResult {
  applied: boolean;
  normalized: number;
  event_ids: string[];
}

export interface MarkdownBodyPolicyWarning {
  code: "literal_escaped_newlines";
  message: string;
  details: MarkdownBodyEscapeDetection;
}

export type MarkdownBodyPolicyResult =
  | { action: "allow"; warning?: undefined }
  | { action: "warn"; warning: MarkdownBodyPolicyWarning }
  | { action: "reject"; warning: MarkdownBodyPolicyWarning };

export function parseMarkdownBodyEscapePolicy(value: unknown): MarkdownBodyEscapePolicy {
  return value === "allow" || value === "warn" || value === "reject"
    ? value
    : DEFAULT_MARKDOWN_BODY_ESCAPE_POLICY;
}

export function getMarkdownBodyEscapePolicy(db: Db): MarkdownBodyEscapePolicy {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?")
    .get(MARKDOWN_BODY_ESCAPE_POLICY_SETTING) as { value: string } | undefined;
  return parseMarkdownBodyEscapePolicy(row?.value);
}

export function evaluateMarkdownBodyPolicy(
  body: string,
  policy: MarkdownBodyEscapePolicy,
): MarkdownBodyPolicyResult {
  if (policy === "allow") return { action: "allow" };

  const detection = detectAccidentalEscapedMarkdown(body);
  if (!detection.suspicious) return { action: "allow" };

  const warning: MarkdownBodyPolicyWarning = {
    code: "literal_escaped_newlines",
    message: "Body looks like Markdown submitted with literal \\\\n escapes. Submit Markdown text with real newline characters.",
    details: detection,
  };
  return policy === "reject" ? { action: "reject", warning } : { action: "warn", warning };
}

export function detectAccidentalEscapedMarkdown(body: string): MarkdownBodyEscapeDetection {
  const searchable = stripMarkdownCodeSpans(body);
  const literalNewlineCount = countMatches(searchable, /\\n/g);
  const actualNewlineCount = countMatches(searchable, /\r\n|\r|\n/g);

  if (literalNewlineCount < 2) {
    return detection(false, "fewer than two literal escaped newlines", literalNewlineCount, actualNewlineCount);
  }
  if (looksLikeStandaloneCode(body)) {
    return detection(false, "body looks like an intentional code or data snippet", literalNewlineCount, actualNewlineCount);
  }
  if (actualNewlineCount >= 2 && literalNewlineCount <= actualNewlineCount * 2) {
    return detection(false, "body already contains comparable real Markdown newlines", literalNewlineCount, actualNewlineCount);
  }

  return detection(
    true,
    "repeated literal escaped newlines with few real Markdown newlines",
    literalNewlineCount,
    actualNewlineCount,
  );
}

export function normalizeEscapedMarkdownBody(body: string): string {
  return replaceOutsideMarkdownCode(body, (segment) => (
    segment
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
  ));
}

export function auditEscapedMarkdownBodies(
  db: Db,
  scope: MarkdownBodyAuditScope = {},
): MarkdownBodyAuditResult {
  const findings: MarkdownBodyAuditFinding[] = [];
  const issueIds = resolveMarkdownBodyAuditIssueIds(db, scope);
  const includeComments = scope.include_comments ?? true;
  const commentIds = new Set(scope.comment_ids ?? []);

  for (const row of listIssueBodyRows(db, issueIds)) {
    addFinding(findings, {
      entity_type: "issue",
      entity_id: row.id,
      issue_id: row.id,
      issue_display_id: row.short_id || row.id,
      project_id: row.project_id,
      title: row.title,
      ordinal: null,
      body: row.body,
    });
  }

  if (includeComments || commentIds.size > 0) {
    for (const row of listCommentBodyRows(db, issueIds, commentIds)) {
      addFinding(findings, {
        entity_type: "comment",
        entity_id: row.id,
        issue_id: row.issue_id,
        issue_display_id: row.short_id || row.issue_id,
        project_id: row.project_id,
        title: row.title,
        ordinal: row.ordinal,
        body: row.body,
      });
    }
  }

  findings.sort(compareAuditFindings);
  return {
    dry_run: true,
    findings,
    counts: {
      issue_bodies: findings.filter((finding) => finding.entity_type === "issue").length,
      comments: findings.filter((finding) => finding.entity_type === "comment").length,
      changed: findings.filter((finding) => finding.changed).length,
    },
  };
}

export function normalizeEscapedMarkdownBodies(
  db: Db,
  options: NormalizeMarkdownBodyOptions = {},
): NormalizeMarkdownBodyResult {
  const scope = options.scope ?? {};
  const audit = auditEscapedMarkdownBodies(db, scope);
  if (!options.apply) {
    return { ...audit, applied: false, normalized: 0, event_ids: [] };
  }
  if (!options.normalize_all_matches && !hasExplicitNormalizationScope(scope)) {
    throw new Error("normalizeEscapedMarkdownBodies requires explicit targets or normalize_all_matches");
  }

  const store = new LedgerStore(db);
  const actor = options.actor;
  const eventIds: string[] = [];
  let normalized = 0;

  for (const finding of audit.findings) {
    if (!finding.changed) continue;
    const now = Date.now();
    const event = store.recordNormalizedBody({
      entity_type: finding.entity_type,
      entity_id: finding.entity_id,
      next_body: finding.normalized_body,
      payload: {
        issue_id: finding.issue_id,
        entity_type: finding.entity_type === "issue" ? "issue_body" : "comment_body",
        entity_id: finding.entity_id,
        literal_newline_count: finding.detection.literal_newline_count,
        actual_newline_count: finding.detection.actual_newline_count,
        reason: finding.detection.reason,
      },
      actor,
      occurred_at: now,
    });
    if (event) {
      eventIds.push(event.id);
      normalized += 1;
    }
  }

  return { ...audit, applied: true, normalized, event_ids: eventIds };
}

function stripMarkdownCodeSpans(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\r\n]*`/g, "");
}

function replaceOutsideMarkdownCode(body: string, replace: (segment: string) => string): string {
  const protectedPattern = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]*`/g;
  let result = "";
  let cursor = 0;
  for (const match of body.matchAll(protectedPattern)) {
    const index = match.index ?? 0;
    result += replace(body.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }
  result += replace(body.slice(cursor));
  return result;
}

function addFinding(
  findings: MarkdownBodyAuditFinding[],
  row: {
    entity_type: MarkdownBodyAuditEntityType;
    entity_id: string;
    issue_id: string;
    issue_display_id: string;
    project_id: string;
    title: string;
    ordinal: number | null;
    body: string;
  },
): void {
  const detection = detectAccidentalEscapedMarkdown(row.body);
  if (!detection.suspicious) return;
  const normalized = normalizeEscapedMarkdownBody(row.body);
  findings.push({
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    issue_id: row.issue_id,
    issue_display_id: row.issue_display_id,
    project_id: row.project_id,
    title: row.title,
    ordinal: row.ordinal,
    detection,
    normalized_body: normalized,
    changed: normalized !== row.body,
  });
}

function resolveMarkdownBodyAuditIssueIds(db: Db, scope: MarkdownBodyAuditScope): Set<string> | null {
  const issueIds = new Set<string>();
  const store = new LedgerStore(db);

  for (const ref of scope.issue_refs ?? []) {
    const resolved = store.resolveIssueRef(ref);
    if (!resolved.ok) {
      throw new Error(`Unable to resolve ledger issue ref '${ref}': ${resolved.error}`);
    }
    issueIds.add(resolved.id);
  }

  const projectIds = resolveProjectIds(db, [...(scope.project_refs ?? []), ...(scope.repo_refs ?? [])]);
  if (projectIds.size > 0) {
    const rows = db.prepare(
      `SELECT id FROM ledger_issues
       WHERE deleted_at IS NULL AND project_id IN (${placeholders(projectIds.size)})
       ORDER BY project_id, short_id, id`,
    ).all(...projectIds) as Array<{ id: string }>;
    for (const row of rows) issueIds.add(row.id);
  }

  return issueIds.size > 0 ? issueIds : null;
}

function listIssueBodyRows(db: Db, issueIds: Set<string> | null): Array<{
  id: string;
  short_id: string;
  project_id: string;
  title: string;
  body: string;
}> {
  if (issueIds && issueIds.size === 0) return [];
  const where = issueIds ? `AND id IN (${placeholders(issueIds.size)})` : "";
  return db.prepare(
    `SELECT id, short_id, project_id, title, body
     FROM ledger_issues
     WHERE deleted_at IS NULL ${where}
     ORDER BY project_id, short_id, id`,
  ).all(...(issueIds ? Array.from(issueIds) : [])) as Array<{
    id: string;
    short_id: string;
    project_id: string;
    title: string;
    body: string;
  }>;
}

function listCommentBodyRows(
  db: Db,
  issueIds: Set<string> | null,
  commentIds: Set<string>,
): Array<{
  id: string;
  issue_id: string;
  short_id: string;
  project_id: string;
  title: string;
  ordinal: number;
  body: string;
}> {
  const filters = ["c.deleted_at IS NULL", "i.deleted_at IS NULL"];
  const args: string[] = [];
  if (issueIds) {
    filters.push(`c.issue_id IN (${placeholders(issueIds.size)})`);
    args.push(...issueIds);
  }
  if (commentIds.size > 0) {
    filters.push(`c.id IN (${placeholders(commentIds.size)})`);
    args.push(...commentIds);
  }
  return db.prepare(
    `SELECT c.id, c.issue_id, i.short_id, i.project_id, i.title, c.ordinal, c.body
     FROM ledger_comments c
     JOIN ledger_issues i ON i.id = c.issue_id
     WHERE ${filters.join(" AND ")}
     ORDER BY i.project_id, i.short_id, c.ordinal, c.id`,
  ).all(...args) as Array<{
    id: string;
    issue_id: string;
    short_id: string;
    project_id: string;
    title: string;
    ordinal: number;
    body: string;
  }>;
}

function hasExplicitNormalizationScope(scope: MarkdownBodyAuditScope): boolean {
  return Boolean(
    scope.issue_refs?.length
      || scope.project_refs?.length
      || scope.repo_refs?.length
      || scope.comment_ids?.length,
  );
}

function compareAuditFindings(a: MarkdownBodyAuditFinding, b: MarkdownBodyAuditFinding): number {
  return (
    a.project_id.localeCompare(b.project_id)
    || a.issue_display_id.localeCompare(b.issue_display_id)
    || (a.ordinal ?? 0) - (b.ordinal ?? 0)
    || a.entity_type.localeCompare(b.entity_type)
    || a.entity_id.localeCompare(b.entity_id)
  );
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function looksLikeStandaloneCode(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (isJsonLike(trimmed)) return true;
  return /^(?:const|let|var|function|class|interface|type|import|export)\b/.test(trimmed)
    && /[;{}=]/.test(trimmed);
}

function isJsonLike(value: string): boolean {
  if (!((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]")))) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function detection(
  suspicious: boolean,
  reason: string,
  literal_newline_count: number,
  actual_newline_count: number,
): MarkdownBodyEscapeDetection {
  return { suspicious, reason, literal_newline_count, actual_newline_count };
}
