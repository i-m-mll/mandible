import type { Db } from "../db.js";
import type { GitBugClient, GitBugIssueDetail } from "./git-bug-client.js";
import { hashGitBugPayload } from "./git-bug-hash.js";
import { formatKindLabel, formatPriorityLabel } from "./git-bug-labels.js";
import { LedgerStore } from "./store.js";
import type { LedgerEvent, LedgerIssue, LedgerOutbox } from "./types.js";

export interface GitBugExportOptions {
  db: Db;
  client: GitBugClient;
  project_id: string;
  repoRoot: string;
  store?: LedgerStore;
  limit?: number;
}

export interface GitBugExportResult {
  applied: number;
  conflicted: number;
  failed: number;
  retryable: number;
  skipped: number;
}

export async function exportGitBugOutbox(options: GitBugExportOptions): Promise<GitBugExportResult> {
  const store = options.store ?? new LedgerStore(options.db);
  const result: GitBugExportResult = { applied: 0, conflicted: 0, failed: 0, retryable: 0, skipped: 0 };
  const outboxRows = store
    .listOutbox({ adapter: "git_bug", status: "pending" })
    .filter((row) => row.project_id === options.project_id)
    .slice(0, options.limit ?? 50);

  for (const outbox of outboxRows) {
    const outcome = await exportOutboxRow(store, options.client, options.repoRoot, outbox);
    result[outcome]++;
  }

  return result;
}

async function exportOutboxRow(
  store: LedgerStore,
  client: GitBugClient,
  repoRoot: string,
  outbox: LedgerOutbox,
): Promise<keyof GitBugExportResult> {
  const event = store.getEvent(outbox.event_id);
  try {
    const conflict = await detectRemoteConflict(store, client, repoRoot, outbox, event);
    if (conflict) {
      store.markOutbox(outbox.id, "conflicted", {
        attempt_count: outbox.attempt_count + 1,
        last_attempt_at: Date.now(),
        error: "Remote git-bug state changed since last cursor",
      });
      return "conflicted";
    }

    const outcome = await applyEvent(store, client, repoRoot, outbox, event);
    if (outcome === "applied") {
      store.markOutbox(outbox.id, "applied", {
        attempt_count: outbox.attempt_count + 1,
        last_attempt_at: Date.now(),
        error: null,
      });
      return "applied";
    }
    store.markOutbox(outbox.id, "skipped", {
      attempt_count: outbox.attempt_count + 1,
      last_attempt_at: Date.now(),
      error: outcome,
    });
    return "skipped";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.markOutbox(outbox.id, "failed", {
      attempt_count: outbox.attempt_count + 1,
      last_attempt_at: Date.now(),
      error: message,
    });
    return isRetryableError(message) ? "retryable" : "failed";
  }
}

async function detectRemoteConflict(
  store: LedgerStore,
  client: GitBugClient,
  repoRoot: string,
  outbox: LedgerOutbox,
  event: LedgerEvent,
): Promise<boolean> {
  if (event.entity_type !== "issue" && event.entity_type !== "comment") {
    return false;
  }
  const issueId = event.entity_type === "issue"
    ? event.entity_id
    : String(parsePayload(event).issue_id ?? "");
  if (!issueId) return false;
  const ref = store.findExternalRefForEntity({
    adapter: "git_bug",
    entity_type: "issue",
    entity_id: issueId,
    external_kind: "git_bug_issue",
  });
  if (!ref) return false;
  const remote = await client.getIssue(repoRoot, ref.external_id);
  if (!remote.ok) {
    if (remote.retry === "retryable") {
      throw new Error(remote.error);
    }
    return false;
  }
  const remoteHash = hashGitBugPayload(remote.value.raw ?? remote.value);
  if (!ref.remote_hash || ref.remote_hash === remoteHash) {
    return false;
  }
  createConflictForEvent(store, outbox.project_id, event, ref.remote_hash, remote.value, remoteHash);
  return true;
}

async function applyEvent(
  store: LedgerStore,
  client: GitBugClient,
  repoRoot: string,
  outbox: LedgerOutbox,
  event: LedgerEvent,
): Promise<"applied" | string> {
  const payload = parsePayload(event);
  if (event.event_type === "issue.created") {
    const issue = store.getIssue(event.entity_id);
    const existing = store.findExternalRefForEntity({
      adapter: "git_bug",
      entity_type: "issue",
      entity_id: issue.id,
      external_kind: "git_bug_issue",
    });
    if (existing) return "applied";
    const created = await client.createIssue(repoRoot, {
      title: issue.title,
      body: issue.body,
      labels: labelsForIssue(issue),
    });
    if (!created.ok) throw new Error(created.error);
    const externalId = created.value.id || await findCreatedIssueId(client, repoRoot, issue);
    if (!externalId) {
      throw new Error("git-bug create did not return a resolvable issue id");
    }
    const remote = externalId ? await client.getIssue(repoRoot, externalId) : null;
    store.recordExternalRef({
      entity_type: "issue",
      entity_id: issue.id,
      adapter: "git_bug",
      project_id: outbox.project_id,
      external_kind: "git_bug_issue",
      external_id: externalId,
      remote_hash: remote?.ok ? hashGitBugPayload(remote.value.raw ?? remote.value) : "",
      last_exported_at: Date.now(),
      source: "git_bug",
    });
    return "applied";
  }

  if (event.event_type === "comment.created") {
    const issueId = String(payload.issue_id ?? "");
    const commentId = String(payload.comment_id ?? event.entity_id);
    const issueRef = requireGitBugIssueRef(store, issueId);
    const comment = store.getComment(commentId);
    const added = await client.addComment(repoRoot, issueRef.external_id, comment.body);
    if (!added.ok) throw new Error(added.error);
    if (added.value.id) {
      store.recordExternalRef({
        entity_type: "comment",
        entity_id: comment.id,
        adapter: "git_bug",
        project_id: outbox.project_id,
        external_kind: "git_bug_comment",
        external_id: added.value.id,
        last_exported_at: Date.now(),
        source: "git_bug",
      });
    }
    await refreshIssueRemoteRef(store, client, repoRoot, outbox.project_id, issueId);
    return "applied";
  }

  if (event.event_type === "label.updated") {
    const issueId = String(payload.issue_id ?? event.entity_id);
    const label = String(payload.label ?? "");
    const present = payload.present === true;
    const issueRef = requireGitBugIssueRef(store, issueId);
    const updated = present
      ? await client.addLabel(repoRoot, issueRef.external_id, label)
      : await client.removeLabel(repoRoot, issueRef.external_id, label);
    if (!updated.ok) throw new Error(updated.error);
    await refreshIssueRemoteRef(store, client, repoRoot, outbox.project_id, issueId);
    return "applied";
  }

  if (event.event_type === "issue.updated") {
    const issueRef = requireGitBugIssueRef(store, event.entity_id);
    const issue = store.getIssue(event.entity_id);
    const patch = getPatchPayload(payload);
    if ("title" in patch) {
      const updated = await client.editTitle(repoRoot, issueRef.external_id, issue.title);
      if (!updated.ok) throw new Error(updated.error);
    }
    if ("body" in patch) {
      const remote = await client.getIssue(repoRoot, issueRef.external_id);
      if (!remote.ok) throw new Error(remote.error);
      if (!remote.value.description_comment_id) {
        throw new Error(`Issue ${event.entity_id} has no editable git-bug description comment`);
      }
      const updated = await client.editComment(repoRoot, remote.value.description_comment_id, issue.body);
      if (!updated.ok) throw new Error(updated.error);
    }
    if (payload.status === "open" || payload.status === "closed") {
      const updated = await client.setStatus(repoRoot, issueRef.external_id, payload.status);
      if (!updated.ok) throw new Error(updated.error);
    }
    if ("title" in patch || "body" in patch || payload.status === "open" || payload.status === "closed") {
      await refreshIssueRemoteRef(store, client, repoRoot, outbox.project_id, event.entity_id);
      return "applied";
    }
    return "git-bug exporter has no git-bug operation for this issue update";
  }

  if (event.event_type === "issue.closed" || event.event_type === "issue.reopened") {
    const issueRef = requireGitBugIssueRef(store, event.entity_id);
    const status = event.event_type === "issue.closed" ? "closed" : "open";
    const updated = await client.setStatus(repoRoot, issueRef.external_id, status);
    if (!updated.ok) throw new Error(updated.error);
    await refreshIssueRemoteRef(store, client, repoRoot, outbox.project_id, event.entity_id);
    return "applied";
  }

  return `unsupported event type: ${event.event_type}`;
}

function createConflictForEvent(
  store: LedgerStore,
  projectId: string,
  event: LedgerEvent,
  localHash: string,
  remote: GitBugIssueDetail,
  remoteHash: string,
): void {
  store.recordConflict({
    adapter: "git_bug",
    project_id: projectId,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    field: event.event_type,
    local_value: { event_id: event.id, previous_remote_hash: localHash },
    remote_value: { remote_hash: remoteHash, title: remote.title, status: remote.status },
    source: "git_bug",
  });
}

function requireGitBugIssueRef(store: LedgerStore, issueId: string) {
  const ref = store.findExternalRefForEntity({
    adapter: "git_bug",
    entity_type: "issue",
    entity_id: issueId,
    external_kind: "git_bug_issue",
  });
  if (!ref) {
    throw new Error(`Issue ${issueId} has no git-bug external ref`);
  }
  return ref;
}

async function refreshIssueRemoteRef(
  store: LedgerStore,
  client: GitBugClient,
  repoRoot: string,
  projectId: string,
  issueId: string,
): Promise<void> {
  const issueRef = requireGitBugIssueRef(store, issueId);
  const remote = await client.getIssue(repoRoot, issueRef.external_id);
  if (!remote.ok) {
    if (remote.retry === "retryable") {
      throw new Error(remote.error);
    }
    return;
  }
  store.recordExternalRef({
    entity_type: "issue",
    entity_id: issueId,
    adapter: "git_bug",
    project_id: projectId,
    external_kind: "git_bug_issue",
    external_id: issueRef.external_id,
    remote_hash: hashGitBugPayload(remote.value.raw ?? remote.value),
    last_exported_at: Date.now(),
    metadata: parseMetadata(issueRef.metadata_json),
    source: "git_bug",
  });
}

function labelsForIssue(issue: LedgerIssue): string[] {
  const labels = [];
  if (issue.kind !== "unknown") {
    labels.push(formatKindLabel(issue.kind));
  }
  if (issue.priority !== "unknown") {
    labels.push(formatPriorityLabel(issue.priority));
  }
  if (issue.status === "closed" && issue.resolution === "merged") {
    labels.push("merged");
  }
  return labels;
}

async function findCreatedIssueId(
  client: GitBugClient,
  repoRoot: string,
  issue: LedgerIssue,
): Promise<string> {
  const listed = await client.listIssues(repoRoot);
  if (!listed.ok) {
    if (listed.retry === "retryable") {
      throw new Error(listed.error);
    }
    return "";
  }
  const matches: string[] = [];
  for (const summary of listed.value) {
    if (summary.title !== issue.title) continue;
    const detail = await client.getIssue(repoRoot, summary.human_id || summary.id);
    if (!detail.ok) continue;
    if (detail.value.description === issue.body) {
      matches.push(detail.value.human_id || detail.value.id);
    }
  }
  return matches.length === 1 ? matches[0] : "";
}

function parsePayload(event: LedgerEvent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payload_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getPatchPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const patch = payload.patch;
  return patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch as Record<string, unknown>
    : {};
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isRetryableError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("lock") || lower.includes("timeout") || lower.includes("timed out");
}
