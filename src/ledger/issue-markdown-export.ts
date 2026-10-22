import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { buildLedgerIssueDetailProjection, type LedgerIssueDetailProjection } from "./issue-detail.js";
import { LedgerStore } from "./store.js";
import { resolveProjectIds } from "./project-registry.js";

export const ISSUE_MARKDOWN_EXPORT_CONFIG_SETTING = "ledger.issue_markdown_exports";

export interface IssueMarkdownExportScope {
  issue_refs?: string[];
  project_refs?: string[];
  repo_refs?: string[];
}

export interface IssueMarkdownExportConfig extends IssueMarkdownExportScope {
  out_dir: string;
  enabled?: boolean;
}

export interface IssueMarkdownExportOptions extends IssueMarkdownExportScope {
  out_dir?: string;
  all_configured?: boolean;
}

export interface IssueMarkdownExportFile {
  issue_id: string;
  display_id: string;
  project_id: string;
  path: string;
  content: string;
}

export interface IssueMarkdownExportResult {
  files: IssueMarkdownExportFile[];
  configured_exports: number;
}

export function listConfiguredIssueMarkdownExports(db: Db): IssueMarkdownExportConfig[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?")
    .get(ISSUE_MARKDOWN_EXPORT_CONFIG_SETTING) as { value: string } | undefined;
  if (!row?.value) return [];
  const parsed = JSON.parse(row.value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${ISSUE_MARKDOWN_EXPORT_CONFIG_SETTING} must be a JSON array`);
  }
  return parsed.map(parseExportConfig).filter((config) => config.enabled !== false);
}

export function exportIssueMarkdownFiles(
  db: Db,
  options: IssueMarkdownExportOptions,
): IssueMarkdownExportResult {
  const exports = options.all_configured
    ? listConfiguredIssueMarkdownExports(db)
    : [parseExportConfig(options)];
  const files: IssueMarkdownExportFile[] = [];

  for (const config of exports) {
    const issueIds = selectIssueMarkdownExportIssueIds(db, config);
    for (const issueId of issueIds) {
      const projection = buildLedgerIssueDetailProjection(db, issueId);
      const content = renderIssueMarkdown(projection);
      const filePath = path.join(
        config.out_dir,
        projectDirectoryName(projection),
        `${safeSlug(projection.display_id || projection.id.slice(0, 12))}.md`,
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
      files.push({
        issue_id: projection.id,
        display_id: projection.display_id,
        project_id: projection.project.id,
        path: filePath,
        content,
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, configured_exports: exports.length };
}

export function selectIssueMarkdownExportIssueIds(
  db: Db,
  scope: IssueMarkdownExportScope = {},
): string[] {
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
       ORDER BY project_id, short_id, title, id`,
    ).all(...Array.from(projectIds)) as Array<{ id: string }>;
    for (const row of rows) issueIds.add(row.id);
  }

  if (issueIds.size === 0 && !hasScope(scope)) {
    const rows = db.prepare(
      `SELECT id FROM ledger_issues
       WHERE deleted_at IS NULL
       ORDER BY project_id, short_id, title, id`,
    ).all() as Array<{ id: string }>;
    for (const row of rows) issueIds.add(row.id);
  }

  return Array.from(issueIds).sort((a, b) => {
    const left = issueSortKey(db, a);
    const right = issueSortKey(db, b);
    return left.localeCompare(right);
  });
}

export function renderIssueMarkdown(issue: LedgerIssueDetailProjection): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${quoteYaml(issue.id)}`);
  lines.push(`display_id: ${quoteYaml(issue.display_id)}`);
  lines.push(`project_id: ${quoteYaml(issue.project.id)}`);
  lines.push(`project: ${quoteYaml(issue.project.display_name)}`);
  lines.push(`status: ${quoteYaml(issue.status)}`);
  lines.push(`resolution: ${quoteYaml(issue.resolution)}`);
  lines.push(`kind: ${quoteYaml(issue.kind)}`);
  lines.push(`priority: ${quoteYaml(issue.priority)}`);
  lines.push(`source: ${quoteYaml(issue.source)}`);
  lines.push(`created_at: ${quoteYaml(formatTimestamp(issue.created_at))}`);
  lines.push(`updated_at: ${quoteYaml(formatTimestamp(issue.updated_at))}`);
  lines.push(`closed_at: ${quoteYaml(issue.closed_at === null ? null : formatTimestamp(issue.closed_at))}`);
  lines.push("labels:");
  for (const label of issue.labels.slice().sort()) lines.push(`  - ${quoteYaml(label)}`);
  if (issue.labels.length === 0) lines.push("  []");
  lines.push("aliases:");
  for (const alias of issue.aliases) {
    lines.push(`  - kind: ${quoteYaml(alias.kind)}`);
    lines.push(`    alias: ${quoteYaml(alias.alias)}`);
    lines.push(`    source: ${quoteYaml(alias.source)}`);
    lines.push(`    primary: ${alias.primary ? "true" : "false"}`);
  }
  if (issue.aliases.length === 0) lines.push("  []");
  lines.push("---");
  lines.push("");
  lines.push(`# ${issue.title}`);
  lines.push("");
  lines.push("## Body");
  lines.push("");
  lines.push(issue.body || "_No body._");
  lines.push("");
  lines.push("## Working Notes");
  lines.push("");
  lines.push(issue.work_notes || "_No working notes._");
  lines.push("");
  lines.push("## Comments");
  lines.push("");
  if (issue.comments.length === 0) {
    lines.push("_No comments._");
    lines.push("");
  } else {
    for (const comment of [...issue.comments].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))) {
      lines.push(`### Comment ${comment.ordinal}`);
      lines.push("");
      lines.push(`- id: ${comment.id}`);
      lines.push(`- author: ${comment.author.display}`);
      lines.push(`- source: ${comment.source}`);
      lines.push(`- created_at: ${formatTimestamp(comment.created_at)}`);
      lines.push(`- updated_at: ${comment.updated_at === null ? "null" : formatTimestamp(comment.updated_at)}`);
      lines.push("");
      lines.push(comment.body || "_No body._");
      lines.push("");
    }
  }
  lines.push("## Relationships");
  lines.push("");
  if (issue.relationships.length === 0) {
    lines.push("_No relationships._");
    lines.push("");
  } else {
    const relationships = [...issue.relationships].sort((a, b) => (
      a.direction.localeCompare(b.direction)
      || a.relationship_type.localeCompare(b.relationship_type)
      || (a.related_issue?.display_id ?? "").localeCompare(b.related_issue?.display_id ?? "")
      || a.id.localeCompare(b.id)
    ));
    for (const relationship of relationships) {
      const related = relationship.related_issue
        ? `${relationship.related_issue.display_id} - ${relationship.related_issue.title}`
        : relationship.id;
      lines.push(`- ${relationship.direction} ${relationship.relationship_type}: ${related}`);
    }
    lines.push("");
  }
  lines.push("## State Timeline");
  lines.push("");
  const states = issue.timeline.filter((entry) => entry.kind === "state");
  if (states.length === 0) {
    lines.push("_No state changes._");
  } else {
    for (const entry of states) {
      if (entry.kind !== "state") continue;
      lines.push(
        `- ${formatTimestamp(entry.created_at)} ${entry.event_type}`
          + ` status=${entry.status ?? "null"} resolution=${entry.resolution ?? "null"} source=${entry.source}`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n").replace(/[ \t]+$/gm, "")}\n`;
}

function parseExportConfig(value: unknown): IssueMarkdownExportConfig {
  if (!value || typeof value !== "object") {
    throw new Error("issue Markdown export config must be an object");
  }
  const record = value as Record<string, unknown>;
  const outDir = typeof record.out_dir === "string"
    ? record.out_dir
    : typeof record.outDir === "string"
      ? record.outDir
      : "";
  if (!outDir.trim()) {
    throw new Error("issue Markdown export config requires out_dir");
  }
  return {
    out_dir: outDir,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    issue_refs: stringArray(record.issue_refs ?? record.issues ?? record.issue),
    project_refs: stringArray(record.project_refs ?? record.projects ?? record.project),
    repo_refs: stringArray(record.repo_refs ?? record.repos ?? record.repo),
  };
}

function hasScope(scope: IssueMarkdownExportScope): boolean {
  return Boolean(scope.issue_refs?.length || scope.project_refs?.length || scope.repo_refs?.length);
}

function issueSortKey(db: Db, issueId: string): string {
  const row = db.prepare(
    `SELECT project_id, short_id, title, id
     FROM ledger_issues
     WHERE id = ?`,
  ).get(issueId) as { project_id: string; short_id: string; title: string; id: string };
  return `${row.project_id}\0${row.short_id}\0${row.title}\0${row.id}`;
}

function projectDirectoryName(issue: LedgerIssueDetailProjection): string {
  const base = safeSlug(issue.project.display_name || issue.project.id);
  return `${base}--${issue.project.id.slice(0, 8)}`;
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

function quoteYaml(value: string | null): string {
  if (value === null) return "null";
  return JSON.stringify(value);
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const result = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return result.length > 0 ? result : undefined;
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return undefined;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
