import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { LedgerProjectCheckout } from "./types.js";
import type { GitBugClient, GitBugIssueDetail, GitBugIssueSummary } from "./git-bug-client.js";
import { hashGitBugPayload } from "./git-bug-hash.js";
import { isSha256Hex } from "./ids.js";
import { parseGitBugLabel } from "./git-bug-labels.js";
import { LedgerStore } from "./store.js";

export interface GitBugImportOptions {
  db: Db;
  client: GitBugClient;
  checkout: Pick<LedgerProjectCheckout, "id" | "project_id" | "root">;
  store?: LedgerStore;
}

export interface GitBugImportResult {
  imported: number;
  created: number;
  updated: number;
  comments: number;
  labels: number;
  relationships: number;
  conflicts: number;
  skipped: number;
}

interface ImportedIssue {
  detail: GitBugIssueDetail;
  issue_id: string;
}

export async function importGitBugCheckout(options: GitBugImportOptions): Promise<GitBugImportResult> {
  const store = options.store ?? new LedgerStore(options.db);
  const result: GitBugImportResult = {
    imported: 0,
    created: 0,
    updated: 0,
    comments: 0,
    labels: 0,
    relationships: 0,
    conflicts: 0,
    skipped: 0,
  };

  const hasRefs = await options.client.hasGitBugRefs(options.checkout.root);
  if (!hasRefs.ok || !hasRefs.value) {
    if (!hasRefs.ok) result.skipped++;
    return result;
  }

  const summaries = await options.client.listIssues(options.checkout.root);
  if (!summaries.ok) {
    throw new Error(`git-bug list failed: ${summaries.error}`);
  }

  const imported: ImportedIssue[] = [];
  for (const summary of summaries.value) {
    const detailResult = await options.client.getIssue(options.checkout.root, summary.human_id || summary.id);
    const detail = detailResult.ok ? detailResult.value : summaryToDetail(summary);
    const importedIssue = importIssueDetail(store, options.checkout.project_id, detail);
    result.imported++;
    if (importedIssue.created) result.created++;
    if (importedIssue.updated) result.updated++;
    result.comments += importedIssue.comments;
    result.labels += importedIssue.labels;
    imported.push({ detail, issue_id: importedIssue.issue_id });
  }

  for (const entry of imported) {
    const relationships = importRelationships(store, options.checkout.project_id, entry.issue_id, entry.detail);
    result.relationships += relationships.relationships;
    result.conflicts += relationships.conflicts;
  }

  return result;
}

function summaryToDetail(summary: GitBugIssueSummary): GitBugIssueDetail {
  return {
    ...summary,
    description: "",
    description_comment_id: "",
    comments: [],
    raw: summary,
  };
}

function importIssueDetail(
  store: LedgerStore,
  projectId: string,
  detail: GitBugIssueDetail,
): { issue_id: string; created: boolean; updated: boolean; comments: number; labels: number } {
  const externalId = detail.human_id || detail.id;
  const fullId = detail.id || externalId;
  const remoteHash = hashGitBugPayload(detail.raw ?? detail);
  const existingRef = store.findExternalRef({
    adapter: "git_bug",
    project_id: projectId,
    external_kind: "git_bug_issue",
    external_id: fullId,
  }) ?? store.findExternalRef({
    adapter: "git_bug",
    project_id: projectId,
    external_kind: "git_bug_issue",
    external_id: externalId,
  });

  let issueId = existingRef?.entity_id ?? null;
  if (!issueId) {
    const resolved = store.resolveIssueRef(externalId, { project_id: projectId });
    issueId = resolved.ok ? resolved.id : null;
  }

  let created = false;
  let updated = false;
  if (!issueId) {
    const issue = store.createIssue({
      id: isSha256Hex(fullId) ? fullId : undefined,
      project_id: projectId,
      title: detail.title,
      body: detail.description,
      status: detail.status,
      resolution: detail.status === "closed" && detail.labels.includes("merged") ? "merged" : null,
      source: "git_bug",
      actor_type: "external_adapter",
      author_display: detail.author_name,
      created_at: parseGitBugTime(detail.created_at) ?? Date.now(),
      aliases: [
        ...(externalId !== fullId ? [{ alias_kind: "git_bug_legacy", alias: externalId, external_id: externalId, source: "git_bug" }] : []),
      ],
    });
    issueId = issue.id;
    created = true;
  } else {
    const patch = store.applyImportedIssuePatch(issueId, {
      title: detail.title,
      body: detail.description,
      status: detail.status,
      resolution: detail.status === "closed" && detail.labels.includes("merged") ? "merged" : null,
      closed_at: detail.status === "closed" ? Date.now() : null,
      author_display: detail.author_name,
    }, "git_bug");
    updated = patch.changed;
  }

  store.recordExternalRef({
    entity_type: "issue",
    entity_id: issueId,
    adapter: "git_bug",
    project_id: projectId,
    external_kind: "git_bug_issue",
    external_id: fullId,
    remote_hash: remoteHash,
    last_imported_at: Date.now(),
    metadata: { full_id: fullId },
    source: "git_bug",
  });

  let labels = 0;
  for (const label of detail.labels) {
    const before = store.setLabel(issueId, label, true, "git_bug");
    if (before.changed) labels++;
  }

  let comments = 0;
  for (const comment of detail.comments) {
    const commentExternalId = comment.human_id || comment.id || fingerprintComment(externalId, comment);
    const commentHash = hashGitBugPayload(comment);
    const existingCommentRef = store.findExternalRef({
      adapter: "git_bug",
      project_id: projectId,
      external_kind: "git_bug_comment",
      external_id: commentExternalId,
    });
    if (existingCommentRef) {
      const patched = store.applyImportedCommentPatch(existingCommentRef.entity_id, {
        body: comment.body,
        author_display: comment.author_name,
      }, "git_bug", {
        actor_type: "external_adapter",
        author_display: comment.author_name,
      });
      store.recordExternalRef({
        entity_type: "comment",
        entity_id: existingCommentRef.entity_id,
        adapter: "git_bug",
        project_id: projectId,
        external_kind: "git_bug_comment",
        external_id: commentExternalId,
        remote_hash: commentHash,
        last_imported_at: Date.now(),
        source: "git_bug",
      });
      if (patched.changed) comments++;
      continue;
    }
    const ledgerComment = store.addComment(issueId, {
      id: isSha256Hex(comment.id) ? comment.id : undefined,
      body: comment.body,
      source: "git_bug",
      actor_type: "external_adapter",
      author_display: comment.author_name,
      created_at: parseGitBugTime(comment.created_at) ?? Date.now(),
    });
    store.recordExternalRef({
      entity_type: "comment",
      entity_id: ledgerComment.id,
      adapter: "git_bug",
      project_id: projectId,
      external_kind: "git_bug_comment",
      external_id: commentExternalId,
      remote_hash: commentHash,
      last_imported_at: Date.now(),
      source: "git_bug",
    });
    comments++;
  }

  return { issue_id: issueId, created, updated, comments, labels };
}

function importRelationships(
  store: LedgerStore,
  projectId: string,
  issueId: string,
  detail: GitBugIssueDetail,
): { relationships: number; conflicts: number } {
  let relationships = 0;
  let conflicts = 0;
  for (const label of detail.labels) {
    const parsed = parseGitBugLabel(label);
    if (!parsed) continue;

    if (parsed.kind === "issue_kind") {
      store.applyImportedIssuePatch(issueId, { kind: parsed.value }, "git_bug");
      continue;
    }
    if (parsed.kind === "priority") {
      store.applyImportedIssuePatch(issueId, { priority: parsed.value }, "git_bug");
      continue;
    }

    if (parsed.kind !== "legacy_parent" && parsed.kind !== "relationship") {
      continue;
    }
    const targetRef = parsed.target_ref;
    const target = store.resolveIssueRef(targetRef, { project_id: projectId });
    if (!target.ok) {
      store.recordConflict({
        adapter: "git_bug",
        project_id: projectId,
        entity_type: "issue",
        entity_id: issueId,
        field: "relationship_label",
        local_value: null,
        remote_value: { label, target_ref: targetRef },
        status: "open",
        source: "git_bug",
      });
      conflicts++;
      continue;
    }

    const relationshipType = parsed.kind === "legacy_parent" ? "parent_child" : parsed.relationship_type;
    const sourceIssueId =
      parsed.kind === "legacy_parent" || parsed.direction === "incoming" ? target.id : issueId;
    const targetIssueId =
      parsed.kind === "legacy_parent" || parsed.direction === "incoming" ? issueId : target.id;
    store.upsertIssueRelationship({
      source_issue_id: sourceIssueId,
      target_issue_id: targetIssueId,
      relationship_type: relationshipType,
      provenance: "imported",
      source: "git_bug",
      metadata: { label },
    });
    relationships++;
  }
  return { relationships, conflicts };
}

function parseGitBugTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fingerprintComment(issueExternalId: string, comment: { author_name: string; body: string; created_at: string }): string {
  return createHash("sha256")
    .update(`${issueExternalId}\0${comment.author_name}\0${comment.created_at}\0${comment.body}`)
    .digest("hex");
}
