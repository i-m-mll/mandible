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
import type {
  LedgerActorInput,
  LedgerActorType,
  LedgerComment,
  LedgerConflict,
  LedgerConflictStatus,
  LedgerEvent,
  LedgerEventSource,
  LedgerExternalRef,
  LedgerIssue,
  LedgerIssueAlias,
  LedgerIssueDetail,
  LedgerIssueKind,
  LedgerIssueRelationship,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerLabel,
  LedgerOutbox,
  LedgerOutboxStatus,
  LedgerPriority,
  LedgerRelationshipProvenance,
  LedgerRelationshipType,
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

export interface AddLedgerCommentInput extends LedgerActorInput {
  id?: string;
  body: string;
  source?: LedgerEventSource;
  created_at?: number;
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

      const event = this.insertEvent({
        entity_type: "issue",
        entity_id: id,
        event_type: "issue.created",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        source,
        payload: { issue_id: id, short_id: shortId, project_id: input.project_id, title: input.title, creation_nonce: nonce },
        project_id: input.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload: { issue_id: id, project_id: input.project_id } });
      return this.getIssue(id);
    });

    const issue = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return issue;
  }

  updateIssue(id: string, patch: UpdateLedgerIssuePatch, actor: LedgerActorInput = {}): LedgerIssue {
    const existing = this.requireIssue(id);
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = normalizeActor(actor);
    const next = {
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      kind: patch.kind ?? existing.kind,
      priority: patch.priority ?? existing.priority,
      author_display: patch.author_display ?? existing.author_display,
    };

    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_issues
         SET title = ?, body = ?, kind = ?, priority = ?,
             author_display = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.title,
        next.body,
        next.kind,
        next.priority,
        next.author_display,
        now,
        id,
      );
      const event = this.insertEvent({
        entity_type: "issue",
        entity_id: id,
        event_type: "issue.updated",
        actor_id: normalizedActor.actor_id,
        actor_type: normalizedActor.actor_type,
        source: "mandible",
        payload: { issue_id: id, patch },
        project_id: existing.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload: { issue_id: id, patch } });
      return this.getIssue(id);
    });

    const issue = run();
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

    const emitted: LedgerSsePayload[] = [];
    const run = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE ledger_issues
         SET title = ?, body = ?, kind = ?, priority = ?, author_display = ?,
             status = ?, resolution = ?, closed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.title,
        next.body,
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
      const event = this.insertEvent({
        entity_type: "issue",
        entity_id: id,
        event_type: eventType ?? "issue.updated",
        actor_id: normalizedActor.actor_id,
        actor_type: normalizedActor.actor_type,
        source,
        payload: eventType
          ? { issue_id: id, previous_status: existing.status, status: next.status, resolution: next.resolution, patch }
          : { issue_id: id, patch },
        project_id: existing.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload: { issue_id: id, patch } });
      return this.getIssue(id);
    });

    const issue = run();
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
      const event = this.insertEvent({
        entity_type: "comment",
        entity_id: id,
        event_type: "comment.created",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        source,
        payload: { issue_id: issueId, comment_id: id, ordinal, creation_nonce: nonce },
        project_id: issue.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload: { issue_id: issueId, comment_id: id, ordinal } });
      return this.getComment(id);
    });

    const comment = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return comment;
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
      labels: this.db.prepare(
        "SELECT * FROM ledger_labels WHERE issue_id = ? ORDER BY label",
      ).all(id) as LedgerLabel[],
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

  listEvents(entity: { entity_type: string; entity_id: string }): LedgerEvent[] {
    return this.db.prepare(
      `SELECT * FROM ledger_events
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY occurred_at, observed_at`,
    ).all(entity.entity_type, entity.entity_id) as LedgerEvent[];
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

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}
