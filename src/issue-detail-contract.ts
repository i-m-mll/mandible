import type { ArtifactRecord, WorkUnit, WorkUnitLiveness } from "./contracts.js";
import type { AttributionReadProjection, ReadUserIdentity } from "./identity/contracts.js";
import type {
  LedgerActorType, LedgerEventSource, LedgerIssueBranchRole, LedgerIssueKind,
  LedgerIssueResolution, LedgerIssueStatus, LedgerPriority,
  LedgerRelationshipProvenance, LedgerRelationshipType, LedgerWorkerStatus,
} from "./ledger/types.js";

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
  legacy_display: string;
  attribution: AttributionReadProjection | null;
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

export interface LedgerIssueDetailCheckpoint {
  id: string;
  issue_id: string;
  kind: string;
  payload: unknown;
  author: LedgerIssueDetailActor;
  source: LedgerEventSource;
  created_at: number;
}

export interface LedgerIssueDetailBranch {
  branch: string;
  role: LedgerIssueBranchRole;
  created_at: number;
  updated_at: number;
}

export type LedgerIssueTimelineEntry =
  | {
      id: string;
      kind: "body";
      ordinal: 0;
      body: string;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      updated_at: number | null;
    }
  | {
      id: string;
      kind: "comment";
      comment_id: string;
      ordinal: number;
      body: string;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      updated_at: number | null;
    }
  | {
      id: string;
      kind: "state";
      event_type: string;
      status: LedgerIssueStatus | null;
      resolution: LedgerIssueResolution | null;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      payload: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "event";
      event_type: string;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
      payload: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "checkpoint";
      checkpoint_id: string;
      checkpoint_kind: string;
      payload: unknown;
      author: LedgerIssueDetailActor;
      source: LedgerEventSource;
      created_at: number;
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

export interface LedgerIssueWorkMetadata {
  work_notes: string;
  work_notes_revision: string | null;
  dependencies: LedgerIssueSummaryRef[];
  dependency_warning: boolean;
}

export interface LedgerIssueDetailRelationship {
  id: string;
  direction: "incoming" | "outgoing";
  relationship_type: LedgerRelationshipType;
  link_type: LedgerRelationshipType;
  provenance: LedgerRelationshipProvenance;
  note: string | null;
  confidence: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  related_issue: LedgerIssueSummaryRef | null;
}

export interface LedgerIssueDetailProject {
  id: string;
  // Issue: 3d85f43 — stable canonical project slug, independent of display_name
  // and of the path-derived WorkScanner work_repo_id.
  project_key: string | null;
  display_name: string;
  remote_identity: string;
  upstream_identity: string;
  repo_id: string | null;
  // The path-derived WorkScanner id for the representative checkout. Local
  // discovery metadata only; surfaced so auth-queue/work-unit matching (which
  // keys off this id) keeps working now that repo_id is the canonical key.
  work_repo_id: string | null;
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
  owner: ReadUserIdentity | null;
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
  requester: ReadUserIdentity | null;
  approver: ReadUserIdentity | null;
  execution_evidence: AttributionReadProjection | null;
  link_type: string;
  link_source: string;
  link_created_at: number | null;
  metadata: Record<string, unknown>;
}

export interface LedgerIssueDetailArtifactLink {
  id: string;
  entity_type: string;
  entity_id: string;
  link_type: string;
  role: string | null;
  repo_id: string | null;
  provider_id: string | null;
  source: string;
  metadata: Record<string, unknown>;
  link_kind: "pinned" | "living";
  series_id: string | null;
  series_ref: string | null;
  resolved_version_no: number | null;
  target_type: "artifact" | "artifact_version" | "artifact_blob" | null;
  target_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface LedgerIssueDetailAssociatedArtifact extends Pick<
  ArtifactRecord,
  "id" | "algorithm" | "content_hash" | "uri" | "media_type" | "role" |
  "provider_id" | "manifest_id" | "custody_mode" | "availability" | "created_at"
> {
  ref: string;
  /** Human-facing logical identity, when the association resolves beyond bare bytes. */
  title: string | null;
  logical_name: string | null;
  pin_state: "pinned" | "living";
  is_latest: boolean | null;
  resolved_version_no: number | null;
  series_id: string | null;
  warnings: string[];
  refs: string[];
  links: LedgerIssueDetailArtifactLink[];
}

export interface LedgerIssueDetailProjection {
  id: string;
  display_id: string;
  project: LedgerIssueDetailProject;
  title: string;
  body: string;
  work_notes: string;
  work_notes_revision: string | null;
  status: LedgerIssueStatus;
  worker_status: LedgerWorkerStatus;
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
  issue_branches: LedgerIssueDetailBranch[];
  comments: LedgerIssueDetailComment[];
  checkpoints: LedgerIssueDetailCheckpoint[];
  timeline: LedgerIssueTimelineEntry[];
  relationships: LedgerIssueDetailRelationship[];
  dependencies: LedgerIssueSummaryRef[];
  dependency_warning: boolean;
  work_units: LedgerIssueDetailWorkUnit[];
  sessions: LedgerIssueDetailSession[];
  auth_requests: LedgerIssueDetailAuthRequest[];
  associated_artifacts: LedgerIssueDetailAssociatedArtifact[];
  detail_stage: "initial" | "full";
  timeline_partial: boolean;
}

