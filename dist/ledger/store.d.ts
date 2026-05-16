import type { Db } from "../db.js";
import { type LedgerBroadcaster } from "./events.js";
import type { LedgerActorInput, LedgerComment, LedgerConflict, LedgerConflictStatus, LedgerEvent, LedgerEventSource, LedgerExternalRef, LedgerIssue, LedgerIssueAlias, LedgerIssueDetail, LedgerIssueKind, LedgerIssueRelationship, LedgerIssueResolution, LedgerIssueStatus, LedgerLabel, LedgerOutbox, LedgerOutboxStatus, LedgerPriority, LedgerRelationshipProvenance, LedgerRelationshipType } from "./types.js";
export type ResolveIssueRefResult = {
    ok: true;
    id: string;
} | {
    ok: false;
    error: "not_found";
} | {
    ok: false;
    error: "ambiguous";
    count: number;
    matches: string[];
};
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
export interface MarkOutboxPatch {
    attempt_count?: number;
    last_attempt_at?: number | null;
    error?: string | null;
}
export declare class LedgerStore {
    private readonly db;
    private readonly outboxAdapters;
    private readonly broadcaster;
    constructor(db: Db, options?: LedgerStoreOptions);
    createIssue(input: CreateLedgerIssueInput): LedgerIssue;
    updateIssue(id: string, patch: UpdateLedgerIssuePatch, actor?: LedgerActorInput): LedgerIssue;
    applyImportedIssuePatch(id: string, patch: UpdateLedgerIssuePatch, source?: LedgerEventSource, actor?: LedgerActorInput): {
        changed: boolean;
        issue: LedgerIssue;
    };
    setIssueStatus(id: string, status: LedgerIssueStatus, resolution?: LedgerIssueResolution | null, actor?: LedgerActorInput): LedgerIssue;
    addComment(issueId: string, input: AddLedgerCommentInput): LedgerComment;
    setLabel(issueId: string, label: string, present: boolean, source?: LedgerEventSource, actor?: LedgerActorInput): {
        changed: boolean;
        label: LedgerLabel | null;
    };
    upsertIssueRelationship(input: UpsertRelationshipInput): LedgerIssueRelationship;
    recordExternalRef(input: RecordExternalRefInput): LedgerExternalRef;
    recordConflict(input: RecordConflictInput): LedgerConflict;
    markOutbox(id: string, status: LedgerOutboxStatus, patch?: MarkOutboxPatch): LedgerOutbox;
    resolveIssueRef(ref: string, options?: {
        project_id?: string;
    }): ResolveIssueRefResult;
    getIssue(id: string): LedgerIssue;
    getIssueDetail(id: string): LedgerIssueDetail;
    listIssues(filters?: {
        project_id?: string;
        status?: LedgerIssueStatus;
    }): LedgerIssue[];
    listAliases(issueId: string): LedgerIssueAlias[];
    listEvents(entity: {
        entity_type: string;
        entity_id: string;
    }): LedgerEvent[];
    getEvent(id: string): LedgerEvent;
    getComment(id: string): LedgerComment;
    listOutbox(filters?: {
        adapter?: string;
        status?: LedgerOutboxStatus;
    }): LedgerOutbox[];
    listConflicts(filters?: {
        status?: LedgerConflictStatus;
        adapter?: string;
    }): LedgerConflict[];
    findExternalRef(input: {
        adapter: string;
        project_id?: string;
        external_kind: string;
        external_id: string;
    }): LedgerExternalRef | null;
    findExternalRefForEntity(input: {
        adapter: string;
        entity_type: string;
        entity_id: string;
        external_kind?: string;
    }): LedgerExternalRef | null;
    private requireIssue;
    private getLabel;
    private getConflict;
    private requireOutbox;
    private insertAlias;
    private insertEvent;
}
