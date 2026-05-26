export declare const LEDGER_ISSUE_STATUSES: readonly ["open", "closed"];
export type LedgerIssueStatus = (typeof LEDGER_ISSUE_STATUSES)[number];
export declare const LEDGER_ISSUE_RESOLUTIONS: readonly ["fixed", "merged", "duplicate", "wontfix", "invalid", "obsolete", "unknown"];
export type LedgerIssueResolution = (typeof LEDGER_ISSUE_RESOLUTIONS)[number];
export declare const LEDGER_ISSUE_KINDS: readonly ["bug", "feature", "umbrella", "task", "question", "maintenance", "deferred", "unknown"];
export type LedgerIssueKind = (typeof LEDGER_ISSUE_KINDS)[number];
export declare const LEDGER_PRIORITIES: readonly ["low", "normal", "high", "urgent", "unknown"];
export type LedgerPriority = (typeof LEDGER_PRIORITIES)[number];
export declare const LEDGER_ACTOR_TYPES: readonly ["mandible_user", "agent", "system", "external_adapter"];
export type LedgerActorType = (typeof LEDGER_ACTOR_TYPES)[number];
export declare const LEDGER_EVENT_SOURCES: readonly ["mandible", "git_bug", "auth_queue", "session", "work_unit", "import", "system"];
export type LedgerEventSource = (typeof LEDGER_EVENT_SOURCES)[number];
export declare const LEDGER_OUTBOX_STATUSES: readonly ["pending", "processing", "applied", "failed", "conflicted", "skipped"];
export type LedgerOutboxStatus = (typeof LEDGER_OUTBOX_STATUSES)[number];
export declare const LEDGER_CONFLICT_STATUSES: readonly ["open", "resolved", "dismissed"];
export type LedgerConflictStatus = (typeof LEDGER_CONFLICT_STATUSES)[number];
export declare const LEDGER_RELATIONSHIP_TYPES: readonly ["parent_child", "blocks", "duplicate_of", "related", "references", "fixed_by", "caused_by", "implements", "tests"];
export type LedgerRelationshipType = (typeof LEDGER_RELATIONSHIP_TYPES)[number];
export declare const LEDGER_RELATIONSHIP_PROVENANCES: readonly ["manual", "imported", "derived", "system"];
export type LedgerRelationshipProvenance = (typeof LEDGER_RELATIONSHIP_PROVENANCES)[number];
export type LedgerNamespacePolicy = "remote" | "upstream" | "local";
export interface LedgerActorInput {
    actor_id?: string | null;
    actor_type?: LedgerActorType;
    author_display?: string;
}
export interface LedgerProject {
    id: string;
    display_name: string;
    remote_identity: string;
    upstream_identity: string;
    namespace_policy: LedgerNamespacePolicy;
    created_at: number;
    updated_at: number;
}
export interface LedgerProjectCheckout {
    id: string;
    project_id: string;
    work_repo_id: string | null;
    root: string;
    name: string;
    default_branch: string;
    remote_url: string;
    created_at: number;
    updated_at: number;
}
export interface LedgerIssue {
    id: string;
    short_id: string;
    project_id: string;
    title: string;
    body: string;
    status: LedgerIssueStatus;
    resolution: LedgerIssueResolution | null;
    kind: LedgerIssueKind;
    priority: LedgerPriority;
    author_actor_id: string | null;
    author_actor_type: LedgerActorType;
    author_display: string;
    source: LedgerEventSource;
    created_at: number;
    updated_at: number;
    closed_at: number | null;
    deleted_at: number | null;
}
export interface LedgerIssueAlias {
    issue_id: string;
    alias_kind: string;
    project_id: string;
    alias: string;
    external_id: string;
    source: string;
    is_primary: number;
    created_at: number;
}
export interface LedgerComment {
    id: string;
    issue_id: string;
    ordinal: number;
    body: string;
    author_actor_id: string | null;
    author_actor_type: LedgerActorType;
    author_display: string;
    source: LedgerEventSource;
    created_at: number;
    updated_at: number | null;
    deleted_at: number | null;
}
export interface LedgerLabel {
    issue_id: string;
    label: string;
    source: string;
    created_at: number;
    deleted_at: number | null;
}
export interface LedgerIssueRelationship {
    id: string;
    source_issue_id: string;
    target_issue_id: string;
    relationship_type: LedgerRelationshipType;
    provenance: LedgerRelationshipProvenance;
    confidence: string;
    metadata_json: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}
export interface LedgerEvent {
    id: string;
    entity_type: string;
    entity_id: string;
    event_type: string;
    actor_id: string | null;
    actor_type: LedgerActorType;
    source: LedgerEventSource;
    payload_json: string;
    occurred_at: number;
    observed_at: number;
}
export interface LedgerOutbox {
    id: string;
    event_id: string;
    adapter: string;
    project_id: string;
    status: LedgerOutboxStatus;
    attempt_count: number;
    available_at: number;
    last_attempt_at: number | null;
    error: string | null;
    created_at: number;
    updated_at: number;
}
export interface LedgerExternalRef {
    id: string;
    entity_type: string;
    entity_id: string;
    adapter: string;
    project_id: string;
    external_id: string;
    external_kind: string;
    remote_version: string;
    remote_hash: string;
    last_imported_at: number | null;
    last_exported_at: number | null;
    metadata_json: string;
    created_at: number;
    updated_at: number;
}
export interface LedgerConflict {
    id: string;
    adapter: string;
    project_id: string;
    entity_type: string;
    entity_id: string;
    field: string;
    local_value_json: string;
    remote_value_json: string;
    base_value_json: string;
    status: LedgerConflictStatus;
    resolution: string | null;
    created_at: number;
    resolved_at: number | null;
}
export interface LedgerIssueDetail extends LedgerIssue {
    aliases: LedgerIssueAlias[];
    comments: LedgerComment[];
    labels: LedgerLabel[];
    outgoing_relationships: LedgerIssueRelationship[];
    incoming_relationships: LedgerIssueRelationship[];
}
