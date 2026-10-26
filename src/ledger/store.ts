import { createHash } from "node:crypto";
import { requestOriginFromMetadata, withRequestOriginMetadata } from "../request-origin.js";
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
import { resolveProjectRef } from "./project-registry.js";
import { resolveId, type RefResolution } from "../entity-refs.js";
import { assertEvidenceMethod } from "../identity/resolver.js";
import { getUserById } from "../users/store.js";
import type {
  LedgerActorInput,
  LedgerActorType,
  LedgerBodyRevision,
  LedgerBodyRevisionEntityType,
  LedgerBodyRevisionReason,
  LedgerComment,
  LedgerEvent,
  LedgerEventSource,
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
  LedgerPriority,
  LedgerRelationshipEdge,
  LedgerRelationshipEntityType,
  LedgerRelationshipProvenance,
  LedgerRelationshipType,
  LedgerStoredWorkerStatus,
} from "./types.js";
import { LEDGER_STORED_WORKER_STATUSES } from "./types.js";
import { parseJsonObject } from "../row-coerce.js";

/**
 * Issue d9e59e8 — `in_progress` is derived from an open or committed work unit,
 * so only explicit statements are stored.
 */
export function storedWorkerStatusError(value: string): string {
  return value === "in_progress"
    ? "in_progress is derived from an open or committed work unit and is not stored; claim one with `wt new --issue` or `mandible work-unit claim`, or store none, done, blocked, or pivot-needed"
    : `invalid worker status: ${value} (expected one of: ${LEDGER_STORED_WORKER_STATUSES.join(", ")})`;
}

export type ResolveIssueRefResult = RefResolution;

export interface LedgerStoreOptions {
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
  work_notes?: string;
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
  work_notes?: string;
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
  base_work_notes_revision_id?: string | null;
  base_work_notes_revision_provided?: boolean;
  base_work_notes_hash?: string;
}

export interface AddLedgerCommentInput extends LedgerActorInput {
  id?: string;
  body: string;
  source?: LedgerEventSource;
  created_at?: number;
  reopen?: boolean;
}

export interface AddLedgerIssueCheckpointInput extends LedgerActorInput {
  id?: string;
  kind: string;
  payload: unknown;
  source?: LedgerEventSource;
  created_at?: number;
}

export function ledgerIssueLifecycleError(
  status: LedgerIssueStatus,
  resolution: LedgerIssueResolution | null,
): string | null {
  if (status === "closed" && resolution === null) {
    return "closed issues require a resolution";
  }
  if (status === "open" && resolution !== null) {
    return "open issues cannot have a resolution";
  }
  return null;
}

function assertLedgerIssueLifecycle(
  status: LedgerIssueStatus,
  resolution: LedgerIssueResolution | null,
): void {
  const error = ledgerIssueLifecycleError(status, resolution);
  if (error) throw new Error(error);
}

/**
 * Issue kinds a project may have at most one open issue of. The rule is fixed
 * (issue 2d4f9b8): a duplicate maintenance issue splits the record the global
 * convention keeps in one place, so the cheap create path is refused and the
 * caller is pointed at the existing issue.
 */
export const SINGLETON_OPEN_ISSUE_KINDS: readonly LedgerIssueKind[] = ["maintenance"];

const SINGLETON_CONFLICT_LISTED_IDS = 3;

export type SingletonKindTransition = "create" | "kind_change" | "reopen";

export class LedgerSingletonKindError extends Error {
  readonly code = "singleton_kind_open";
  constructor(
    readonly kind: LedgerIssueKind,
    readonly transition: SingletonKindTransition,
    /** Ambiguity-safe short IDs of the open issues of this kind, oldest first. */
    readonly existingIssueIds: string[],
  ) {
    const listed = existingIssueIds.slice(0, SINGLETON_CONFLICT_LISTED_IDS).join(", ");
    const more = existingIssueIds.length - SINGLETON_CONFLICT_LISTED_IDS;
    const refusal = transition === "create"
      ? `cannot create another open ${kind} issue`
      : transition === "kind_change"
        ? `cannot change this open issue's kind to ${kind}`
        : `cannot reopen this ${kind} issue`;
    super(
      `${refusal}: a project may have at most one open ${kind} issue, and this project already has `
      + `${existingIssueIds.length === 1 ? "one" : existingIssueIds.length}: ${listed}`
      + `${more > 0 ? ` (and ${more} more)` : ""}. `
      + `Comment on the existing ${kind} issue instead.`,
    );
    this.name = "LedgerSingletonKindError";
  }
}

interface IssueOpenKindState {
  kind: LedgerIssueKind;
  status: LedgerIssueStatus;
}

function becomesOpenSingleton(
  before: IssueOpenKindState | null,
  after: IssueOpenKindState,
): boolean {
  if (after.status !== "open" || !SINGLETON_OPEN_ISSUE_KINDS.includes(after.kind)) return false;
  return before === null || before.status !== "open" || before.kind !== after.kind;
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
  actor: LedgerActorInput;
  created_at?: number;
}

export interface LedgerRelationshipEntityInput {
  entity_type: LedgerRelationshipEntityType;
  entity_id: string;
}

export interface LinkRelationshipEdgesInput {
  source_entity: LedgerRelationshipEntityInput;
  target_entities: LedgerRelationshipEntityInput[];
  link_type?: LedgerRelationshipType;
  provenance?: LedgerRelationshipProvenance;
  note?: string | null;
  action_id?: string;
  metadata?: Record<string, unknown>;
  source?: LedgerEventSource;
  actor: LedgerActorInput;
  created_at?: number;
}

export interface UnlinkRelationshipEdgesInput {
  source_entity: LedgerRelationshipEntityInput;
  target_entities: LedgerRelationshipEntityInput[];
  link_type?: LedgerRelationshipType;
  action_id?: string;
  source?: LedgerEventSource;
  actor: LedgerActorInput;
  occurred_at?: number;
}

export interface ReconcileTextIssueReferencesInput {
  source_issue_id: string;
  source_entity_type: "issue_body" | "comment";
  source_entity_id: string;
  body: string;
  source?: LedgerEventSource;
  actor: LedgerActorInput;
}

export interface RecordLedgerEventInput extends LedgerActorInput {
  entity_type: string;
  entity_id: string;
  event_type: string;
  source?: LedgerEventSource;
  payload?: Record<string, unknown>;
  project_id?: string | null;
  occurred_at?: number;
  notify?: boolean;
}

export class LedgerStore {
  private readonly db: Db;
  private readonly broadcaster: LedgerBroadcaster;

  constructor(db: Db, options: LedgerStoreOptions = {}) {
    this.db = db;
    this.db.pragma("foreign_keys = ON");
    this.broadcaster = options.broadcaster ?? broadcast;
  }

  /**
   * Resolve a write actor's legacy provenance and parallel user-attribution
   * columns (umbrella 8e2e8b2 / issue 92813cc).
   *
   * The legacy `actor_id`/`actor_type` tuple is FROZEN — it is exactly what the
   * caller passed (or the historical `external_adapter` default). It is hashed
   * into stable ids, so this lane never changes it and never derives it from the
   * user's kind.
   *
   * The parallel `*_user_id`/evidence columns carry the real identity.
   * `attribution` is required at the TypeScript boundary, so a NULL user_id is
   * reachable only for pre-migration rows, never from a new write.
   * `evidence_method` is validated against the locked vocabulary here.
   */
  private resolveActor(input: LedgerActorInput): ResolvedActor {
    const candidate = input?.attribution;
    // An omitted attribution key is a programming error: the safety net that
    // prevents an accidental unattributed write stays in force (umbrella
    // 8e2e8b2). A DELIBERATE unattributed write passes `attribution: null`
    // explicitly (issue a64d2de) and is handled below.
    if (candidate === undefined) {
      throw new Error("Ledger write requires an explicit attribution context");
    }
    const base = normalizeActor(input);
    if (candidate === null) {
      // Unattributed write (issue a64d2de): a tokenless compat-mode request
      // whose ambient session signal did not resolve to any user. This is the
      // pre-identity legacy behavior — the parallel user-attribution columns are
      // stored NULL while the frozen legacy actor_id/actor_type/author_display
      // provenance still populates.
      return {
        actor_id: base.actor_id,
        actor_type: base.actor_type,
        actor_user_id: null,
        evidence_method: null,
        evidence_id: null,
        attribution: null,
      };
    }
    // Snapshot every caller-controlled primitive once. JavaScript callers may
    // supply accessors or proxies; validation and persistence must operate on
    // the same immutable values.
    const userId = candidate.user_id;
    const evidenceMethod = candidate.evidence_method;
    const evidenceId = candidate.evidence_id ?? null;
    const authorizerUserId = candidate.authorizer_user_id ?? null;
    assertEvidenceMethod(evidenceMethod);
    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("Ledger write requires a non-empty attribution user_id");
    }
    if (evidenceId !== null && typeof evidenceId !== "string") {
      throw new Error("Ledger write attribution evidence_id must be a string or null");
    }
    if (authorizerUserId !== null && typeof authorizerUserId !== "string") {
      throw new Error("Ledger write attribution authorizer_user_id must be a string or null");
    }
    const user = getUserById(this.db, userId);
    if (!user || user.status !== "active") {
      throw new Error(`Ledger write attribution user '${userId}' is not active`);
    }
    const attribution = {
      user_id: userId,
      evidence_method: evidenceMethod,
      evidence_id: evidenceId,
      authorizer_user_id: authorizerUserId,
    };
    return {
      actor_id: base.actor_id,
      actor_type: base.actor_type,
      actor_user_id: userId,
      evidence_method: evidenceMethod,
      evidence_id: evidenceId,
      attribution,
    };
  }

  /**
   * Check, without writing, whether moving an issue to the given kind and
   * status would break the singleton-kind rule. Callers that apply one request
   * as several store writes use this to refuse the whole request up front; each
   * store write still enforces the rule inside its own transaction.
   */
  assertIssueKindTransition(id: string, next: Partial<IssueOpenKindState>): void {
    const existing = this.requireIssue(id);
    this.assertSingletonKindTransition(existing.project_id, id, existing, {
      kind: next.kind ?? existing.kind,
      status: next.status ?? existing.status,
    });
  }

  private assertSingletonKindTransition(
    projectId: string,
    issueId: string | null,
    before: IssueOpenKindState | null,
    after: IssueOpenKindState,
  ): void {
    if (!becomesOpenSingleton(before, after)) return;
    const rows = this.db.prepare(
      `SELECT id, short_id FROM ledger_issues
       WHERE project_id = ? AND kind = ? AND status = 'open' AND deleted_at IS NULL AND id != ?
       ORDER BY created_at ASC, id ASC`,
    ).all(projectId, after.kind, issueId ?? "") as Array<{ id: string; short_id: string }>;
    if (rows.length === 0) return;
    const transition: SingletonKindTransition = before === null
      ? "create"
      : before.status !== "open" ? "reopen" : "kind_change";
    throw new LedgerSingletonKindError(
      after.kind,
      transition,
      rows.map((row) => row.short_id || row.id.slice(0, 7)),
    );
  }

  createIssue(input: CreateLedgerIssueInput): LedgerIssue {
    const emitted: LedgerSsePayload[] = [];
    const now = input.created_at ?? Date.now();
    const source = input.source ?? "mandible";
    const actor = this.resolveActor(input);
    assertLedgerIssueLifecycle(input.status ?? "open", input.resolution ?? null);
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
      this.assertSingletonKindTransition(input.project_id, null, null, {
        kind: input.kind ?? "unknown",
        status: input.status ?? "open",
      });
      this.db.prepare(
        `INSERT INTO ledger_issues (
          id, short_id, project_id, title, body, work_notes, status, resolution, kind, priority,
          author_actor_id, author_actor_type, author_display,
          author_user_id, evidence_method, evidence_id, source,
          created_at, updated_at, closed_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        shortId,
        input.project_id,
        input.title,
        input.body ?? "",
        input.work_notes ?? "",
        input.status ?? "open",
        input.resolution ?? null,
        input.kind ?? "unknown",
        input.priority ?? "normal",
        actor.actor_id,
        actor.actor_type,
        input.author_display ?? "",
        actor.actor_user_id,
        actor.evidence_method,
        actor.evidence_id,
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
      if (input.work_notes) {
        const { event } = this.recordBodyRevisionEvent({
          entity_type: "issue_work_notes",
          entity_id: id,
          issue_id: id,
          project_id: input.project_id,
          previous_body: null,
          next_body: input.work_notes,
          actor,
          source,
          reason: "create",
          occurred_at: now,
          event_type: "issue.work_notes_updated",
          event_entity_type: "issue",
          event_entity_id: id,
          event_payload: { issue_id: id, work_notes: input.work_notes },
          changed_fields: ["work_notes"],
          update_current_body: false,
        });
        emitted.push({ event, payload: { issue_id: id, work_notes: input.work_notes } });
      }
      const issue = this.getIssue(id);
      this.applyTextIssueReferences({
        source_issue_id: issue.id,
        source_entity_type: "issue_body",
        source_entity_id: issue.id,
        body: issue.body,
        source,
        actor,
      }, emitted);
      return issue;
    });

    const issue = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return issue;
  }

  updateIssue(id: string, patch: UpdateLedgerIssuePatch, actor: UpdateLedgerIssueOptions): LedgerIssue {
    const existing = this.requireIssue(id);
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = this.resolveActor(actor);
    const source = actor.source ?? "mandible";
    const next = {
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      work_notes: patch.work_notes ?? existing.work_notes,
      kind: patch.kind ?? existing.kind,
      priority: patch.priority ?? existing.priority,
      author_display: patch.author_display ?? existing.author_display,
    };
    const changedFields = changedIssueFields(existing, next);
    if (changedFields.length === 0) {
      return existing;
    }
    const bodyChanged = changedFields.includes("body");
    const workNotesChanged = changedFields.includes("work_notes");
    if (bodyChanged) {
      this.assertBodyRevisionBase("issue_body", id, actor);
    }
    if (workNotesChanged) {
      this.assertBodyRevisionBase("issue_work_notes", id, actor);
    }

    const run = this.db.transaction(() => {
      this.assertSingletonKindTransition(existing.project_id, id, existing, {
        kind: next.kind,
        status: existing.status,
      });
      this.db.prepare(
        `UPDATE ledger_issues
         SET title = ?, work_notes = ?, kind = ?, priority = ?, author_display = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.title,
        next.work_notes,
        next.kind,
        next.priority,
        next.author_display,
        now,
        id,
      );
      const scalarPatch = omitBodyPatch(patch);
      const scalarChangedFields = changedFields.filter((field) => field !== "body" && field !== "work_notes");
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
      }
      if (workNotesChanged) {
        const { event } = this.recordBodyRevisionEvent({
          entity_type: "issue_work_notes",
          entity_id: id,
          issue_id: id,
          project_id: existing.project_id,
          previous_body: existing.work_notes,
          next_body: next.work_notes,
          actor: normalizedActor,
          source,
          reason: "edit",
          occurred_at: now,
          event_type: "issue.work_notes_updated",
          event_entity_type: "issue",
          event_entity_id: id,
          event_payload: { issue_id: id, work_notes: next.work_notes },
          changed_fields: ["work_notes"],
          update_current_body: true,
        });
        emitted.push({ event, payload: { issue_id: id, work_notes: next.work_notes } });
      }
      if (!bodyChanged && (!workNotesChanged || scalarChangedFields.length > 0)) {
        const event = this.insertEvent({
          entity_type: "issue",
          entity_id: id,
          event_type: "issue.updated",
          actor_id: normalizedActor.actor_id,
          actor_type: normalizedActor.actor_type,
          actor_user_id: normalizedActor.actor_user_id,
          evidence_method: normalizedActor.evidence_method,
          evidence_id: normalizedActor.evidence_id,
          source,
          payload: { issue_id: id, patch: scalarPatch, changed_fields: scalarChangedFields },
          project_id: existing.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: id, patch: scalarPatch, changed_fields: scalarChangedFields } });
      }
      const issue = this.getIssue(id);
      if (bodyChanged) {
        this.applyTextIssueReferences({
          source_issue_id: issue.id,
          source_entity_type: "issue_body",
          source_entity_id: issue.id,
          body: issue.body,
          source,
          actor: normalizedActor,
        }, emitted);
      }
      return issue;
    });

    const issue = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return issue;
  }

  applyImportedIssuePatch(
    id: string,
    patch: UpdateLedgerIssuePatch,
    source: LedgerEventSource,
    actor: LedgerActorInput,
  ): { changed: boolean; issue: LedgerIssue } {
    const existing = this.requireIssue(id);
    const now = Date.now();
    const normalizedActor = this.resolveActor(actor);
    const next = {
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      kind: patch.kind ?? existing.kind,
      work_notes: patch.work_notes ?? existing.work_notes,
      priority: patch.priority ?? existing.priority,
      author_display: patch.author_display ?? existing.author_display,
      status: patch.status ?? existing.status,
      resolution: patch.resolution === undefined
        ? patch.status === "open" ? null : existing.resolution
        : patch.resolution,
      closed_at: patch.closed_at === undefined
        ? patch.status === "open" ? null : existing.closed_at
        : patch.closed_at,
    };
    assertLedgerIssueLifecycle(next.status, next.resolution);
    const changed =
      next.title !== existing.title ||
      next.body !== existing.body ||
      next.work_notes !== existing.work_notes ||
      next.kind !== existing.kind ||
      next.priority !== existing.priority ||
      next.author_display !== existing.author_display ||
      next.status !== existing.status ||
      next.resolution !== existing.resolution ||
      next.closed_at !== existing.closed_at;
    if (!changed) {
      return { changed: false, issue: existing };
    }
    const changedFields = [
      ...changedIssueFields(existing, next),
      ...(next.status !== existing.status ? ["status"] : []),
      ...(next.resolution !== existing.resolution ? ["resolution"] : []),
      ...(next.closed_at !== existing.closed_at ? ["closed_at"] : []),
    ];
    const bodyChanged = changedFields.includes("body");
    const workNotesChanged = changedFields.includes("work_notes");

    const emitted: LedgerSsePayload[] = [];
    const run = this.db.transaction(() => {
      this.assertSingletonKindTransition(existing.project_id, id, existing, next);
      this.db.prepare(
         `UPDATE ledger_issues
         SET title = ?, work_notes = ?, kind = ?, priority = ?, author_display = ?,
             status = ?, resolution = ?, closed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.title,
        next.work_notes,
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
          previous_resolution: existing.resolution,
          resolution: next.resolution,
          patch: scalarPatch,
        }
        : {
          issue_id: id,
          patch: scalarPatch,
          ...(next.resolution !== existing.resolution
            ? { previous_resolution: existing.resolution, resolution: next.resolution }
            : {}),
        };
      const scalarChangedFields = changedFields.filter((field) => field !== "body" && field !== "work_notes");
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
      }
      if (workNotesChanged) {
        const { event } = this.recordBodyRevisionEvent({
          entity_type: "issue_work_notes",
          entity_id: id,
          issue_id: id,
          project_id: existing.project_id,
          previous_body: existing.work_notes,
          next_body: next.work_notes,
          actor: normalizedActor,
          source,
          reason: source === "git_bug" ? "external_update" : "edit",
          occurred_at: now,
          event_type: "issue.work_notes_updated",
          event_entity_type: "issue",
          event_entity_id: id,
          event_payload: { issue_id: id, work_notes: next.work_notes },
          changed_fields: ["work_notes"],
          update_current_body: true,
        });
        emitted.push({ event, payload: { issue_id: id, work_notes: next.work_notes } });
      }
      if (!bodyChanged && (!workNotesChanged || scalarChangedFields.length > 0)) {
        const event = this.insertEvent({
          entity_type: "issue",
          entity_id: id,
          event_type: eventType ?? "issue.updated",
          actor_id: normalizedActor.actor_id,
          actor_type: normalizedActor.actor_type,
          actor_user_id: normalizedActor.actor_user_id,
          evidence_method: normalizedActor.evidence_method,
          evidence_id: normalizedActor.evidence_id,
          source,
          payload: { ...eventPayload, changed_fields: scalarChangedFields },
          project_id: existing.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: id, patch: scalarPatch, changed_fields: scalarChangedFields } });
      }
      const issue = this.getIssue(id);
      if (bodyChanged) {
        this.applyTextIssueReferences({
          source_issue_id: issue.id,
          source_entity_type: "issue_body",
          source_entity_id: issue.id,
          body: issue.body,
          source,
          actor: normalizedActor,
        }, emitted);
      }
      return issue;
    });

    const issue = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return { changed: true, issue };
  }

  setIssueStatus(
    id: string,
    status: LedgerIssueStatus,
    resolution: LedgerIssueResolution | null = null,
    actor: LedgerActorInput,
    source: LedgerEventSource = "mandible",
  ): LedgerIssue {
    assertLedgerIssueLifecycle(status, resolution);
    const existing = this.requireIssue(id);
    if (existing.status === status && existing.resolution === resolution) {
      return existing;
    }
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = this.resolveActor(actor);

    const run = this.db.transaction(() => {
      this.assertSingletonKindTransition(existing.project_id, id, existing, {
        kind: existing.kind,
        status,
      });
      this.db.prepare(
        `UPDATE ledger_issues
         SET status = ?, resolution = ?, closed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, resolution, status === "closed" ? now : null, now, id);
      const eventType = status === "closed" ? "issue.closed" : "issue.reopened";
      const payload = {
        issue_id: id,
        previous_status: existing.status,
        status,
        previous_resolution: existing.resolution,
        resolution,
      };
      const event = this.insertEvent({
        entity_type: "issue",
        entity_id: id,
        event_type: eventType,
        actor_id: normalizedActor.actor_id,
        actor_type: normalizedActor.actor_type,
        actor_user_id: normalizedActor.actor_user_id,
        evidence_method: normalizedActor.evidence_method,
        evidence_id: normalizedActor.evidence_id,
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
    workerStatus: LedgerStoredWorkerStatus,
    actor: LedgerActorInput,
    source: LedgerEventSource = "mandible",
  ): LedgerIssue {
    if (!(LEDGER_STORED_WORKER_STATUSES as readonly string[]).includes(workerStatus)) {
      throw new Error(storedWorkerStatusError(workerStatus));
    }
    const existing = this.requireIssue(id);
    if (existing.worker_status === workerStatus) {
      return existing;
    }
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = this.resolveActor(actor);

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
        actor_user_id: normalizedActor.actor_user_id,
        evidence_method: normalizedActor.evidence_method,
        evidence_id: normalizedActor.evidence_id,
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

  addIssueBranch(
    issueId: string,
    branch: string,
    role: LedgerIssueBranchRole = "primary",
    actor: LedgerActorInput,
    source: LedgerEventSource = "mandible",
  ): LedgerIssueBranch {
    const issue = this.requireIssue(issueId);
    const trimmedBranch = branch.trim();
    if (!trimmedBranch) {
      throw new Error("Issue branch cannot be empty");
    }
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = this.resolveActor(actor);

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
        actor_user_id: normalizedActor.actor_user_id,
        evidence_method: normalizedActor.evidence_method,
        evidence_id: normalizedActor.evidence_id,
        source,
        payload,
        project_id: issue.project_id,
        occurred_at: now,
      });
      emitted.push({ event, payload });
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
    return this.prepareEventRecorder(input)(input);
  }

  /** Freeze validated attribution before a mutation can retire its own actor. */
  prepareEventRecorder(input: LedgerActorInput): (event: Omit<RecordLedgerEventInput, keyof LedgerActorInput>) => LedgerEvent {
    const actor = this.resolveActor(input);
    return (input) => {
    const now = input.occurred_at ?? Date.now();
    const source = input.source ?? "system";

    const event = this.db.transaction(() => this.insertEvent({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      event_type: input.event_type,
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      actor_user_id: actor.actor_user_id,
      evidence_method: actor.evidence_method,
      evidence_id: actor.evidence_id,
      source,
      payload: input.payload ?? {},
      project_id: input.project_id,
      occurred_at: now,
    }))();
    if (input.notify !== false) {
      emitLedgerEvents([{ event, payload: input.payload ?? { entity_id: input.entity_id } }], this.broadcaster);
    }
    return event;
    };
  }

  /** Publish a committed record after an enclosing mutation transaction succeeds. */
  notifyEvent(event: LedgerEvent): void {
    if (this.db.inTransaction) throw new Error("Ledger event notification requires a committed transaction");
    emitLedgerEvents([{ event, payload: parseJsonObject(event.payload_json) }], this.broadcaster);
  }

  addComment(issueId: string, input: AddLedgerCommentInput): LedgerComment {
    const emitted: LedgerSsePayload[] = [];
    const now = input.created_at ?? Date.now();
    const source = input.source ?? "mandible";
    const actor = this.resolveActor(input);
    const nonce = createCreationNonce();

    const run = this.db.transaction(() => {
      const issue = this.requireIssue(issueId);
      const ordinal = this.nextCommentOrdinal(issueId);
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
      if (input.reopen && issue.status === "closed") {
        this.assertSingletonKindTransition(issue.project_id, issueId, issue, {
          kind: issue.kind,
          status: "open",
        });
        this.db.prepare(
          `UPDATE ledger_issues
           SET status = 'open', resolution = NULL, closed_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(now, issueId);
        const reopenPayload = {
          issue_id: issueId,
          previous_status: issue.status,
          status: "open",
          previous_resolution: issue.resolution,
          resolution: null,
        };
        const reopenEvent = this.insertEvent({
          entity_type: "issue",
          entity_id: issueId,
          event_type: "issue.reopened",
          actor_id: actor.actor_id,
          actor_type: actor.actor_type,
          actor_user_id: actor.actor_user_id,
          evidence_method: actor.evidence_method,
          evidence_id: actor.evidence_id,
          source,
          payload: reopenPayload,
          project_id: issue.project_id,
          occurred_at: now,
        });
        emitted.push({ event: reopenEvent, payload: reopenPayload });
      }
      this.db.prepare(
        `INSERT INTO ledger_comments (
          id, issue_id, ordinal, body, author_actor_id, author_actor_type,
          author_display, author_user_id, evidence_method, evidence_id,
          source, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        id,
        issueId,
        ordinal,
        input.body,
        actor.actor_id,
        actor.actor_type,
        input.author_display ?? "",
        actor.actor_user_id,
        actor.evidence_method,
        actor.evidence_id,
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
      const comment = this.getComment(id);
      this.applyTextIssueReferences({
        source_issue_id: issueId,
        source_entity_type: "comment",
        source_entity_id: comment.id,
        body: comment.body,
        source,
        actor,
      }, emitted);
      return comment;
    });

    const comment = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return comment;
  }

  addIssueCheckpoint(issueId: string, input: AddLedgerIssueCheckpointInput): LedgerIssueCheckpoint {
    const issue = this.requireIssue(issueId);
    const kind = normalizeCheckpointKind(input.kind);
    const now = input.created_at ?? Date.now();
    const source = input.source ?? "mandible";
    const actor = this.resolveActor(input);
    const id = input.id ?? createLedgerId("chk", { now });
    const payloadJson = jsonStringify(input.payload);
    const emitted: LedgerSsePayload[] = [];

    const run = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO ledger_issue_checkpoints (
          id, issue_id, kind, payload_json, author_actor_id, author_actor_type,
          author_display, author_user_id, evidence_method, evidence_id,
          source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        issueId,
        kind,
        payloadJson,
        actor.actor_id,
        actor.actor_type,
        input.author_display ?? "",
        actor.actor_user_id,
        actor.evidence_method,
        actor.evidence_id,
        source,
        now,
      );
      const event = this.insertEvent({
        entity_type: "issue_checkpoint",
        entity_id: id,
        event_type: "issue.checkpoint.created",
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        actor_user_id: actor.actor_user_id,
        evidence_method: actor.evidence_method,
        evidence_id: actor.evidence_id,
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
    source: LedgerEventSource,
    actorInput: LedgerActorInput,
  ): { changed: boolean; comment: LedgerComment } {
    const existing = this.getComment(id);
    const issue = this.requireIssue(existing.issue_id);
    const actor = this.resolveActor(actorInput);
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
          actor_user_id: actor.actor_user_id,
          evidence_method: actor.evidence_method,
          evidence_id: actor.evidence_id,
          source,
          payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields },
          project_id: issue.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields } });
      }
      const comment = this.getComment(id);
      if (bodyChanged) {
        this.applyTextIssueReferences({
          source_issue_id: existing.issue_id,
          source_entity_type: "comment",
          source_entity_id: id,
          body: comment.body,
          source,
          actor,
        }, emitted);
      }
      return comment;
    });

    const comment = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return { changed: true, comment };
  }

  updateComment(id: string, patch: UpdateLedgerCommentPatch, actorInput: UpdateLedgerCommentOptions): LedgerComment {
    const existing = this.getComment(id);
    const issue = this.requireIssue(existing.issue_id);
    const actor = this.resolveActor(actorInput);
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
          actor_user_id: actor.actor_user_id,
          evidence_method: actor.evidence_method,
          evidence_id: actor.evidence_id,
          source,
          payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields },
          project_id: issue.project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload: { issue_id: existing.issue_id, comment_id: id, patch: scalarPatch, changed_fields: changedFields } });
      }
      const comment = this.getComment(id);
      if (bodyChanged) {
        this.applyTextIssueReferences({
          source_issue_id: existing.issue_id,
          source_entity_type: "comment",
          source_entity_id: id,
          body: comment.body,
          source,
          actor,
        }, emitted);
      }
      return comment;
    });

    const comment = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return comment;
  }

  recordNormalizedBody(input: {
    entity_type: "issue" | "comment";
    entity_id: string;
    next_body: string;
    payload: Record<string, unknown>;
    actor: LedgerActorInput;
    occurred_at?: number;
  }): LedgerEvent | null {
    const actor = this.resolveActor(input.actor);
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
      this.applyTextIssueReferences({
        source_issue_id: target.issue.id,
        source_entity_type: target.bodyRevisionEntityType === "issue_body" ? "issue_body" : "comment",
        source_entity_id: input.entity_id,
        body: input.next_body,
        source: "system",
        actor,
      }, emitted);
      return event;
    });

    const event = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return event;
  }

  setLabel(
    issueId: string,
    label: string,
    present: boolean,
    source: LedgerEventSource = "mandible",
    actor: LedgerActorInput,
  ): { changed: boolean; label: LedgerLabel | null } {
    const issue = this.requireIssue(issueId);
    const emitted: LedgerSsePayload[] = [];
    const now = Date.now();
    const normalizedActor = this.resolveActor(actor);
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
          actor_user_id: normalizedActor.actor_user_id,
          evidence_method: normalizedActor.evidence_method,
          evidence_id: normalizedActor.evidence_id,
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
    const actor = this.resolveActor(input.actor);

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
        actor_user_id: actor.actor_user_id,
        evidence_method: actor.evidence_method,
        evidence_id: actor.evidence_id,
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

  linkRelationshipEdges(input: LinkRelationshipEdgesInput): {
    action_id: string;
    edges: LedgerRelationshipEdge[];
  } {
    if (input.target_entities.length === 0) {
      throw new Error("At least one relationship target is required");
    }
    const now = input.created_at ?? Date.now();
    const actionId = input.action_id ?? createLedgerId("edge", { now });
    const source = input.source ?? "mandible";
    const actor = this.resolveActor(input.actor);
    const linkType = input.link_type ?? "references";
    const provenance = input.provenance ?? "manual";
    const note = normalizeOptionalText(input.note);
    const metadataJson = jsonStringify(input.metadata ?? {});
    const sourceEntity = this.resolveRelationshipEntity(input.source_entity);
    const targetEntities = uniqueRelationshipEntities(
      input.target_entities.map((entity) => this.resolveRelationshipEntity(entity, { target: true })),
    );
    const emitted: LedgerSsePayload[] = [];

    const run = this.db.transaction(() => {
      const edges: LedgerRelationshipEdge[] = [];
      for (const targetEntity of targetEntities) {
        const existing = this.db.prepare(
          `SELECT * FROM ledger_relationship_edges
           WHERE source_entity_type = ?
             AND source_entity_id = ?
             AND target_entity_type = ?
             AND target_entity_id = ?
             AND link_type = ?`,
        ).get(
          sourceEntity.entity_type,
          sourceEntity.entity_id,
          targetEntity.entity_type,
          targetEntity.entity_id,
          linkType,
        ) as LedgerRelationshipEdge | undefined;

        if (!existing) {
          this.db.prepare(
            `INSERT INTO ledger_relationship_edges (
              id, source_entity_type, source_entity_id, source_project_id,
              source_issue_id, target_entity_type, target_entity_id,
              target_project_id, target_issue_id, link_type, provenance, note,
              action_id, actor_id, actor_type, actor_user_id, evidence_method,
              evidence_id, source, metadata_json,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          ).run(
            createLedgerId("edge", { now }),
            sourceEntity.entity_type,
            sourceEntity.entity_id,
            sourceEntity.project_id,
            sourceEntity.issue_id,
            targetEntity.entity_type,
            targetEntity.entity_id,
            targetEntity.project_id,
            targetEntity.issue_id,
            linkType,
            provenance,
            note,
            actionId,
            actor.actor_id,
            actor.actor_type,
            actor.actor_user_id,
            actor.evidence_method,
            actor.evidence_id,
            source,
            metadataJson,
            now,
            now,
          );
        } else {
          this.db.prepare(
            `UPDATE ledger_relationship_edges
             SET source_project_id = ?, source_issue_id = ?,
                 target_project_id = ?, target_issue_id = ?,
                 provenance = ?, note = ?, action_id = ?,
                 actor_id = ?, actor_type = ?,
                 actor_user_id = ?, evidence_method = ?, evidence_id = ?,
                 source = ?,
                 metadata_json = ?, updated_at = ?, deleted_at = NULL
             WHERE id = ?`,
          ).run(
            sourceEntity.project_id,
            sourceEntity.issue_id,
            targetEntity.project_id,
            targetEntity.issue_id,
            provenance,
            note,
            actionId,
            actor.actor_id,
            actor.actor_type,
            actor.actor_user_id,
            actor.evidence_method,
            actor.evidence_id,
            source,
            metadataJson,
            now,
            existing.id,
          );
        }

        const edge = this.db.prepare(
          `SELECT * FROM ledger_relationship_edges
           WHERE source_entity_type = ?
             AND source_entity_id = ?
             AND target_entity_type = ?
             AND target_entity_id = ?
             AND link_type = ?`,
        ).get(
          sourceEntity.entity_type,
          sourceEntity.entity_id,
          targetEntity.entity_type,
          targetEntity.entity_id,
          linkType,
        ) as LedgerRelationshipEdge;
        edges.push(edge);
        const payload = relationshipEdgeEventPayload(edge);
        const event = this.insertEvent({
          entity_type: "relationship_edge",
          entity_id: edge.id,
          event_type: "relationship.added",
          actor_id: actor.actor_id,
          actor_type: actor.actor_type,
          actor_user_id: actor.actor_user_id,
          evidence_method: actor.evidence_method,
          evidence_id: actor.evidence_id,
          source,
          payload,
          project_id: edge.source_project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload });
      }
      return edges;
    });

    const edges = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return { action_id: actionId, edges };
  }

  unlinkRelationshipEdges(input: UnlinkRelationshipEdgesInput): {
    action_id: string;
    edges: LedgerRelationshipEdge[];
  } {
    if (input.target_entities.length === 0) {
      throw new Error("At least one relationship target is required");
    }
    const now = input.occurred_at ?? Date.now();
    const actionId = input.action_id ?? createLedgerId("edge", { now });
    const source = input.source ?? "mandible";
    const actor = this.resolveActor(input.actor);
    const linkType = input.link_type ?? "references";
    const sourceEntity = this.resolveRelationshipEntity(input.source_entity);
    const targetEntities = uniqueRelationshipEntities(
      input.target_entities.map((entity) => this.resolveRelationshipEntity(entity, { target: true })),
    );
    const emitted: LedgerSsePayload[] = [];

    const run = this.db.transaction(() => {
      const removed: LedgerRelationshipEdge[] = [];
      for (const targetEntity of targetEntities) {
        const edge = this.db.prepare(
          `SELECT * FROM ledger_relationship_edges
           WHERE source_entity_type = ?
             AND source_entity_id = ?
             AND target_entity_type = ?
             AND target_entity_id = ?
             AND link_type = ?
             AND deleted_at IS NULL`,
        ).get(
          sourceEntity.entity_type,
          sourceEntity.entity_id,
          targetEntity.entity_type,
          targetEntity.entity_id,
          linkType,
        ) as LedgerRelationshipEdge | undefined;
        if (!edge) continue;
        this.db.prepare(
          `UPDATE ledger_relationship_edges
           SET action_id = ?, updated_at = ?, deleted_at = ?
           WHERE id = ?`,
        ).run(actionId, now, now, edge.id);
        const tombstone = this.db.prepare(
          "SELECT * FROM ledger_relationship_edges WHERE id = ?",
        ).get(edge.id) as LedgerRelationshipEdge;
        removed.push(tombstone);
        const payload = relationshipEdgeEventPayload(tombstone);
        const event = this.insertEvent({
          entity_type: "relationship_edge",
          entity_id: tombstone.id,
          event_type: "relationship.removed",
          actor_id: actor.actor_id,
          actor_type: actor.actor_type,
          actor_user_id: actor.actor_user_id,
          evidence_method: actor.evidence_method,
          evidence_id: actor.evidence_id,
          source,
          payload,
          project_id: tombstone.source_project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload });
      }
      return removed;
    });

    const edges = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return { action_id: actionId, edges };
  }

  listRelationshipEdges(filters: {
    source_issue_id?: string;
    target_issue_id?: string;
    source_entity?: LedgerRelationshipEntityInput;
    target_entity?: LedgerRelationshipEntityInput;
    include_deleted?: boolean;
  } = {}): LedgerRelationshipEdge[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.source_issue_id) {
      where.push("source_issue_id = ?");
      params.push(filters.source_issue_id);
    }
    if (filters.target_issue_id) {
      where.push("target_issue_id = ?");
      params.push(filters.target_issue_id);
    }
    if (filters.source_entity) {
      where.push("source_entity_type = ? AND source_entity_id = ?");
      params.push(filters.source_entity.entity_type, filters.source_entity.entity_id);
    }
    if (filters.target_entity) {
      where.push("target_entity_type = ? AND target_entity_id = ?");
      params.push(filters.target_entity.entity_type, filters.target_entity.entity_id);
    }
    if (!filters.include_deleted) {
      where.push("deleted_at IS NULL");
    }
    const sql = `SELECT * FROM ledger_relationship_edges${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY created_at, id`;
    return this.db.prepare(sql).all(...params) as LedgerRelationshipEdge[];
  }

  degradeCommentTargetRelationshipEdges(
    commentId: string,
    input: { actor: LedgerActorInput; source?: LedgerEventSource; occurred_at?: number },
  ): LedgerRelationshipEdge[] {
    const comment = this.getComment(commentId);
    const issue = this.requireIssue(comment.issue_id);
    const now = input.occurred_at ?? Date.now();
    const source = input.source ?? "system";
    const actor = this.resolveActor(input.actor);
    const emitted: LedgerSsePayload[] = [];

    const run = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT * FROM ledger_relationship_edges
         WHERE target_entity_type = 'comment'
           AND target_entity_id = ?
           AND deleted_at IS NULL`,
      ).all(commentId) as LedgerRelationshipEdge[];
      const degraded: LedgerRelationshipEdge[] = [];
      for (const row of rows) {
        const metadata = parseJsonObject(row.metadata_json);
        const nextMetadata = jsonStringify({
          ...metadata,
          degraded_from_target_comment_id: commentId,
        });
        const duplicate = this.db.prepare(
          `SELECT * FROM ledger_relationship_edges
           WHERE source_entity_type = ?
             AND source_entity_id = ?
             AND target_entity_type = 'issue'
             AND target_entity_id = ?
             AND link_type = ?
             AND deleted_at IS NULL
             AND id <> ?`,
        ).get(
          row.source_entity_type,
          row.source_entity_id,
          issue.id,
          row.link_type,
          row.id,
        ) as LedgerRelationshipEdge | undefined;
        if (duplicate) {
          this.db.prepare(
            `UPDATE ledger_relationship_edges
             SET metadata_json = ?, updated_at = ?, deleted_at = ?
             WHERE id = ?`,
          ).run(nextMetadata, now, now, row.id);
        } else {
          this.db.prepare(
            `UPDATE ledger_relationship_edges
             SET target_entity_type = 'issue',
                 target_entity_id = ?,
                 target_project_id = ?,
                 target_issue_id = ?,
                 metadata_json = ?,
                 updated_at = ?
             WHERE id = ?`,
          ).run(issue.id, issue.project_id, issue.id, nextMetadata, now, row.id);
        }
        const edge = this.db.prepare(
          "SELECT * FROM ledger_relationship_edges WHERE id = ?",
        ).get(row.id) as LedgerRelationshipEdge;
        degraded.push(edge);
        const payload = relationshipEdgeEventPayload(edge);
        const event = this.insertEvent({
          entity_type: "relationship_edge",
          entity_id: edge.id,
          event_type: edge.deleted_at === null ? "relationship.added" : "relationship.removed",
          actor_id: actor.actor_id,
          actor_type: actor.actor_type,
          actor_user_id: actor.actor_user_id,
          evidence_method: actor.evidence_method,
          evidence_id: actor.evidence_id,
          source,
          payload: { ...payload, degradation: "target_comment_tombstone" },
          project_id: edge.source_project_id,
          occurred_at: now,
        });
        emitted.push({ event, payload });
      }
      return degraded;
    });

    const degraded = run();
    emitLedgerEvents(emitted, this.broadcaster);
    return degraded;
  }

  reconcileTextIssueReferences(input: ReconcileTextIssueReferencesInput): void {
    const emitted: LedgerSsePayload[] = [];
    this.db.transaction(() => this.applyTextIssueReferences(input, emitted))();
    emitLedgerEvents(emitted, this.broadcaster);
  }

  /** Runs inside the caller's transaction so the text write and its derived references commit together. */
  private applyTextIssueReferences(input: ReconcileTextIssueReferencesInput, emitted: LedgerSsePayload[]): void {
    const sourceIssue = this.requireIssue(input.source_issue_id);
    const source = input.source ?? "mandible";
    const actor = this.resolveActor(input.actor);
    const now = Date.now();
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
  }

  /**
   * Resolve an issue ref: a full id, short id, alias, or unique prefix, or any
   * of those qualified as `<project>/<ref>`. A qualifier names the project the
   * issue must belong to and takes precedence over `options.project_id`.
   */
  resolveIssueRef(ref: string, options: { project_id?: string } = {}): ResolveIssueRefResult {
    const trimmed = ref.trim();
    if (!trimmed) {
      return { ok: false, error: "not_found" };
    }
    const qualified = /^([^/#\s]+)\/([^/#\s]+)$/.exec(trimmed);
    if (qualified) {
      const project = resolveProjectRef(this.db, qualified[1]);
      if (!project.ok) {
        return project.reason === "ambiguous"
          ? { ok: false, error: "ambiguous", matches: project.candidates }
          : { ok: false, error: "not_found" };
      }
      return resolveId(this.db, "issue", qualified[2], { scope: project.project.id });
    }
    return resolveId(this.db, "issue", trimmed, options.project_id ? { scope: options.project_id } : {});
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
    ).all(entity.entity_type, entity.entity_id).map((row) => ({
      ...row, request_origin: requestOriginFromMetadata(parseJsonObject(row.metadata_json)),
    })) as LedgerBodyRevision[];
  }

  getBodyRevision(id: string): LedgerBodyRevision {
    const row = this.db.prepare(
      "SELECT * FROM ledger_body_revisions WHERE id = ?",
    ).get(id) as LedgerBodyRevision | undefined;
    if (!row) {
      throw new Error(`Ledger body revision not found: ${id}`);
    }
    return { ...row, request_origin: requestOriginFromMetadata(parseJsonObject(row.metadata_json)) };
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

  /** The live comment with this ordinal; ordinals start at 1 and are never reused. */
  findCommentByOrdinal(issueId: string, ordinal: number): LedgerComment | null {
    if (!Number.isInteger(ordinal) || ordinal < 1) return null;
    return (this.db.prepare(
      "SELECT * FROM ledger_comments WHERE issue_id = ? AND ordinal = ? AND deleted_at IS NULL",
    ).get(issueId, ordinal) as LedgerComment | undefined) ?? null;
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
    input: {
      base_body_revision_id?: string;
      base_body_hash?: string;
      base_work_notes_revision_id?: string | null;
      base_work_notes_revision_provided?: boolean;
      base_work_notes_hash?: string;
    },
  ): void {
    const revisionId = entityType === "issue_work_notes"
      ? input.base_work_notes_revision_id
      : input.base_body_revision_id;
    const hash = entityType === "issue_work_notes"
      ? input.base_work_notes_hash
      : input.base_body_hash;
    const revisionProvided = entityType === "issue_work_notes"
      ? input.base_work_notes_revision_provided === true
      : input.base_body_revision_id !== undefined;
    if (!revisionProvided && !hash) return;
    const latest = this.latestBodyRevision(entityType, entityId);
    if (revisionProvided && (latest?.id ?? null) !== revisionId) {
      const error = new Error("stale body revision");
      error.name = "LedgerBodyRevisionConflictError";
      throw error;
    }
    if (hash && latest?.new_hash !== hash) {
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
    actor: ResolvedActor;
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
      actor_user_id: input.actor.actor_user_id,
      evidence_method: input.actor.evidence_method,
      evidence_id: input.actor.evidence_id,
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
      } else if (input.entity_type === "issue_work_notes") {
        this.db.prepare(
          "UPDATE ledger_issues SET work_notes = ?, updated_at = ? WHERE id = ?",
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
        actor_id, actor_type, actor_user_id, evidence_method, evidence_id,
        source, reason, occurred_at, observed_at,
        base_revision_id, base_hash, new_hash, snapshot_body, patch_format,
        patch_text, metadata_json, redacted_at, redacted_by_actor_id,
        redacted_by_user_id, redaction_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL)`,
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
      input.actor.actor_user_id,
      input.actor.evidence_method,
      input.actor.evidence_id,
      input.source,
      input.reason,
      input.occurred_at,
      event.observed_at,
      latest?.id ?? null,
      baseHash,
      newHash,
      input.next_body,
      jsonStringify(withRequestOriginMetadata(input.metadata ?? {})),
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

  private resolveProjectId(projectRef: string | undefined, fallbackProjectId: string): string | null {
    if (!projectRef?.trim()) return fallbackProjectId;
    const resolved = resolveProjectRef(this.db, projectRef);
    return resolved.ok ? resolved.project.id : null;
  }

  private resolveRelationshipEntity(
    entity: LedgerRelationshipEntityInput,
    options: { target?: boolean } = {},
  ): ResolvedRelationshipEntity {
    if (entity.entity_type === "issue") {
      const issue = this.requireIssue(entity.entity_id);
      if (issue.deleted_at !== null) {
        throw new Error(`Ledger issue is deleted: ${entity.entity_id}`);
      }
      return {
        entity_type: "issue",
        entity_id: issue.id,
        project_id: issue.project_id,
        issue_id: issue.id,
      };
    }

    const comment = this.getComment(entity.entity_id);
    const issue = this.requireIssue(comment.issue_id);
    if (comment.deleted_at !== null) {
      if (options.target) {
        return {
          entity_type: "issue",
          entity_id: issue.id,
          project_id: issue.project_id,
          issue_id: issue.id,
        };
      }
      throw new Error(`Ledger comment is deleted: ${entity.entity_id}`);
    }
    return {
      entity_type: "comment",
      entity_id: comment.id,
      project_id: issue.project_id,
      issue_id: issue.id,
    };
  }

  private ensureDerivedReferenceRelationship(
    sourceIssueId: string,
    targetIssueId: string,
    source: LedgerEventSource,
    actor: ResolvedActor,
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
      actor_user_id: actor.actor_user_id,
      evidence_method: actor.evidence_method,
      evidence_id: actor.evidence_id,
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
    actor: ResolvedActor;
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
    actor: ResolvedActor,
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
      actor_user_id: actor.actor_user_id,
      evidence_method: actor.evidence_method,
      evidence_id: actor.evidence_id,
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
    actor_user_id?: string | null;
    evidence_method?: string | null;
    evidence_id?: string | null;
    source: LedgerEventSource;
    payload: Record<string, unknown>;
    project_id?: string | null;
    occurred_at: number;
  }): LedgerEvent {
    const observedAt = Date.now();
    const occurrence = createCreationNonce();
    const payload = withRequestOriginMetadata({ ...input.payload, event_nonce: occurrence });
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
        actor_user_id, evidence_method, evidence_id,
        source, payload_json, occurred_at, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.entity_type,
      input.entity_id,
      input.event_type,
      input.actor_id,
      input.actor_type,
      input.actor_user_id ?? null,
      input.evidence_method ?? null,
      input.evidence_id ?? null,
      input.source,
      jsonStringify(payload),
      input.occurred_at,
      observedAt,
    );

    if (!input.project_id) return this.getEvent(id);

    this.db.prepare(
      `INSERT INTO ledger_change_feed_state (
        project_id, next_sequence, retained_from_sequence, updated_at
      ) VALUES (?, 1, 1, ?)
      ON CONFLICT(project_id) DO NOTHING`,
    ).run(input.project_id, observedAt);
    const state = this.db.prepare(
      `SELECT next_sequence FROM ledger_change_feed_state WHERE project_id = ?`,
    ).get(input.project_id) as { next_sequence: number };
    this.db.prepare(
      `INSERT INTO ledger_change_log (project_id, sequence, event_id, recorded_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.project_id, state.next_sequence, id, observedAt);
    this.db.prepare(
      `UPDATE ledger_change_feed_state
       SET next_sequence = next_sequence + 1, updated_at = ?
       WHERE project_id = ? AND next_sequence = ?`,
    ).run(observedAt, input.project_id, state.next_sequence);


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

/**
 * A ledger write actor after user-attribution resolution (umbrella 8e2e8b2 /
 * issue 92813cc). `actor_id`/`actor_type` are the legacy provenance columns
 * (hashed into stable ids); `actor_user_id`/`evidence_method`/`evidence_id` are
 * the parallel user-principal columns. Rows predating the attribution migration
 * may be NULL, and a genuinely unattributable new write (issue a64d2de:
 * tokenless compat-mode request with no resolvable session binding) is stored
 * NULL as well, reproducing the pre-identity legacy behavior.
 */
interface ResolvedActor extends LedgerActorInput {
  actor_id: string | null;
  actor_type: LedgerActorType;
  actor_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
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

interface ResolvedRelationshipEntity {
  entity_type: LedgerRelationshipEntityType;
  entity_id: string;
  project_id: string;
  issue_id: string;
}


function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueRelationshipEntities(entities: ResolvedRelationshipEntity[]): ResolvedRelationshipEntity[] {
  const seen = new Set<string>();
  const result: ResolvedRelationshipEntity[] = [];
  for (const entity of entities) {
    const key = `${entity.entity_type}\0${entity.entity_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entity);
  }
  return result;
}

function relationshipEdgeEventPayload(edge: LedgerRelationshipEdge): Record<string, unknown> {
  return {
    edge_id: edge.id,
    source_entity_type: edge.source_entity_type,
    source_entity_id: edge.source_entity_id,
    source_project_id: edge.source_project_id,
    source_issue_id: edge.source_issue_id,
    target_entity_type: edge.target_entity_type,
    target_entity_id: edge.target_entity_id,
    target_project_id: edge.target_project_id,
    target_issue_id: edge.target_issue_id,
    link_type: edge.link_type,
    provenance: edge.provenance,
    note: edge.note,
    action_id: edge.action_id,
    metadata: parseJsonObject(edge.metadata_json),
    deleted_at: edge.deleted_at,
  };
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
  const { body: _body, work_notes: _workNotes, ...rest } = patch as Record<string, unknown>;
  return rest;
}

function changedIssueFields(
  existing: LedgerIssue,
  next: Pick<LedgerIssue, "title" | "body" | "work_notes" | "kind" | "priority" | "author_display">,
): string[] {
  const fields: string[] = [];
  if (next.title !== existing.title) fields.push("title");
  if (next.body !== existing.body) fields.push("body");
  if (next.work_notes !== existing.work_notes) fields.push("work_notes");
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
