import type { Db } from "../db.js";
import { type WorkUnitLiveness } from "../work-unit-utils.js";
import type { WorkUnit } from "../types.js";
import type { LedgerActorType, LedgerEventSource, LedgerIssueKind, LedgerIssueResolution, LedgerIssueStatus, LedgerPriority, LedgerRelationshipProvenance, LedgerRelationshipType } from "./types.js";
export interface LedgerIssueDetailAlias {
    kind: string;
    alias: string;
    external_id: string;
    source: string;
    primary: boolean;
}
export interface LedgerIssueDetailActor {
    id: string | null;
    type: LedgerActorType;
    display: string;
}
export interface LedgerIssueDetailComment {
    id: string;
    ordinal: number;
    body: string;
    author: LedgerIssueDetailActor;
    source: LedgerEventSource;
    created_at: number;
    updated_at: number | null;
}
export type LedgerIssueTimelineEntry = {
    id: string;
    kind: "body";
    ordinal: 0;
    body: string;
    author: LedgerIssueDetailActor;
    source: LedgerEventSource;
    created_at: number;
    updated_at: number | null;
} | {
    id: string;
    kind: "comment";
    comment_id: string;
    ordinal: number;
    body: string;
    author: LedgerIssueDetailActor;
    source: LedgerEventSource;
    created_at: number;
    updated_at: number | null;
} | {
    id: string;
    kind: "state";
    event_type: string;
    status: LedgerIssueStatus | null;
    resolution: LedgerIssueResolution | null;
    author: LedgerIssueDetailActor;
    source: LedgerEventSource;
    created_at: number;
    payload: Record<string, unknown>;
};
export interface LedgerIssueSummaryRef {
    id: string;
    display_id: string;
    project_id: string;
    title: string;
    status: LedgerIssueStatus;
    resolution: LedgerIssueResolution | null;
    kind: LedgerIssueKind;
    priority: LedgerPriority;
    labels: string[];
}
export interface LedgerIssueDetailRelationship {
    id: string;
    direction: "incoming" | "outgoing";
    relationship_type: LedgerRelationshipType;
    provenance: LedgerRelationshipProvenance;
    confidence: string;
    metadata: Record<string, unknown>;
    created_at: number;
    updated_at: number;
    related_issue: LedgerIssueSummaryRef | null;
}
export interface LedgerIssueDetailProject {
    id: string;
    display_name: string;
    remote_identity: string;
    upstream_identity: string;
    repo_id: string | null;
    repo_name: string | null;
    repo_root: string | null;
    default_branch: string | null;
}
export interface LedgerIssueDetailWorkUnit extends WorkUnit {
    link_type: string;
    link_source: string;
    link_created_at: number | null;
    last_seen_at: number | null;
    metadata: Record<string, unknown>;
    liveness: WorkUnitLiveness;
}
export interface LedgerIssueDetailSession {
    id: string;
    app: string;
    parent_id: string | null;
    status: string;
    branch: string | null;
    worktree: string | null;
    task: string | null;
    description: string | null;
    agent_type: string | null;
    created_at: string | null;
    updated_at: string | null;
    ended_at: string | null;
    last_active: string | null;
    has_conversation: boolean;
    link_type: string;
    link_source: string;
    link_created_at: number | null;
    last_seen_at: number | null;
    metadata: Record<string, unknown>;
}
export interface LedgerIssueDetailAuthRequest {
    id: string;
    type: string;
    title: string;
    status: string;
    repo: string | null;
    base_branch: string | null;
    head_branch: string | null;
    created_at: number | null;
    approved_at: number | null;
    resolved_at: number | null;
    skipped_at: number | null;
    exit_code: number | null;
    error: string | null;
    link_type: string;
    link_source: string;
    link_created_at: number | null;
    metadata: Record<string, unknown>;
}
export interface LedgerIssueDetailConflict {
    id: string;
    adapter: string;
    entity_type: string;
    entity_id: string;
    field: string;
    local_value: unknown;
    remote_value: unknown;
    base_value: unknown;
    status: string;
    resolution: string | null;
    created_at: number;
    resolved_at: number | null;
}
export interface LedgerIssueDetailSyncJob {
    id: string;
    adapter: string;
    direction: string;
    status: string;
    attempt_count: number;
    started_at: number | null;
    finished_at: number | null;
    last_error: string | null;
    updated_at: number;
}
export interface LedgerIssueDetailSyncSummary {
    state: "clean" | "pending" | "failed" | "conflicted";
    outbox: Record<string, number>;
    open_conflicts: number;
    latest_jobs: LedgerIssueDetailSyncJob[];
}
export interface LedgerIssueDetailProjection {
    id: string;
    display_id: string;
    project: LedgerIssueDetailProject;
    title: string;
    body: string;
    status: LedgerIssueStatus;
    resolution: LedgerIssueResolution | null;
    kind: LedgerIssueKind;
    priority: LedgerPriority;
    source: LedgerEventSource;
    author: LedgerIssueDetailActor;
    created_at: number;
    updated_at: number;
    closed_at: number | null;
    aliases: LedgerIssueDetailAlias[];
    labels: string[];
    comments: LedgerIssueDetailComment[];
    timeline: LedgerIssueTimelineEntry[];
    relationships: LedgerIssueDetailRelationship[];
    work_units: LedgerIssueDetailWorkUnit[];
    sessions: LedgerIssueDetailSession[];
    auth_requests: LedgerIssueDetailAuthRequest[];
    conflicts: LedgerIssueDetailConflict[];
    sync: LedgerIssueDetailSyncSummary;
}
export declare function buildLedgerIssueDetailProjection(db: Db, issueId: string): LedgerIssueDetailProjection;
