import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { broadcast } from "../sse.js";
import { emitLedgerEvents, type LedgerBroadcaster, type LedgerSsePayload } from "./events.js";
import {
  createCreationNonce,
  createLedgerId,
  createStableCommentId,
  createStableEventId,
  createStableIssueId,
} from "./ids.js";
import { parseIssueReferences, type ParsedIssueReference } from "./issue-xrefs.js";
import type {
  LedgerActorInput,
  LedgerActorType,
  LedgerBodyRevision,
  LedgerBodyRevisionEntityType,
  LedgerBodyRevisionReason,
  LedgerComment,
  LedgerConflict,
  LedgerConflictStatus,
  LedgerEvent,
  LedgerEventSource,
  LedgerExternalRef,
  LedgerIssue,
  LedgerIssueAlias,
  LedgerIssueBranch,
  LedgerIssueBranchRole,
  LedgerIssueCheckpoint,
  LedgerIssueDetail,
  LedgerIssueKind,
  LedgerIssueRelationship,
  LedgerIssueRelationshipSource,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerLabel,
  LedgerOutbox,
  LedgerOutboxStatus,
  LedgerPriority,
  LedgerRelationshipProvenance,
  LedgerRelationshipType,
  LedgerWorkerStatus,
} from "./types.js";

export type ResolveIssueRefResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "ambiguous"; count: number; matches: string[] };

export interface LedgerStoreOptions {
  outboxAdapters?: string[];
  broadcaster?: LedgerBroadcaster;
}

export interface LedgerAliasInput {
  alias_kind: string;
  alias: string;
  external_id?: string;
  source?: string;
  is_primary?: boolean;
}

export interface CreateLedgerIssueInput extends LedgerActorInput {
  id?: string;
  project_id: string;
  title: string;
  body?: string;
  status?: LedgerIssueStatus;
  resolution?: LedgerIssueResolution | null;
  kind?: LedgerIssueKind;
  priority?: LedgerPriority;
  source?: LedgerEventSource;
  created_at?: number;
  aliases?: LedgerAliasInput[];
  labels?: string[];
}

export interface UpdateLedgerIssuePatch {
  title?: string;
  body?: string;
  kind?: LedgerIssueKind;
  priority?: LedgerPriority;
  author_display?: string;
  status?: LedgerIssueStatus;
  resolution?: LedgerIssueResolution | null;
  closed_at?: number | null;
}

export interface UpdateLedgerIssueOptions extends LedgerActorInput {
  source?: LedgerEventSource;
  base_body_revision_id?: string;
  base_body_hash?: string;
}

export interface AddLedgerCommentInput extends LedgerActorInput {
  id?: string;
  body: string;
  source?: LedgerEventSource;
  created_at?: number;
}

export interface AddLedgerIssueCheckpointInput extends LedgerActorInput {
  id?: string;
  kind: string;
  payload: unknown;
  source?: LedgerEventSource;
  created_at?: number;
}

export interface UpdateLedgerCommentPatch {
  body?: string;
  author_display?: string;
}

export interface UpdateLedgerCommentOptions extends LedgerActorInput {
  source?: LedgerEventSource;
  base_body_revision_id?: string;
  base_body_hash?: string;
}

export interface UpsertRelationshipInput {
  id?: string;
  source_issue_id: string;
  target_issue_id: string;
  relationship_type: LedgerRelationshipType;
  provenance?: LedgerRelationshipProvenance;
  confidence?: string;
  metadata?: Record<string, unknown>;
  source?: LedgerEventSource;
  actor?: LedgerActorInput;
  created_at?: number;
}

export interface ReconcileTextIssueReferencesInput {
  source_issue_id: string;
  source_entity_type: "issue_body" | "comment";
  source_entity_id: string;
  body: string;
  source?: LedgerEventSource;
  actor?: LedgerActorInput;
}

export interface RecordExternalRefInput {
  id?: string;
  entity_type: string;
  entity_id: string;
  adapter: string;
  project_id?: string;
  external_id: string;
  external_kind: string;
  remote_version?: string;
  remote_hash?: string;
  last_imported_at?: number | null;
  last_exported_at?: number | null;
  metadata?: Record<string, unknown>;
  source?: LedgerEventSource;
}

export interface RecordConflictInput {
  id?: string;
  adapter: string;
  project_id?: string;
  entity_type: string;
  entity_id: string;
  field: string;
  local_value: unknown;
  remote_value: unknown;
  base_value?: unknown;
  status?: LedgerConflictStatus;
  resolution?: string | null;
  source?: LedgerEventSource;
}

export interface ResolveConflictInput extends LedgerActorInput {
  resolution: string;
  status?: "resolved" | "dismissed";
  source?: LedgerEventSource;
}

export interface MarkOutboxPatch {
  attempt_count?: number;
  last_attempt_at?: number | null;
  error?: string | null;
}

export interface RecordLedgerEventInput extends LedgerActorInput {
  entity_type: string;
  entity_id: string;
  event_type: string;
  source?: LedgerEventSource;
  payload?: Record<string, unknown>;
  project_id: string;
  occurred_at?: number;
  enqueueOutbox?: boolean;
}

export class LedgerStore {
  private readonly db: Db;
  private readonly outboxAdapters: string[];
  private readonly broadcaster: LedgerBroadcaster;

  constructor(db: Db, options: LedgerStoreOptions = {}) {
    this.db = db;
    this.db.pragma("foreign_keys = ON");
    this.outboxAdapters = options.outboxAdapters ?? [];
    this.broadcaster = options.broadcaster ?? broadcast;
  }

  createIssue(input: CreateLedgerIssueInput): LedgerIssue {
    const emitted: LedgerSsePayload[] = [];
    const now = input.created_at ?? Date.now();
    const source = input.source ?? "mandible";
    const actor = normalizeActor(input);
    const nonce = createCreationNonce();
    const id = input.id ?? createStableIssueId({
      project_id: input.project_id,
      title: input.title,
      body: input.body ?? "",
      source,
      created_at: now,
      author_actor_id: actor.actor_id,
      author_actor_type: actor.actor_type,
      author_display: input.author_display ?? "",
      nonce,
    });
    const shortId = this.allocateIssueShortId(input.project_id, id);

    const run = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO ledger_issues (
          id, short_id, project_id, title, body, status, resolution, kind, priority,
          author_actor_id, author_actor_type, author_display, source,
          created_at, updated_at, closed_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        shortId,
        input.project_id,
        input.title,
        input.body ?? "",
        input.status ?? "open",
        input.resolution ?? null,
        input.kind ?? "unknown",
        input.priority ?? "unknown",
        actor.actor_id,
        actor.actor_type,
        input.author_display ?? "",
        source,
        now,
        now,
        input.status === "closed" ? now : null,
      );

      this.insertAlias({
        issue_id: id,
        project_id: input.project_id,
        alias_kind: "canonical",
        alias: id,
        external_id: "",
        source,
        is_primary: 1,
        created_at: now,
      });
      for (const alias of input.aliases ?? []) {
        this.insertAlias({
          issue_id: id,
          project_id: input.project_id,
          alias_kind: alias.alias_kind,
          alias: alias.alias,
          external_id: alias.external_id ?? "",
          source: alias.source ?? source,
          is_primary: alias.is_primary ? 1 : 0,
          created_at: now,
        });
      }
      for (const label of input.labels ?? []) {
        this.db.prepare(
          `INSERT OR IGNORE INTO ledger_labels
           (issue_id, label, source, created_at, deleted_at)
           VALUES (?, ?, ?, ?, NULL)`,
        ).run(id, label, source, now);
      }

      const { event } = this.recordBodyRevisionEvent({
        entity_type: "issue_body",
        entity_id: id,
        issue_id: id,
        project_id: input.project_id,
        previous_body: null,
        next_body: input.body ?? "",
        actor,
        source,
        reason: "create",
        occurred_at: now,
        event_type: "issue.created",
        event_entity_type: "issue",
        event_entity_id: id,
        event_payload: {
          issue_id: id,
          short_id: shortId,
          project_id: input.project_id,
          title: input.title,
          creation_nonce: nonce,
        },
        changed_fields: ["body"],
      });
      emitted.push({ event, payload: { issue_id: id, project_id: input.project_id } });
      return this.getIssue(id);
    });

    const issue = run();
    this.reconcileTextIssueReferences({
      source_issue_id: issue.id,
      source_entity_type: "issue_body",
      source_entity_id: issue.id,
      body: issue.body,
      source,
      actor,
    });
    emitLedgerEvents(emitted, this.broadcaster);
    return issue;
  }

  updateIssue(id: string, patch: UpdateLedgerIssuePatch, actor: UpdateLedgerIssueOptions = {}): LedgerIssue {
    const existing = this.requireIssue(id);
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = normalizeActor(actor);
    const source = actor.source ?? "mandible";
    const next = {
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      kind: patch.kind ?? existing.kind,
      priority: patch.priority ?? existing.priority,
      author_display: patch.author_display ?? existing.author_display,
    };
    const changedFields = changedIssueFields(existing, next);
    if (changedFields.length === 0) {
      return existing;
    }
    const bodyChanged = changedFields.includes("body");
    if (bodyChanged) {
      this.assertBodyRevisionBase("issue_body", id, actor);
    }

    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_issues
         SET title = ?, kind = ?, priority = ?, author_display = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.title,
        next.kind,
        next.priority,
        next.author_display,
        now,
        id,
      );
      const scalarPatch = omitBodyPatch(patch);
      if (bodyChanged) {
        const { event } = this.recordBodyRevisionEvent({
          entity_type: "issue_body",
          entity_id: id,
          issue_id: id,
          project_id: existing.project_id,
          previous_body: existing.body,
          next_body: next.body,
          actor: normalizedActor,
          source,
          reason: "edit",
          occurred_at: now,
          event_type: "issue.updated",
          event_entity_type: "issue",
          event_entity_id: id,
          event_payload: { issue_id: id, patch: scalarPatch },
          changed_fields: changedFields,
          update_current_body: true,
        });
        emitted.push({ event, payload: { issue_id: id, changed_fields: changedFields } });
      } else {
        const event = this.insertEvent({
          entity_type: "issue",
          entity_id: id,
          event_type: "issue.updated",
          actor_id: normalizedActor.actor_id,
          actor_type: normalizedActor.actor_type,
          source,
          payload: { issue_id: id, patch: scalarPatch, changed_fields: changedFields },
          project_id: existing.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: id, patch: scalarPatch, changed_fields: changedFields } });
      }
      return this.getIssue(id);
    });

    const issue = run();
    if (bodyChanged) {
      this.reconcileTextIssueReferences({
        source_issue_id: issue.id,
        source_entity_type: "issue_body",
        source_entity_id: issue.id,
        body: issue.body,
        source,
        actor: normalizedActor,
      });
    }
    emitLedgerEvents(emitted, this.broadcaster);
    return issue;
  }

  applyImportedIssuePatch(
    id: string,
    patch: UpdateLedgerIssuePatch,
    source: LedgerEventSource = "git_bug",
    actor: LedgerActorInput = { actor_type: "external_adapter" },
  ): { changed: boolean; issue: LedgerIssue } {
    const existing = this.requireIssue(id);
    const now = Date.now();
    const normalizedActor = normalizeActor(actor);
    const next = {
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      kind: patch.kind ?? existing.kind,
      priority: patch.priority ?? existing.priority,
      author_display: patch.author_display ?? existing.author_display,
      status: patch.status ?? existing.status,
      resolution: patch.resolution === undefined ? existing.resolution : patch.resolution,
      closed_at: patch.closed_at === undefined ? existing.closed_at : patch.closed_at,
    };
    const changed =
      next.title !== existing.title ||
      next.body !== existing.body ||
      next.kind !== existing.kind ||
      next.priority !== existing.priority ||
      next.author_display !== existing.author_display ||
      next.status !== existing.status ||
      next.resolution !== existing.resolution ||
      next.closed_at !== existing.closed_at;
    if (!changed) {
      return { changed: false, issue: existing };
    }
    const changedFields = changedIssueFields(existing, next);
    const bodyChanged = changedFields.includes("body");

    const emitted: LedgerSsePayload[] = [];
    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_issues
         SET title = ?, kind = ?, priority = ?, author_display = ?,
             status = ?, resolution = ?, closed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.title,
        next.kind,
        next.priority,
        next.author_display,
        next.status,
        next.resolution,
        next.closed_at,
        now,
        id,
      );
      const eventType = issueLifecycleEventType(existing.status, next.status);
      const scalarPatch = omitBodyPatch(patch);
      const eventPayload = eventType
        ? {
          issue_id: id,
          previous_status: existing.status,
          status: next.status,
          resolution: next.resolution,
          patch: scalarPatch,
        }
        : { issue_id: id, patch: scalarPatch };
      if (bodyChanged) {
        const { event } = this.recordBodyRevisionEvent({
          entity_type: "issue_body",
          entity_id: id,
          issue_id: id,
          project_id: existing.project_id,
          previous_body: existing.body,
          next_body: next.body,
          actor: normalizedActor,
          source,
          reason: source === "git_bug" ? "external_update" : "edit",
          occurred_at: now,
          event_type: eventType ?? "issue.updated",
          event_entity_type: "issue",
          event_entity_id: id,
          event_payload: eventPayload,
          changed_fields: changedFields,
          update_current_body: true,
        });
        emitted.push({ event, payload: { issue_id: id, changed_fields: changedFields } });
      } else {
        const event = this.insertEvent({
          entity_type: "issue",
          entity_id: id,
          event_type: eventType ?? "issue.updated",
          actor_id: normalizedActor.actor_id,
          actor_type: normalizedActor.actor_type,
          source,
          payload: { ...eventPayload, changed_fields: changedFields },
          project_id: existing.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: id, patch: scalarPatch, changed_fields: changedFields } });
      }
      return this.getIssue(id);
    });

    const issue = run();
    if (bodyChanged) {
      this.reconcileTextIssueReferences({
        source_issue_id: issue.id,
        source_entity_type: "issue_body",
        source_entity_id: issue.id,
        body: issue.body,
        source,
        actor: normalizedActor,
      });
    }
    emitLedgerEvents(emitted, this.broadcaster);
    return { changed: true, issue };
  }

  setIssueStatus(
    id: string,
    status: LedgerIssueStatus,
    resolution: LedgerIssueResolution | null = null,
    actor: LedgerActorInput = {},
    source: LedgerEventSource = "mandible",
  ): LedgerIssue {
    const existing = this.requireIssue(id);
    if (existing.status === status && existing.resolution === resolution) {
      return existing;
    }
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = normalizeActor(actor);

    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_issues
         SET status = ?, resolution = ?, closed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, resolution, status === "closed" ? now : null, now, id);
      const eventType = status === "closed" ? "issue.closed" : "issue.reopened";
      const payload = { issue_id: id, previous_status: existing.status, status, resolution };
      const event = this.insertEvent({
        entity_type: "issue",
        entity_id: id,
        event_type: eventType,
        actor_id: normalizedActor.actor_id,
        actor_type: normalizedActor.actor_type,
        source,
        payload,
        project_id: existing.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload });
      return this.getIssue(id);
    });

    const issue = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return issue;
  }

  setWorkerStatus(
    id: string,
    workerStatus: LedgerWorkerStatus,
    actor: LedgerActorInput = {},
    source: LedgerEventSource = "mandible",
  ): LedgerIssue {
    const existing = this.requireIssue(id);
    if (existing.worker_status === workerStatus) {
      return existing;
    }
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = normalizeActor(actor);

    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_issues
         SET worker_status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(workerStatus, now, id);
      const payload = {
        issue_id: id,
        previous_worker_status: existing.worker_status,
        worker_status: workerStatus,
      };
      const event = this.insertEvent({
        entity_type: "issue",
        entity_id: id,
        event_type: "issue.worker_status.updated",
        actor_id: normalizedActor.actor_id,
        actor_type: normalizedActor.actor_type,
        source,
        payload,
        project_id: existing.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload });
      for (const status of ["none", "in_progress", "done", "blocked", "pivot-needed"] as const) {
        this.setLabel(id, `mandible:status:${status}`, status === workerStatus, source, actor);
      }
      return this.getIssue(id);
    });

    const issue = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return issue;
  }

  addIssueBranch(
    issueId: string,
    branch: string,
    role: LedgerIssueBranchRole = "primary",
    actor: LedgerActorInput = {},
    source: LedgerEventSource = "mandible",
  ): LedgerIssueBranch {
    const issue = this.requireIssue(issueId);
    const trimmedBranch = branch.trim();
    if (!trimmedBranch) {
      throw new Error("Issue branch cannot be empty");
    }
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = normalizeActor(actor);

    const run = this.db.transaction(() => {
      const existing = this.getIssueBranch(issueId, trimmedBranch);
      this.db.prepare(
        `INSERT INTO issue_branches (issue_id, branch, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(issue_id, branch) DO UPDATE SET
           role = excluded.role,
           updated_at = excluded.updated_at`,
      ).run(issueId, trimmedBranch, role, now, now);
      const payload = {
        issue_id: issueId,
        branch: trimmedBranch,
        role,
        previous_role: existing?.role ?? null,
      };
      const event = this.insertEvent({
        entity_type: "issue",
        entity_id: issueId,
        event_type: existing ? "issue.branch.updated" : "issue.branch.added",
        actor_id: normalizedActor.actor_id,
        actor_type: normalizedActor.actor_type,
        source,
        payload,
        project_id: issue.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload });
      this.setLabel(issueId, `mandible:branch:${trimmedBranch}`, true, source, actor);
      return this.getIssueBranch(issueId, trimmedBranch);
    });

    const row = run();
    if (!row) {
      throw new Error(`Failed to add branch ${trimmedBranch} for issue ${issueId}`);
    }
    emitLedgerEvents(emitted, this.broadcaster);
    return row;
  }

  recordEvent(input: RecordLedgerEventInput): LedgerEvent {
    const emitted: LedgerSsePayload[] = [];
    const now = input.occurred_at ?? Date.now();
    const actor = normalizeActor(input);
    const source = input.source ?? "system";

    const event = this.db.transaction(() => this.insertEvent({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      event_type: input.event_type,
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      source,
      payload: input.payload ?? {},
      project_id: input.project_id,
      occurred_at: now,
      enqueueOutbox: input.enqueueOutbox,
    }))();
    emitted.push({ event, payload: input.payload ?? { entity_id: input.entity_id } });
    emitLedgerEvents(emitted, this.broadcaster);
    return event;
  }

  addComment(issueId: string, input: AddLedgerCommentInput): LedgerComment {
    const issue = this.requireIssue(issueId);
    const emitted: LedgerSsePayload[] = [];
    const now = input.created_at ?? Date.now();
    const source = input.source ?? "mandible";
    const actor = normalizeActor(input);
    const ordinal = this.nextCommentOrdinal(issueId);
    const nonce = createCreationNonce();
    const id = input.id ?? createStableCommentId({
      issue_id: issueId,
      ordinal,
      body: input.body,
      source,
      created_at: now,
      author_actor_id: actor.actor_id,
      author_actor_type: actor.actor_type,
      author_display: input.author_display ?? "",
      nonce,
    });

    const run = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO ledger_comments (
          id, issue_id, ordinal, body, author_actor_id, author_actor_type,
          author_display, source, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        id,
        issueId,
        ordinal,
        input.body,
        actor.actor_id,
        actor.actor_type,
        input.author_display ?? "",
        source,
        now,
      );
      const { event } = this.recordBodyRevisionEvent({
        entity_type: "comment_body",
        entity_id: id,
        issue_id: issueId,
        project_id: issue.project_id,
        previous_body: null,
        next_body: input.body,
        actor,
        source,
        reason: "create",
        occurred_at: now,
        event_type: "comment.created",
        event_entity_type: "comment",
        event_entity_id: id,
        event_payload: { issue_id: issueId, comment_id: id, ordinal, creation_nonce: nonce },
        changed_fields: ["body"],
      });
      emitted.push({ event, payload: { issue_id: issueId, comment_id: id, ordinal } });
      return this.getComment(id);
    });

    const comment = run();
    this.reconcileTextIssueReferences({
      source_issue_id: issueId,
      source_entity_type: "comment",
      source_entity_id: comment.id,
      body: comment.body,
      source,
      actor,
    });
    emitLedgerEvents(emitted, this.broadcaster);
    return comment;
  }

  addIssueCheckpoint(issueId: string, input: AddLedgerIssueCheckpointInput): LedgerIssueCheckpoint {
    const issue = this.requireIssue(issueId);
    const kind = normalizeCheckpointKind(input.kind);
    const now = input.created_at ?? Date.now();
    const source = input.source ?? "mandible";
    const actor = normalizeActor(input);
    const id = input.id ?? createLedgerId("chk", { now });
    const payloadJson = jsonStringify(input.payload);
    const emitted: LedgerSsePayload[] = [];

    const run = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO ledger_issue_checkpoints (
          id, issue_id, kind, payload_json, author_actor_id, author_actor_type,
          author_display, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        issueId,
        kind,
        payloadJson,
        actor.actor_id,
        actor.actor_type,
        input.author_display ?? "",
        source,
        now,
      );
      const event = this.insertEvent({
        entity_type: "issue_checkpoint",
        entity_id: id,
        event_type: "issue.checkpoint.created",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        source,
        payload: { issue_id: issueId, checkpoint_id: id, kind, payload: input.payload },
        project_id: issue.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload: { issue_id: issueId, checkpoint_id: id, kind } });
      return this.getIssueCheckpoint(id);
    });

    const checkpoint = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return checkpoint;
  }

  applyImportedCommentPatch(
    id: string,
    patch: UpdateLedgerCommentPatch,
    source: LedgerEventSource = "import",
    actorInput: LedgerActorInput = { actor_type: "external_adapter" },
  ): { changed: boolean; comment: LedgerComment } {
    const existing = this.getComment(id);
    const issue = this.requireIssue(existing.issue_id);
    const actor = normalizeActor(actorInput);
    const next = {
      body: patch.body ?? existing.body,
      author_display: patch.author_display ?? existing.author_display,
    };

    if (next.body === existing.body && next.author_display === existing.author_display) {
      return { changed: false, comment: existing };
    }

    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const bodyChanged = next.body !== existing.body;
    const changedFields = changedCommentFields(existing, next);
    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_comments
         SET author_display = ?, updated_at = ?
         WHERE id = ?`,
      ).run(next.author_display, now, id);
      const scalarPatch = omitBodyPatch(patch);
      if (bodyChanged) {
        const { event } = this.recordBodyRevisionEvent({
          entity_type: "comment_body",
          entity_id: id,
          issue_id: existing.issue_id,
          project_id: issue.project_id,
          previous_body: existing.body,
          next_body: next.body,
          actor,
          source,
          reason: source === "git_bug" || source === "import" ? "external_update" : "edit",
          occurred_at: now,
          event_type: "comment.updated",
          event_entity_type: "comment",
          event_entity_id: id,
          event_payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch },
          changed_fields: changedFields,
          update_current_body: true,
        });
        emitted.push({ event, payload: { issue_id: existing.issue_id, comment_id: id, changed_fields: changedFields } });
      } else {
        const event = this.insertEvent({
          entity_type: "comment",
          entity_id: id,
          event_type: "comment.updated",
          actor_id: actor.actor_id,
          actor_type: actor.actor_type,
          source,
          payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields },
          project_id: issue.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields } });
      }
      return this.getComment(id);
    });

    const comment = run();
    if (bodyChanged) {
      this.reconcileTextIssueReferences({
        source_issue_id: existing.issue_id,
        source_entity_type: "comment",
        source_entity_id: id,
        body: comment.body,
        source,
        actor,
      });
    }
    emitLedgerEvents(emitted, this.broadcaster);
    return { changed: true, comment };
  }

  updateComment(id: string, patch: UpdateLedgerCommentPatch, actorInput: UpdateLedgerCommentOptions = {}): LedgerComment {
    const existing = this.getComment(id);
    const issue = this.requireIssue(existing.issue_id);
    const actor = normalizeActor(actorInput);
    const source = actorInput.source ?? "mandible";
    const next = {
      body: patch.body ?? existing.body,
      author_display: patch.author_display ?? existing.author_display,
    };
    const changedFields = changedCommentFields(existing, next);
    if (changedFields.length === 0) {
      return existing;
    }
    const bodyChanged = changedFields.includes("body");
    if (bodyChanged) {
      this.assertBodyRevisionBase("comment_body", id, actorInput);
    }

    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_comments
         SET author_display = ?, updated_at = ?
         WHERE id = ?`,
      ).run(next.author_display, now, id);
      const scalarPatch = omitBodyPatch(patch);
      if (bodyChanged) {
        const { event } = this.recordBodyRevisionEvent({
          entity_type: "comment_body",
          entity_id: id,
          issue_id: existing.issue_id,
          project_id: issue.project_id,
          previous_body: existing.body,
          next_body: next.body,
          actor,
          source,
          reason: "edit",
          occurred_at: now,
          event_type: "comment.updated",
          event_entity_type: "comment",
          event_entity_id: id,
          event_payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch },
          changed_fields: changedFields,
          update_current_body: true,
        });
        emitted.push({ event, payload: { issue_id: existing.issue_id, comment_id: id, changed_fields: changedFields } });
      } else {
        const event = this.insertEvent({
          entity_type: "comment",
          entity_id: id,
          event_type: "comment.updated",
          actor_id: actor.actor_id,
          actor_type: actor.actor_type,
          source,
          payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields },
          project_id: issue.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields } });
      }
      return this.getComment(id);
    });

    const comment = run();
    if (bodyChanged) {
      this.reconcileTextIssueReferences({
        source_issue_id: existing.issue_id,
        source_entity_type: "comment",
        source_entity_id: id,
        body: comment.body,
        source,
        actor,
      });
    }
    emitLedgerEvents(emitted, this.broadcaster);
    return comment;
  }

  recordNormalizedBody(input: {
    entity_type: "issue" | "comment";
    entity_id: string;
    next_body: string;
    payload: Record<string, unknown>;
    actor?: LedgerActorInput;
    occurred_at?: number;
  }): LedgerEvent | null {
    const actor = normalizeActor(input.actor ?? { actor_type: "system" });
    const now = input.occurred_at ?? Date.now();
    const emitted: LedgerSsePayload[] = [];
    const target = input.entity_type === "issue"
      ? {
        bodyRevisionEntityType: "issue_body" as const,
        issue: this.requireIssue(input.entity_id),
        comment: null as LedgerComment | null,
      }
      : (() => {
        const comment = this.getComment(input.entity_id);
        return {
          bodyRevisionEntityType: "comment_body" as const,
          issue: this.requireIssue(comment.issue_id),
          comment,
        };
      })();
    const previousBody = target.comment?.body ?? target.issue.body;
    if (previousBody === input.next_body) {
      return null;
    }

    const run = this.db.transaction(() => {
      const { event } = this.recordBodyRevisionEvent({
        entity_type: target.bodyRevisionEntityType,
        entity_id: input.entity_id,
        issue_id: target.issue.id,
        project_id: target.issue.project_id,
        previous_body: previousBody,
        next_body: input.next_body,
        actor,
        source: "system",
        reason: "normalize",
        occurred_at: now,
        event_type: "markdown_body.normalized",
        event_entity_type: input.entity_type,
        event_entity_id: input.entity_id,
        event_payload: input.payload,
        changed_fields: ["body"],
        update_current_body: true,
      });
      emitted.push({ event, payload: input.payload });
      return event;
    });

    const event = run();
    this.reconcileTextIssueReferences({
      source_issue_id: target.issue.id,
      source_entity_type: target.bodyRevisionEntityType === "issue_body" ? "issue_body" : "comment",
      source_entity_id: input.entity_id,
      body: input.next_body,
      source: "system",
      actor,
    });
    emitLedgerEvents(emitted, this.broadcaster);
    return event;
  }

  setLabel(
    issueId: string,
    label: string,
    present: boolean,
    source: LedgerEventSource = "mandible",
    actor: LedgerActorInput = {},
  ): { changed: boolean; label: LedgerLabel | null } {
    const issue = this.requireIssue(issueId);
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = normalizeActor(actor);
    const trimmed = label.trim();
    if (!trimmed) {
      throw new Error("Ledger label cannot be empty");
    }

    const run = this.db.transaction(() => {
      const row = this.getLabel(issueId, trimmed);
      let changed = false;

      if (present) {
        if (!row) {
          this.db.prepare(
            `INSERT INTO ledger_labels
             (issue_id, label, source, created_at, deleted_at)
             VALUES (?, ?, ?, ?, NULL)`,
          ).run(issueId, trimmed, source, now);
          changed = true;
        } else if (row.deleted_at !== null) {
          this.db.prepare(
            `UPDATE ledger_labels
             SET source = ?, deleted_at = NULL, created_at = ?
             WHERE issue_id = ? AND label = ?`,
          ).run(source, now, issueId, trimmed);
          changed = true;
        }
      } else if (row && row.deleted_at === null) {
        this.db.prepare(
          "UPDATE ledger_labels SET deleted_at = ? WHERE issue_id = ? AND label = ?",
        ).run(now, issueId, trimmed);
        changed = true;
      }

      if (changed) {
        const event = this.insertEvent({
          entity_type: "issue",
          entity_id: issueId,
          event_type: "label.updated",
          actor_id: normalizedActor.actor_id,
          actor_type: normalizedActor.actor_type,
          source,
          payload: { issue_id: issueId, label: trimmed, present },
          project_id: issue.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: issueId, label: trimmed, present } });
      }

      return { changed, label: this.getLabel(issueId, trimmed) };
    });

    const result = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return result;
  }

  upsertIssueRelationship(input: UpsertRelationshipInput): LedgerIssueRelationship {
    const sourceIssue = this.requireIssue(input.source_issue_id);
    this.requireIssue(input.target_issue_id);
    const emitted: LedgerSsePayload[] = [];
    const now = input.created_at ?? Date.now();
    const id = input.id ?? createLedgerId("rel", { now });
    const source = input.source ?? "mandible";
    const actor = normalizeActor(input.actor ?? {});

    const run = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM ledger_issue_relationships
         WHERE source_issue_id = ? AND target_issue_id = ? AND relationship_type = ?`,
      ).get(
        input.source_issue_id,
        input.target_issue_id,
        input.relationship_type,
      ) as LedgerIssueRelationship | undefined;
      const metadataJson =
        input.metadata === undefined && existing
          ? existing.metadata_json
          : jsonStringify(input.metadata ?? {});

      if (!existing) {
        this.db.prepare(
          `INSERT INTO ledger_issue_relationships (
            id, source_issue_id, target_issue_id, relationship_type, provenance,
            confidence, metadata_json, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          id,
          input.source_issue_id,
          input.target_issue_id,
          input.relationship_type,
          input.provenance ?? "manual",
          input.confidence ?? "observed",
          metadataJson,
          now,
          now,
        );
      } else {
        this.db.prepare(
          `UPDATE ledger_issue_relationships
           SET provenance = ?, confidence = ?, metadata_json = ?,
               updated_at = ?, deleted_at = NULL
           WHERE id = ?`,
        ).run(
          input.provenance ?? existing.provenance,
          input.confidence ?? existing.confidence,
          metadataJson,
          now,
          existing.id,
        );
      }

      const relationship = this.db.prepare(
        `SELECT * FROM ledger_issue_relationships
         WHERE source_issue_id = ? AND target_issue_id = ? AND relationship_type = ?`,
      ).get(
        input.source_issue_id,
        input.target_issue_id,
        input.relationship_type,
      ) as LedgerIssueRelationship;

      const event = this.insertEvent({
        entity_type: "issue_relationship",
        entity_id: relationship.id,
        event_type: "relationship.upserted",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        source,
        payload: {
          relationship_id: relationship.id,
          source_issue_id: input.source_issue_id,
          target_issue_id: input.target_issue_id,
          relationship_type: input.relationship_type,
        },
        project_id: sourceIssue.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload: { relationship_id: relationship.id } });
      return relationship;
    });

    const relationship = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return relationship;
  }

  reconcileTextIssueReferences(input: ReconcileTextIssueReferencesInput): void {
    const sourceIssue = this.requireIssue(input.source_issue_id);
    const source = input.source ?? "mandible";
    const actor = normalizeActor(input.actor ?? {});
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();

    const run = this.db.transaction(() => {
      const desired = new Map<string, {
        relationship: LedgerIssueRelationship;
        ref: ParsedIssueReference;
      }>();
      for (const ref of parseIssueReferences(input.body)) {
        const targetProjectId = this.resolveProjectId(ref.project, sourceIssue.project_id);
        if (!targetProjectId) continue;
        const resolved = this.resolveIssueRef(ref.issueRef, { project_id: targetProjectId });
        if (!resolved.ok || resolved.id === input.source_issue_id) continue;
        const relationship = this.ensureDerivedReferenceRelationship(
          input.source_issue_id,
          resolved.id,
          source,
          actor,
          now,
          emitted,
        );
        const key = relationshipSourceKey(resolved.id, ref.kind, ref.normalized);
        desired.set(key, { relationship, ref });
      }

      for (const item of desired.values()) {
        this.upsertRelationshipSource({
          relationship: item.relationship,
          input,
          ref: item.ref,
          source,
          actor,
          now,
        });
      }

      const existingSources = this.db.prepare(
        `SELECT * FROM ledger_issue_relationship_sources
         WHERE source_entity_type = ? AND source_entity_id = ?
           AND relationship_type = 'references' AND deleted_at IS NULL`,
      ).all(input.source_entity_type, input.source_entity_id) as LedgerIssueRelationshipSource[];
      const touchedRelationshipIds = new Set<string>();
      for (const existing of existingSources) {
        const key = relationshipSourceKey(existing.target_issue_id, existing.ref_kind, existing.normalized_ref);
        if (desired.has(key)) continue;
        this.db.prepare(
          `UPDATE ledger_issue_relationship_sources
           SET deleted_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(now, now, existing.id);
        touchedRelationshipIds.add(existing.relationship_id);
      }
      for (const item of desired.values()) {
        touchedRelationshipIds.add(item.relationship.id);
      }
      for (const relationshipId of touchedRelationshipIds) {
        this.pruneDerivedRelationshipIfUnreferenced(relationshipId, source, actor, now, emitted);
      }
    });

    run();
    emitLedgerEvents(emitted, this.broadcaster);
  }

  recordExternalRef(input: RecordExternalRefInput): LedgerExternalRef {
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const source = input.source ?? "import";
    const id = input.id ?? createLedgerId("xref", { now });
    const metadataJson = jsonStringify(input.metadata ?? {});
    const projectId = input.project_id ?? "";

    const run = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM ledger_external_refs
         WHERE adapter = ? AND project_id = ? AND external_kind = ? AND external_id = ?`,
      ).get(
        input.adapter,
        projectId,
        input.external_kind,
        input.external_id,
      ) as LedgerExternalRef | undefined;

      if (existing) {
        this.db.prepare(
          `UPDATE ledger_external_refs
           SET entity_type = ?, entity_id = ?, remote_version = ?, remote_hash = ?,
               last_imported_at = ?, last_exported_at = ?, metadata_json = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          input.entity_type,
          input.entity_id,
          input.remote_version ?? existing.remote_version,
          input.remote_hash ?? existing.remote_hash,
          input.last_imported_at ?? existing.last_imported_at,
          input.last_exported_at ?? existing.last_exported_at,
          metadataJson,
          now,
          existing.id,
        );
      } else {
        this.db.prepare(
          `INSERT INTO ledger_external_refs (
            id, entity_type, entity_id, adapter, project_id, external_id,
            external_kind, remote_version, remote_hash, last_imported_at,
            last_exported_at, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.entity_type,
          input.entity_id,
          input.adapter,
          projectId,
          input.external_id,
          input.external_kind,
          input.remote_version ?? "",
          input.remote_hash ?? "",
          input.last_imported_at ?? null,
          input.last_exported_at ?? null,
          metadataJson,
          now,
          now,
        );
      }

      const ref = this.db.prepare(
        `SELECT * FROM ledger_external_refs
         WHERE adapter = ? AND project_id = ? AND external_kind = ? AND external_id = ?`,
      ).get(
        input.adapter,
        projectId,
        input.external_kind,
        input.external_id,
      ) as LedgerExternalRef;
      const event = this.insertEvent({
        entity_type: "external_ref",
        entity_id: ref.id,
        event_type: "external_ref.recorded",
        actor_id: null,
        actor_type: "system",
        source,
        payload: { external_ref_id: ref.id, entity_type: input.entity_type, entity_id: input.entity_id },
        project_id: projectId,
        occurred_at: now,
        enqueueOutbox: false,
      });
      emitted.push({ event, payload: { external_ref_id: ref.id } });
      return ref;
    });

    const ref = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return ref;
  }

  recordConflict(input: RecordConflictInput): LedgerConflict {
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const source = input.source ?? "import";
    const id = input.id ?? createLedgerId("cnf", { now });
    const projectId = input.project_id ?? "";
    const localValueJson = jsonStringify(input.local_value);
    const remoteValueJson = jsonStringify(input.remote_value);
    const baseValueJson = jsonStringify(input.base_value ?? null);
    const status = input.status ?? "open";

    const run = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM ledger_conflicts
         WHERE adapter = ? AND project_id = ? AND entity_type = ? AND entity_id = ?
           AND field = ? AND status = ? AND local_value_json = ?
           AND remote_value_json = ? AND base_value_json = ?
         LIMIT 1`,
      ).get(
        input.adapter,
        projectId,
        input.entity_type,
        input.entity_id,
        input.field,
        status,
        localValueJson,
        remoteValueJson,
        baseValueJson,
      ) as LedgerConflict | undefined;
      if (existing) {
        return existing;
      }

      this.db.prepare(
        `INSERT INTO ledger_conflicts (
          id, adapter, project_id, entity_type, entity_id, field,
          local_value_json, remote_value_json, base_value_json, status,
          resolution, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        input.adapter,
        projectId,
        input.entity_type,
        input.entity_id,
        input.field,
        localValueJson,
        remoteValueJson,
        baseValueJson,
        status,
        input.resolution ?? null,
        now,
      );
      const event = this.insertEvent({
        entity_type: "conflict",
        entity_id: id,
        event_type: "conflict.created",
        actor_id: null,
        actor_type: "system",
        source,
        payload: { conflict_id: id, entity_type: input.entity_type, entity_id: input.entity_id },
        project_id: projectId,
        occurred_at: now,
        enqueueOutbox: false,
      });
      emitted.push({ event, payload: { conflict_id: id } });
      return this.getConflict(id);
    });

    const conflict = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return conflict;
  }

  resolveConflict(id: string, input: ResolveConflictInput): LedgerConflict {
    const existing = this.getConflict(id);
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const status = input.status ?? "resolved";
    const source = input.source ?? "mandible";
    const actor = normalizeActor(input);

    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_conflicts
         SET status = ?, resolution = ?, resolved_at = ?
         WHERE id = ?`,
      ).run(status, input.resolution, now, id);
      const event = this.insertEvent({
        entity_type: "conflict",
        entity_id: id,
        event_type: "conflict.resolved",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        source,
        payload: { conflict_id: id, status, resolution: input.resolution },
        project_id: existing.project_id,
        occurred_at: now,
        enqueueOutbox: false,
      });
      emitted.push({ event, payload: { conflict_id: id, status, resolution: input.resolution } });
      return this.getConflict(id);
    });

    const conflict = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return conflict;
  }

  markOutbox(id: string, status: LedgerOutboxStatus, patch: MarkOutboxPatch = {}): LedgerOutbox {
    const existing = this.requireOutbox(id);
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();

    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_outbox
         SET status = ?, attempt_count = ?, last_attempt_at = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        status,
        patch.attempt_count ?? existing.attempt_count,
        "last_attempt_at" in patch ? patch.last_attempt_at ?? null : existing.last_attempt_at,
        "error" in patch ? patch.error ?? null : existing.error,
        now,
        id,
      );
      const event = this.insertEvent({
        entity_type: "outbox",
        entity_id: id,
        event_type: "outbox.updated",
        actor_id: null,
        actor_type: "system",
        source: "system",
        payload: { outbox_id: id, status },
        project_id: existing.project_id,
        occurred_at: now,
        enqueueOutbox: false,
      });
      emitted.push({ event, payload: { outbox_id: id, status } });
      return this.requireOutbox(id);
    });

    const outbox = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return outbox;
  }

  resolveIssueRef(ref: string, options: { project_id?: string } = {}): ResolveIssueRefResult {
    const trimmed = ref.trim();
    if (!trimmed) {
      return { ok: false, error: "not_found" };
    }

    const matches = new Set<string>();
    const addRows = (rows: Array<{ id?: string; issue_id?: string }>) => {
      for (const row of rows) {
        const id = row.id ?? row.issue_id;
        if (id) matches.add(id);
      }
    };

    if (options.project_id) {
      addRows(this.db.prepare(
        "SELECT id FROM ledger_issues WHERE id = ? AND project_id = ?",
      ).all(trimmed, options.project_id) as Array<{ id: string }>);
      addRows(this.db.prepare(
        "SELECT id FROM ledger_issues WHERE short_id = ? AND project_id = ?",
      ).all(trimmed, options.project_id) as Array<{ id: string }>);
      addRows(this.db.prepare(
        `SELECT issue_id FROM ledger_issue_aliases
         WHERE alias = ? AND project_id = ?`,
      ).all(trimmed, options.project_id) as Array<{ issue_id: string }>);
    } else {
      addRows(this.db.prepare("SELECT id FROM ledger_issues WHERE id = ?").all(trimmed) as Array<{ id: string }>);
      addRows(this.db.prepare("SELECT id FROM ledger_issues WHERE short_id = ?").all(trimmed) as Array<{ id: string }>);
      addRows(this.db.prepare("SELECT issue_id FROM ledger_issue_aliases WHERE alias = ?").all(trimmed) as Array<{ issue_id: string }>);
    }

    if (matches.size === 1) {
      return { ok: true, id: Array.from(matches)[0] };
    }
    if (matches.size > 1) {
      return { ok: false, error: "ambiguous", count: matches.size, matches: Array.from(matches).sort() };
    }

    if (trimmed.length >= 4) {
      const escaped = escapeLike(trimmed);
      if (options.project_id) {
        addRows(this.db.prepare(
          `SELECT id FROM ledger_issues
           WHERE id LIKE ? ESCAPE '\\' AND project_id = ?`,
        ).all(`${escaped}%`, options.project_id) as Array<{ id: string }>);
        addRows(this.db.prepare(
          `SELECT id FROM ledger_issues
           WHERE short_id LIKE ? ESCAPE '\\' AND project_id = ?`,
        ).all(`${escaped}%`, options.project_id) as Array<{ id: string }>);
        addRows(this.db.prepare(
          `SELECT issue_id FROM ledger_issue_aliases
           WHERE alias LIKE ? ESCAPE '\\' AND project_id = ?`,
        ).all(`${escaped}%`, options.project_id) as Array<{ issue_id: string }>);
      } else {
        addRows(this.db.prepare(
          "SELECT id FROM ledger_issues WHERE id LIKE ? ESCAPE '\\'",
        ).all(`${escaped}%`) as Array<{ id: string }>);
        addRows(this.db.prepare(
          "SELECT id FROM ledger_issues WHERE short_id LIKE ? ESCAPE '\\'",
        ).all(`${escaped}%`) as Array<{ id: string }>);
        addRows(this.db.prepare(
          "SELECT issue_id FROM ledger_issue_aliases WHERE alias LIKE ? ESCAPE '\\'",
        ).all(`${escaped}%`) as Array<{ issue_id: string }>);
      }
    }

    if (matches.size === 0) {
      return { ok: false, error: "not_found" };
    }
    if (matches.size > 1) {
      return { ok: false, error: "ambiguous", count: matches.size, matches: Array.from(matches).sort() };
    }
    return { ok: true, id: Array.from(matches)[0] };
  }

  getIssue(id: string): LedgerIssue {
    const row = this.db.prepare("SELECT * FROM ledger_issues WHERE id = ?").get(id) as LedgerIssue | undefined;
    if (!row) {
      throw new Error(`Ledger issue not found: ${id}`);
    }
    return row;
  }

  getIssueDetail(id: string): LedgerIssueDetail {
    const issue = this.getIssue(id);
    return {
      ...issue,
      aliases: this.listAliases(id),
      comments: this.db.prepare(
        "SELECT * FROM ledger_comments WHERE issue_id = ? ORDER BY created_at",
      ).all(id) as LedgerComment[],
      checkpoints: this.listIssueCheckpoints(id),
      labels: this.db.prepare(
        "SELECT * FROM ledger_labels WHERE issue_id = ? ORDER BY label",
      ).all(id) as LedgerLabel[],
      branches: this.listIssueBranches(id),
      outgoing_relationships: this.db.prepare(
        "SELECT * FROM ledger_issue_relationships WHERE source_issue_id = ? ORDER BY created_at",
      ).all(id) as LedgerIssueRelationship[],
      incoming_relationships: this.db.prepare(
        "SELECT * FROM ledger_issue_relationships WHERE target_issue_id = ? ORDER BY created_at",
      ).all(id) as LedgerIssueRelationship[],
    };
  }

  listIssues(filters: { project_id?: string; status?: LedgerIssueStatus } = {}): LedgerIssue[] {
    if (filters.project_id && filters.status) {
      return this.db.prepare(
        `SELECT * FROM ledger_issues
         WHERE project_id = ? AND status = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
      ).all(filters.project_id, filters.status) as LedgerIssue[];
    }
    if (filters.project_id) {
      return this.db.prepare(
        `SELECT * FROM ledger_issues
         WHERE project_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
      ).all(filters.project_id) as LedgerIssue[];
    }
    if (filters.status) {
      return this.db.prepare(
        `SELECT * FROM ledger_issues
         WHERE status = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
      ).all(filters.status) as LedgerIssue[];
    }
    return this.db.prepare(
      "SELECT * FROM ledger_issues WHERE deleted_at IS NULL ORDER BY updated_at DESC",
    ).all() as LedgerIssue[];
  }

  listAliases(issueId: string): LedgerIssueAlias[] {
    return this.db.prepare(
      "SELECT * FROM ledger_issue_aliases WHERE issue_id = ? ORDER BY is_primary DESC, alias_kind, alias",
    ).all(issueId) as LedgerIssueAlias[];
  }

  listIssueBranches(issueId: string): LedgerIssueBranch[] {
    return this.db.prepare(
      "SELECT * FROM issue_branches WHERE issue_id = ? ORDER BY role, created_at, branch",
    ).all(issueId) as LedgerIssueBranch[];
  }

  listIssueCheckpoints(issueId: string, kind?: string): LedgerIssueCheckpoint[] {
    if (kind) {
      return this.db.prepare(
        `SELECT * FROM ledger_issue_checkpoints
         WHERE issue_id = ? AND kind = ?
         ORDER BY created_at DESC, id DESC`,
      ).all(issueId, normalizeCheckpointKind(kind)) as LedgerIssueCheckpoint[];
    }
    return this.db.prepare(
      `SELECT * FROM ledger_issue_checkpoints
       WHERE issue_id = ?
       ORDER BY created_at DESC, id DESC`,
    ).all(issueId) as LedgerIssueCheckpoint[];
  }

  getLatestIssueCheckpoint(issueId: string, kind?: string): LedgerIssueCheckpoint | null {
    return this.listIssueCheckpoints(issueId, kind)[0] ?? null;
  }

  listEvents(entity: { entity_type: string; entity_id: string }): LedgerEvent[] {
    return this.db.prepare(
      `SELECT * FROM ledger_events
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY occurred_at, observed_at`,
    ).all(entity.entity_type, entity.entity_id) as LedgerEvent[];
  }

  listBodyRevisions(entity: {
    entity_type: LedgerBodyRevisionEntityType;
    entity_id: string;
  }): LedgerBodyRevision[] {
    return this.db.prepare(
      `SELECT * FROM ledger_body_revisions
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY revision_no`,
    ).all(entity.entity_type, entity.entity_id) as LedgerBodyRevision[];
  }

  getBodyRevision(id: string): LedgerBodyRevision {
    const row = this.db.prepare(
      "SELECT * FROM ledger_body_revisions WHERE id = ?",
    ).get(id) as LedgerBodyRevision | undefined;
    if (!row) {
      throw new Error(`Ledger body revision not found: ${id}`);
    }
    return row;
  }

  getEvent(id: string): LedgerEvent {
    const row = this.db.prepare("SELECT * FROM ledger_events WHERE id = ?").get(id) as LedgerEvent | undefined;
    if (!row) {
      throw new Error(`Ledger event not found: ${id}`);
    }
    return row;
  }

  getComment(id: string): LedgerComment {
    const row = this.db.prepare("SELECT * FROM ledger_comments WHERE id = ?").get(id) as LedgerComment | undefined;
    if (!row) {
      throw new Error(`Ledger comment not found: ${id}`);
    }
    return row;
  }

  getIssueCheckpoint(id: string): LedgerIssueCheckpoint {
    const row = this.db.prepare(
      "SELECT * FROM ledger_issue_checkpoints WHERE id = ?",
    ).get(id) as LedgerIssueCheckpoint | undefined;
    if (!row) {
      throw new Error(`Ledger issue checkpoint not found: ${id}`);
    }
    return row;
  }

  listOutbox(filters: { adapter?: string; status?: LedgerOutboxStatus } = {}): LedgerOutbox[] {
    if (filters.adapter && filters.status) {
      return this.db.prepare(
        `SELECT * FROM ledger_outbox
         WHERE adapter = ? AND status = ?
         ORDER BY available_at, created_at`,
      ).all(filters.adapter, filters.status) as LedgerOutbox[];
    }
    if (filters.status) {
      return this.db.prepare(
        "SELECT * FROM ledger_outbox WHERE status = ? ORDER BY available_at, created_at",
      ).all(filters.status) as LedgerOutbox[];
    }
    return this.db.prepare("SELECT * FROM ledger_outbox ORDER BY available_at, created_at").all() as LedgerOutbox[];
  }

  listConflicts(filters: { status?: LedgerConflictStatus; adapter?: string } = {}): LedgerConflict[] {
    if (filters.status && filters.adapter) {
      return this.db.prepare(
        `SELECT * FROM ledger_conflicts
         WHERE status = ? AND adapter = ?
         ORDER BY created_at DESC`,
      ).all(filters.status, filters.adapter) as LedgerConflict[];
    }
    if (filters.status) {
      return this.db.prepare(
        "SELECT * FROM ledger_conflicts WHERE status = ? ORDER BY created_at DESC",
      ).all(filters.status) as LedgerConflict[];
    }
    return this.db.prepare("SELECT * FROM ledger_conflicts ORDER BY created_at DESC").all() as LedgerConflict[];
  }

  findExternalRef(input: {
    adapter: string;
    project_id?: string;
    external_kind: string;
    external_id: string;
  }): LedgerExternalRef | null {
    return (this.db.prepare(
      `SELECT * FROM ledger_external_refs
       WHERE adapter = ? AND project_id = ? AND external_kind = ? AND external_id = ?`,
    ).get(
      input.adapter,
      input.project_id ?? "",
      input.external_kind,
      input.external_id,
    ) as LedgerExternalRef | undefined) ?? null;
  }

  findExternalRefForEntity(input: {
    adapter: string;
    entity_type: string;
    entity_id: string;
    external_kind?: string;
  }): LedgerExternalRef | null {
    if (input.external_kind) {
      return (this.db.prepare(
        `SELECT * FROM ledger_external_refs
         WHERE adapter = ? AND entity_type = ? AND entity_id = ? AND external_kind = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(
        input.adapter,
        input.entity_type,
        input.entity_id,
        input.external_kind,
      ) as LedgerExternalRef | undefined) ?? null;
    }
    return (this.db.prepare(
      `SELECT * FROM ledger_external_refs
       WHERE adapter = ? AND entity_type = ? AND entity_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(input.adapter, input.entity_type, input.entity_id) as LedgerExternalRef | undefined) ?? null;
  }

  private requireIssue(id: string): LedgerIssue {
    return this.getIssue(id);
  }

  private latestBodyRevision(
    entityType: LedgerBodyRevisionEntityType,
    entityId: string,
  ): LedgerBodyRevision | null {
    return (this.db.prepare(
      `SELECT * FROM ledger_body_revisions
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY revision_no DESC
       LIMIT 1`,
    ).get(entityType, entityId) as LedgerBodyRevision | undefined) ?? null;
  }

  private assertBodyRevisionBase(
    entityType: LedgerBodyRevisionEntityType,
    entityId: string,
    input: { base_body_revision_id?: string; base_body_hash?: string },
  ): void {
    if (!input.base_body_revision_id && !input.base_body_hash) return;
    const latest = this.latestBodyRevision(entityType, entityId);
    if (input.base_body_revision_id && latest?.id !== input.base_body_revision_id) {
      const error = new Error("stale body revision");
      error.name = "LedgerBodyRevisionConflictError";
      throw error;
    }
    if (input.base_body_hash && latest?.new_hash !== input.base_body_hash) {
      const error = new Error("stale body hash");
      error.name = "LedgerBodyRevisionConflictError";
      throw error;
    }
  }

  private recordBodyRevisionEvent(input: {
    entity_type: LedgerBodyRevisionEntityType;
    entity_id: string;
    issue_id: string;
    project_id: string;
    previous_body: string | null;
    next_body: string;
    actor: { actor_id: string | null; actor_type: LedgerActorType };
    source: LedgerEventSource;
    reason: LedgerBodyRevisionReason;
    occurred_at: number;
    event_type: string;
    event_entity_type: string;
    event_entity_id: string;
    event_payload: Record<string, unknown>;
    changed_fields: string[];
    update_current_body?: boolean;
    metadata?: Record<string, unknown>;
  }): { revision: LedgerBodyRevision; event: LedgerEvent } {
    if (input.previous_body !== null && input.previous_body === input.next_body) {
      throw new Error("recordBodyRevisionEvent called for unchanged body");
    }
    const latest = this.latestBodyRevision(input.entity_type, input.entity_id);
    const revisionId = createLedgerId("rev", { now: input.occurred_at });
    const revisionNo = (latest?.revision_no ?? 0) + 1;
    const newHash = hashBody(input.next_body);
    const baseHash = latest?.new_hash ?? (input.previous_body === null ? null : hashBody(input.previous_body));
    const payload = {
      ...input.event_payload,
      changed_fields: uniqueStrings(input.changed_fields),
      body_revision_id: revisionId,
    };
    const event = this.insertEvent({
      entity_type: input.event_entity_type,
      entity_id: input.event_entity_id,
      event_type: input.event_type,
      actor_id: input.actor.actor_id,
      actor_type: input.actor.actor_type,
      source: input.source,
      payload,
      project_id: input.project_id,
      occurred_at: input.occurred_at,
    });
    if (input.update_current_body) {
      if (input.entity_type === "issue_body") {
        this.db.prepare(
          "UPDATE ledger_issues SET body = ?, updated_at = ? WHERE id = ?",
        ).run(input.next_body, input.occurred_at, input.entity_id);
      } else {
        this.db.prepare(
          "UPDATE ledger_comments SET body = ?, updated_at = ? WHERE id = ?",
        ).run(input.next_body, input.occurred_at, input.entity_id);
      }
    }
    this.db.prepare(
      `INSERT INTO ledger_body_revisions (
        id, entity_type, entity_id, issue_id, project_id, revision_no, event_id,
        actor_id, actor_type, source, reason, occurred_at, observed_at,
        base_revision_id, base_hash, new_hash, snapshot_body, patch_format,
        patch_text, metadata_json, redacted_at, redacted_by_actor_id, redaction_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL)`,
    ).run(
      revisionId,
      input.entity_type,
      input.entity_id,
      input.issue_id,
      input.project_id,
      revisionNo,
      event.id,
      input.actor.actor_id,
      input.actor.actor_type,
      input.source,
      input.reason,
      input.occurred_at,
      event.observed_at,
      latest?.id ?? null,
      baseHash,
      newHash,
      input.next_body,
      jsonStringify(input.metadata ?? {}),
    );
    return { revision: this.getBodyRevision(revisionId), event };
  }

  private allocateIssueShortId(projectId: string, id: string): string {
    for (let length = Math.min(7, id.length); length <= id.length; length++) {
      const prefix = id.slice(0, length);
      const row = this.db.prepare(
        `SELECT id FROM ledger_issues
         WHERE project_id = ? AND id != ? AND id LIKE ? ESCAPE '\\'
         LIMIT 1`,
      ).get(projectId, id, `${escapeLike(prefix)}%`) as { id: string } | undefined;
      const short = this.db.prepare(
        `SELECT id FROM ledger_issues
         WHERE project_id = ? AND id != ? AND short_id = ?
         LIMIT 1`,
      ).get(projectId, id, prefix) as { id: string } | undefined;
      if (!row && !short) return prefix;
    }
    return id;
  }

  private nextCommentOrdinal(issueId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM ledger_comments WHERE issue_id = ?",
    ).get(issueId) as { ordinal: number } | undefined;
    return row?.ordinal ?? 1;
  }

  private getLabel(issueId: string, label: string): LedgerLabel | null {
    return (this.db.prepare(
      "SELECT * FROM ledger_labels WHERE issue_id = ? AND label = ?",
    ).get(issueId, label) as LedgerLabel | undefined) ?? null;
  }

  private getIssueBranch(issueId: string, branch: string): LedgerIssueBranch | null {
    return (this.db.prepare(
      "SELECT * FROM issue_branches WHERE issue_id = ? AND branch = ?",
    ).get(issueId, branch) as LedgerIssueBranch | undefined) ?? null;
  }

  private getConflict(id: string): LedgerConflict {
    const row = this.db.prepare("SELECT * FROM ledger_conflicts WHERE id = ?").get(id) as LedgerConflict | undefined;
    if (!row) {
      throw new Error(`Ledger conflict not found: ${id}`);
    }
    return row;
  }

  private requireOutbox(id: string): LedgerOutbox {
    const row = this.db.prepare("SELECT * FROM ledger_outbox WHERE id = ?").get(id) as LedgerOutbox | undefined;
    if (!row) {
      throw new Error(`Ledger outbox row not found: ${id}`);
    }
    return row;
  }

  private resolveProjectId(projectRef: string | undefined, fallbackProjectId: string): string | null {
    const ref = projectRef?.trim();
    if (!ref) return fallbackProjectId;
    const rows = this.db.prepare(
      `SELECT id FROM ledger_projects WHERE lower(display_name) = lower(?)
       UNION
       SELECT project_id AS id FROM ledger_project_checkouts
        WHERE lower(name) = lower(?) OR work_repo_id = ?`,
    ).all(ref, ref, ref) as Array<{ id: string }>;
    if (rows.length === 1) return rows[0].id;
    return null;
  }

  private ensureDerivedReferenceRelationship(
    sourceIssueId: string,
    targetIssueId: string,
    source: LedgerEventSource,
    actor: { actor_id: string | null; actor_type: LedgerActorType },
    now: number,
    emitted: LedgerSsePayload[],
  ): LedgerIssueRelationship {
    const sourceIssue = this.requireIssue(sourceIssueId);
    let relationship = this.db.prepare(
      `SELECT * FROM ledger_issue_relationships
       WHERE source_issue_id = ? AND target_issue_id = ? AND relationship_type = 'references'`,
    ).get(sourceIssueId, targetIssueId) as LedgerIssueRelationship | undefined;
    let changed = false;
    if (!relationship) {
      const id = createLedgerId("rel", { now });
      this.db.prepare(
        `INSERT INTO ledger_issue_relationships (
          id, source_issue_id, target_issue_id, relationship_type, provenance,
          confidence, metadata_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, 'references', 'derived', 'observed', ?, ?, ?, NULL)`,
      ).run(
        id,
        sourceIssueId,
        targetIssueId,
        jsonStringify({ derived_from: "issue_text_refs" }),
        now,
        now,
      );
      relationship = this.db.prepare("SELECT * FROM ledger_issue_relationships WHERE id = ?")
        .get(id) as LedgerIssueRelationship;
      changed = true;
    } else if (relationship.deleted_at !== null) {
      this.db.prepare(
        `UPDATE ledger_issue_relationships
         SET deleted_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now, relationship.id);
      relationship = this.db.prepare("SELECT * FROM ledger_issue_relationships WHERE id = ?")
        .get(relationship.id) as LedgerIssueRelationship;
      changed = true;
    }
    if (!changed) return relationship;
    const event = this.insertEvent({
      entity_type: "issue_relationship",
      entity_id: relationship.id,
      event_type: "relationship.upserted",
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      source,
      payload: {
        relationship_id: relationship.id,
        source_issue_id: sourceIssueId,
        target_issue_id: targetIssueId,
        relationship_type: "references",
        provenance: relationship.provenance,
      },
      project_id: sourceIssue.project_id,
      occurred_at: now,
    });
    emitted.push({ event, payload: { relationship_id: relationship.id } });
    return relationship;
  }

  private upsertRelationshipSource(input: {
    relationship: LedgerIssueRelationship;
    input: ReconcileTextIssueReferencesInput;
    ref: ParsedIssueReference;
    source: LedgerEventSource;
    actor: { actor_id: string | null; actor_type: LedgerActorType };
    now: number;
  }): void {
    const existing = this.db.prepare(
      `SELECT * FROM ledger_issue_relationship_sources
       WHERE source_entity_type = ? AND source_entity_id = ? AND target_issue_id = ?
         AND relationship_type = 'references' AND ref_kind = ? AND normalized_ref = ?`,
    ).get(
      input.input.source_entity_type,
      input.input.source_entity_id,
      input.relationship.target_issue_id,
      input.ref.kind,
      input.ref.normalized,
    ) as LedgerIssueRelationshipSource | undefined;
    const metadata = {
      raw_ref: input.ref.raw,
      project: input.ref.project ?? null,
      comment_ref: input.ref.commentRef ?? null,
      source: input.source,
    };
    if (!existing) {
      this.db.prepare(
        `INSERT INTO ledger_issue_relationship_sources (
          id, relationship_id, source_entity_type, source_entity_id,
          source_issue_id, target_issue_id, relationship_type, ref_kind,
          raw_ref, normalized_ref, metadata_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'references', ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        createLedgerId("xref", { now: input.now }),
        input.relationship.id,
        input.input.source_entity_type,
        input.input.source_entity_id,
        input.input.source_issue_id,
        input.relationship.target_issue_id,
        input.ref.kind,
        input.ref.raw,
        input.ref.normalized,
        jsonStringify(metadata),
        input.now,
        input.now,
      );
      return;
    }
    if (
      existing.relationship_id === input.relationship.id
      && existing.raw_ref === input.ref.raw
      && existing.metadata_json === jsonStringify(metadata)
      && existing.deleted_at === null
    ) {
      return;
    }
    this.db.prepare(
      `UPDATE ledger_issue_relationship_sources
       SET relationship_id = ?, raw_ref = ?, metadata_json = ?,
           updated_at = ?, deleted_at = NULL
       WHERE id = ?`,
    ).run(
      input.relationship.id,
      input.ref.raw,
      jsonStringify(metadata),
      input.now,
      existing.id,
    );
  }

  private pruneDerivedRelationshipIfUnreferenced(
    relationshipId: string,
    source: LedgerEventSource,
    actor: { actor_id: string | null; actor_type: LedgerActorType },
    now: number,
    emitted: LedgerSsePayload[],
  ): void {
    const relationship = this.db.prepare("SELECT * FROM ledger_issue_relationships WHERE id = ?")
      .get(relationshipId) as LedgerIssueRelationship | undefined;
    if (!relationship || relationship.provenance !== "derived" || relationship.deleted_at !== null) return;
    const liveSource = this.db.prepare(
      `SELECT 1 AS ok FROM ledger_issue_relationship_sources
       WHERE relationship_id = ? AND deleted_at IS NULL
       LIMIT 1`,
    ).get(relationshipId) as { ok: number } | undefined;
    if (liveSource) return;
    this.db.prepare(
      `UPDATE ledger_issue_relationships
       SET deleted_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, relationshipId);
    const event = this.insertEvent({
      entity_type: "issue_relationship",
      entity_id: relationshipId,
      event_type: "relationship.deleted",
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      source,
      payload: {
        relationship_id: relationshipId,
        source_issue_id: relationship.source_issue_id,
        target_issue_id: relationship.target_issue_id,
        relationship_type: relationship.relationship_type,
      },
      project_id: this.requireIssue(relationship.source_issue_id).project_id,
      occurred_at: now,
    });
    emitted.push({ event, payload: { relationship_id: relationshipId } });
  }

  private insertAlias(alias: LedgerIssueAlias): void {
    this.db.prepare(
      `INSERT INTO ledger_issue_aliases (
        issue_id, alias_kind, project_id, alias, external_id, source,
        is_primary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      alias.issue_id,
      alias.alias_kind,
      alias.project_id,
      alias.alias,
      alias.external_id,
      alias.source,
      alias.is_primary,
      alias.created_at,
    );
  }

  private insertEvent(input: {
    entity_type: string;
    entity_id: string;
    event_type: string;
    actor_id: string | null;
    actor_type: LedgerActorType;
    source: LedgerEventSource;
    payload: Record<string, unknown>;
    project_id: string;
    occurred_at: number;
    enqueueOutbox?: boolean;
  }): LedgerEvent {
    const observedAt = Date.now();
    const occurrence = createCreationNonce();
    const payload = { ...input.payload, event_nonce: occurrence };
    const id = createStableEventId({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      event_type: input.event_type,
      actor_id: input.actor_id,
      actor_type: input.actor_type,
      source: input.source,
      payload,
      occurred_at: input.occurred_at,
      observed_at: observedAt,
      occurrence,
    });
    this.db.prepare(
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_id, actor_type,
        source, payload_json, occurred_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.entity_type,
      input.entity_id,
      input.event_type,
      input.actor_id,
      input.actor_type,
      input.source,
      jsonStringify(payload),
      input.occurred_at,
      observedAt,
    );

    if (input.enqueueOutbox ?? shouldEnqueueOutbox(input.source)) {
      for (const adapter of this.outboxAdapters) {
        this.db.prepare(
          `INSERT OR IGNORE INTO ledger_outbox (
            id, event_id, adapter, project_id, status, attempt_count,
            available_at, last_attempt_at, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)`,
        ).run(
          createLedgerId("out", { now: input.occurred_at }),
          id,
          adapter,
          input.project_id,
          input.occurred_at,
          input.occurred_at,
          input.occurred_at,
        );
      }
    }

    return this.db.prepare("SELECT * FROM ledger_events WHERE id = ?").get(id) as LedgerEvent;
  }
}

function issueLifecycleEventType(
  previousStatus: LedgerIssueStatus,
  nextStatus: LedgerIssueStatus,
): "issue.closed" | "issue.reopened" | null {
  if (previousStatus === nextStatus) return null;
  return nextStatus === "closed" ? "issue.closed" : "issue.reopened";
}

function normalizeActor(input: LedgerActorInput): {
  actor_id: string | null;
  actor_type: LedgerActorType;
} {
  return {
    actor_id: input.actor_id ?? null,
    actor_type: input.actor_type ?? "external_adapter",
  };
}

function shouldEnqueueOutbox(source: LedgerEventSource): boolean {
  return source === "mandible" || source === "auth_queue" || source === "session" || source === "work_unit";
}

function relationshipSourceKey(targetIssueId: string, refKind: string, normalizedRef: string): string {
  return `${targetIssueId}\0${refKind}\0${normalizedRef}`;
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function normalizeCheckpointKind(kind: string): string {
  const trimmed = kind.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new Error("checkpoint kind must contain only letters, numbers, dots, underscores, colons, or hyphens");
  }
  return trimmed;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function omitBodyPatch(patch: UpdateLedgerIssuePatch | UpdateLedgerCommentPatch): Record<string, unknown> {
  const { body: _body, ...rest } = patch as Record<string, unknown>;
  return rest;
}

function changedIssueFields(
  existing: LedgerIssue,
  next: Pick<LedgerIssue, "title" | "body" | "kind" | "priority" | "author_display">,
): string[] {
  const fields: string[] = [];
  if (next.title !== existing.title) fields.push("title");
  if (next.body !== existing.body) fields.push("body");
  if (next.kind !== existing.kind) fields.push("kind");
  if (next.priority !== existing.priority) fields.push("priority");
  if (next.author_display !== existing.author_display) fields.push("author_display");
  return fields;
}

function changedCommentFields(
  existing: LedgerComment,
  next: Pick<LedgerComment, "body" | "author_display">,
): string[] {
  const fields: string[] = [];
  if (next.body !== existing.body) fields.push("body");
  if (next.author_display !== existing.author_display) fields.push("author_display");
  return fields;
}
