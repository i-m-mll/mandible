import { z } from "zod";
import { SPACE_EVENTS, SPACE_EVENT_VALUES } from "./spaces/events.js";
// Shared API/UI contracts. Keep this module dependency-light so daemon and
// browser UI code can import its types without dragging in runtime services.

// The transcript vocabularies belong to the parser contract; re-export them so
// daemon and UI read one definition.
import type { BlockType, ConversationSource, Role } from "./parsers/types.js";

export type { BlockType, ConversationSource, Role };

// Route handlers still name their list payload after the resource. Declare the
// accepted keys once so producers, the union type, and the client normalizer
// cannot drift apart.
export const LIST_ENVELOPE_KEYS = [
  "items",
  "sessions",
  "queue",
  "requests",
  "repos",
  "branches",
  "work_units",
  "hooks",
  "artifacts",
  "conversations",
  "templates",
] as const;

export type ListEnvelopeKey = (typeof LIST_ENVELOPE_KEYS)[number];

export type ApiListEnvelope<T> = {
  items: T[];
  total?: number;
  offset?: number;
  limit?: number;
};

export type LegacyListEnvelope<T> = Partial<Record<ListEnvelopeKey, T[]>> &
  Omit<Partial<ApiListEnvelope<T>>, "items">;

export type ApiList<T> = T[] | ApiListEnvelope<T> | LegacyListEnvelope<T>;

export const DOMAIN_EVENTS = Object.freeze({
  AUTH_AUTO_APPROVE: "auth:auto-approve",
  AUTH_COMPLETED: "auth:completed",
  AUTH_CONVERGENCE: "auth:convergence",
  AUTH_FINALIZED: "auth:finalized",
  AUTH_LIFECYCLE: "auth:lifecycle",
  AUTH_MERGED: "auth:merged",
  AUTH_NEEDS_REBASE: "auth:needs_rebase",
  AUTH_NEW: "auth:new",
  AUTH_OUTPUT: "auth:output",
  AUTH_RESOLVED: "auth:resolved",
  AUTH_UPDATED: "auth:updated",
  CHANNEL_SESSION_CONNECTED: "channel:session:connected",
  CHANNEL_SESSION_DISCONNECTED: "channel:session:disconnected",
  CONSOLE_ATTENTION: "console:attention",
  CONSOLE_INBOX_BADGE: "console:inbox:badge",
  CONSOLE_PERMISSION_CLEARED: "console:permission:cleared",
  CONSOLE_PERMISSION_REQUEST: "console:permission:request",
  CONSOLE_SESSION_CREATED: "console:session:created",
  CONSOLE_SESSION_DELETED: "console:session:deleted",
  CONSOLE_SESSION_ENDED: "console:session:ended",
  CONSOLE_SESSION_EXIT: "console:session:exit",
  CONSOLE_SESSION_STARTED: "console:session:started",
  CONSOLE_SESSION_STOPPED: "console:session:stopped",
  CONSOLE_SESSION_UPDATED: "console:session:updated",
  CONSOLE_STREAM_EVENT: "console:stream_event",
  CONSOLE_SUBAGENT_START: "console:subagent:start",
  CONSOLE_SUBAGENT_STOP: "console:subagent:stop",
  CONSOLE_TELEMETRY: "console:telemetry",
  CONVERSATION_SPAWN_UPDATED: "conversation-spawn:updated",
  CONVERSATION_CONTROL_UPDATED: "conversation:control-updated",
  CONVERSATION_NEW: "conversation:new",
  CONVERSATION_PROVIDER_EVENT: "conversation:provider-event",
  CONVERSATION_UPDATED: "conversation:updated",
  DAEMON_RELOADED: "daemon:reloaded",
  HEARTBEAT: "heartbeat",
  MANDIBLE_REBUILDING: "mandible:rebuilding",
  PUSH_AUTH_COMPLETE: "push:auth:complete",
  PUSH_AUTH_PENDING: "push:auth:pending",
  PUSH_COMPLETE: "push:complete",
  PUSH_ERROR: "push:error",
  PUSH_REPO_COMPLETE: "push:repo:complete",
  PUSH_REPO_PROGRESS: "push:repo:progress",
  PUSH_STARTED: "push:started",
  REAPER_TICK: "reaper:tick",
  SESSION_CHILD_ADDED: "session:child:added",
  SESSION_CHILD_ENDED: "session:child:ended",
  SESSION_DISCOVERY_COMPLETED: "session:discovery:completed",
  SESSION_ENDED: "session:ended",
  SESSION_METADATA_WARNING: "session:metadata-warning",
  SESSION_REGISTERED: "session:registered",
  SESSION_UPDATED: "session:updated",
  WEBHOOK_DELIVERED: "webhook:delivered",
  WEBHOOK_DISMISSED: "webhook:dismissed",
  WEBHOOK_RECEIVED: "webhook:received",
  WORK_BRANCH_UPDATED: "work:branch:updated",
  WORK_SCAN_COMPLETED: "work:scan:completed",
  WORK_SCAN_STARTED: "work:scan:started",
  WORKFLOW_UPDATED: "workflow:updated",
} as const);

export type MandibleEventType = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS]
  | BriefingEvent | import("./spaces/events.js").SpaceEvent
  | (typeof USER_SETTING_EVENTS)[keyof typeof USER_SETTING_EVENTS]
  | (typeof OPERATIONAL_INCIDENT_EVENTS)[keyof typeof OPERATIONAL_INCIDENT_EVENTS]
  | (typeof TASK_INVENTORY_EVENTS)[keyof typeof TASK_INVENTORY_EVENTS]
  | (typeof TASK_COMMAND_EVENTS)[keyof typeof TASK_COMMAND_EVENTS]
  | (typeof MANAGED_REMINDER_EVENTS)[keyof typeof MANAGED_REMINDER_EVENTS];

export type EventPayload<E extends MandibleEventType> =
  E extends `briefing:group-${string}` ? { group_id: string; [key: string]: unknown }
  : E extends `briefing:bundle-${string}` ? { bundle_id: string; [key: string]: unknown }
  : E extends BriefingEvent ? { briefing_id: string; round_id?: string | null; [key: string]: unknown }
  : E extends typeof SPACE_EVENTS.SPACE_DOCUMENT_SETTINGS_UPDATED ? { scope: "repo" | "global"; repo_id: string | null }
  : E extends import("./spaces/events.js").SpaceEvent ? { space_id: string; [key: string]: unknown }
  : E extends typeof DOMAIN_EVENTS.CONVERSATION_UPDATED ? { id: string; [key: string]: unknown }
  : E extends typeof DOMAIN_EVENTS.HEARTBEAT ? { timestamp: number }
  : unknown;

export type MandibleEvent<E extends MandibleEventType = MandibleEventType> = E extends MandibleEventType ? {
  type: E;
  event?: E;
  data: EventPayload<E>;
  timestamp?: string;
} : never;

export type SSEEvent<E extends MandibleEventType = MandibleEventType> = MandibleEvent<E> & { timestamp: string };
export type SseEvent<E extends MandibleEventType = MandibleEventType> = E extends MandibleEventType ? {
  event: E;
  type?: E;
  data: EventPayload<E>;
} : never;

export const USER_SETTING_KEYS = Object.freeze({
  appRailOrder: "app_rail_order",
  uiFontFace: "ui_font_face",
  uiFontSize: "ui_font_size",
  detailFontFace: "detail_font_face",
  detailFontSize: "detail_font_size",
} as const);
export type UserSettingKey = (typeof USER_SETTING_KEYS)[keyof typeof USER_SETTING_KEYS];

export type ChatEntityClickAction = "preview" | "open";

export const USER_SETTING_EVENTS = Object.freeze({
  updated: "user-setting:updated",
} as const);
export type UserSettingUpdatedEvent = {
  version: 1;
  key: UserSettingKey;
  revision: number;
};

export type SidebarOrderPreferenceValue = {
  pinnedConversationIds: string[] | null;
  briefingTopLevelIds: string[] | null;
};

export type SidebarOrderPreference = {
  version: 1;
  key: "sidebar_order";
  value: SidebarOrderPreferenceValue;
  revision: number;
};

export type AuthRequestStatus =
  | "pending"
  | "executing"
  | "approved"
  | "needs_rebase"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "expired"
  | "completed"
  | "dismissed";

export type AuthRequestOutcome =
  | "succeeded"
  | "failed"
  | "needs_rebase"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "dismissed"
  | "expired"
  | null;

export type AuthDependencyReadiness =
  | "ready"
  | "pending"
  | "failed"
  | "unfinalized"
  | "missing"
  | "ambiguous";

export type AuthDependencyProjection = {
  state: AuthDependencyReadiness;
  requested_id: string;
  request_id: string | null;
  status: AuthRequestStatus | null;
  outcome: AuthRequestOutcome;
  exit_code: number | null;
  merge_finalized_at: number | null;
};

export function isAuthDependencyReady(
  dependency: AuthDependencyProjection | null | undefined,
): boolean {
  return dependency?.state === "ready";
}

/**
 * Bug 93c57c4 — derive the terminal outcome from lifecycle status plus exit
 * code at read time. `status` is the lifecycle; `outcome` is the result.
 *
 * This lived as two byte-equivalent private copies, in `auth-queue.ts` (which
 * fills the `auth:resolved` SSE payload agents wait on) and `routes/inbox.ts`
 * (which fills the session inbox). Both ended in a silent `default: return
 * null`, and `null` means "still in lifecycle" — so a new terminal
 * `AuthRequestStatus` would have made a finished request report as in-flight
 * forever, through both surfaces, with no compile error in either. Verified:
 * adding a status variant produced zero `tsc` errors repo-wide.
 *
 * One definition, and the `default` now binds `status` to `never`, so the next
 * variant is a compile error here instead of a hang there.
 */
export function computeAuthRequestOutcome(
  status: AuthRequestStatus,
  exitCode: number | null,
): AuthRequestOutcome {
  switch (status) {
    case "rejected":
      return "rejected";
    case "withdrawn":
      return "withdrawn";
    case "superseded":
      return "superseded";
    case "dismissed":
      return "dismissed";
    case "expired":
      return "expired";
    case "needs_rebase":
      return "needs_rebase";
    case "completed":
      return exitCode === 0 ? "succeeded" : "failed";
    case "pending":
    case "executing":
    case "approved":
      // Genuinely still in lifecycle — the one honest `null`.
      return null;
    default: {
      const _never: never = status;
      void _never;
      return null;
    }
  }
}

export type AuthExecutionMode = "daemon" | "remote";
export const AUTH_REQUEST_TYPES = [
  "merge", "commit", "force-push", "branch-delete", "config-change", "data-delete",
] as const;
export type AuthRequestType = (typeof AUTH_REQUEST_TYPES)[number];

export const AUTH_CHANGE_REPORT_FILE_ROLE_PRECEDENCE = [
  "fixtures_data",
  "tests",
  "documentation",
  "configuration",
  "implementation",
  "other",
] as const;

export type AuthChangeFileRole =
  (typeof AUTH_CHANGE_REPORT_FILE_ROLE_PRECEDENCE)[number];
export type AuthChangeFileType = "blob" | "symlink" | "gitlink" | "absent";
export type AuthChangeKind =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "type_changed";

export type AuthChangeFile = {
  old_path: string | null;
  new_path: string | null;
  change_kind: AuthChangeKind;
  file_type_before: AuthChangeFileType;
  file_type_after: AuthChangeFileType;
  additions: number | null;
  deletions: number | null;
  bytes_before: number | null;
  bytes_after: number | null;
  language: string;
  file_role: AuthChangeFileRole;
  generated: boolean;
  vendor: boolean;
};

/**
 * Immutable server-captured inventory for one reviewed merge candidate.
 * Null on an AuthRequest means unavailable (legacy request or non-merge),
 * never an empty or freshly recomputed report.
 */
export type AuthChangeReport = {
  schema: "mandible-auth-change-report@1";
  classifier_version: "mandible-auth-change-classifier@1";
  rules_version: "mandible-auth-change-rules@1";
  comparison: {
    base_sha: string;
    head_sha: string;
    merge_base_sha: string;
  };
  rename_similarity_percent: 50;
  totals: {
    files: number;
    additions: number;
    deletions: number;
    text_files: number;
    binary_files: number;
  };
  files: AuthChangeFile[];
};
/**
 * The staged auth-action vocabulary, declared once as a value.
 *
 * `AuthRequestActionKind` is derived from this array, so the runtime validator
 * (`auth-actions.ts`) and the type cannot disagree about which kinds exist —
 * previously they were two hand-maintained lists in three files. The SQL
 * `CHECK(kind IN (...))` in `db-baseline.ts` is a fourth representation that
 * cannot import a TypeScript value; `test/auth-action-kind-contract.test.ts`
 * pins it to this array instead.
 *
 * This module is deliberately dependency-light so the UI can import it.
 */
export const AUTH_REQUEST_ACTION_KINDS = [
  "comment_add",
  "issue_close",
  "worker_status_set",
  "label_add",
  "label_rm",
  "checkpoint_add",
  "link_add",
  "briefing_group_promote",
] as const;
export type AuthRequestActionKind = (typeof AUTH_REQUEST_ACTION_KINDS)[number];
export type AuthRequestActionState = "staged" | "applied" | "failed" | "skipped_stale" | "vetoed";

export type AuthRequestActionInput = {
  kind: AuthRequestActionKind;
  target_issue_ref: string;
  payload: Record<string, unknown>;
};

export type AuthRequestAction = AuthRequestActionInput & {
  id: string;
  auth_request_id: string;
  ordinal: number;
  state: AuthRequestActionState;
  target_digest: string | null;
  staged_at: number;
  updated_at: number;
  applied_at: number | null;
  outcome_detail: string | null;
};

export type AuthRequest = {
  id: string;
  session_id: string | null;
  type: AuthRequestType;
  command: string;
  title: string;
  cwd: string | null;
  diff_summary: string | null;
  commit_message: string | null;
  /** Issue 7d64d8f — SHA-256 of the canonical change message bytes, or null. */
  commit_message_digest?: string | null;
  spec_content: string | null;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  merge_head_sha?: string | null;
  merge_preflight_base_sha?: string | null;
  merge_preflight_queue_fingerprint?: string | null;
  merge_finalized_at?: number | null;
  change_report?: AuthChangeReport | null;
  files_changed?: number;
  additions?: number;
  deletions?: number;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  issue_ids?: string[] | null;
  issues?: string[] | null;
  depends_on_id?: string | null;
  dependency?: AuthDependencyProjection | null;
  execution_mode: AuthExecutionMode;
  status: AuthRequestStatus;
  created_at: number;
  updated_at: number;
  last_executed_at: number | null;
  approved_at: number | null;
  resolved_at: number | null;
  skipped_at: number | null;
  expires_at: number;
  exit_code: number | null;
  output: string;
  error: string | null;
  acknowledged_by: string | null;
  target_session_id: string | null;
  target_repo_root: string | null;
  delivered_at: number | null;
  conversation_id: string | null;
  approval_source: "manual" | "auto_lease" | string;
  approval_lease_id: string | null;
};

export type AuthOutputChunk = {
  request_id: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
};

export type WorkUnitKind = "solo" | "partition" | "integration";
export type WorkUnitState = "open" | "committed" | "resolved" | "abandoned";

export type WorkUnit = {
  id: string;
  issue_id: string;
  ledger_issue_id: string | null;
  repo_id: string;
  branch: string | null;
  parent_branch: string | null;
  kind: WorkUnitKind;
  state: WorkUnitState;
  assigned_session_id: string | null;
  provider: string | null;
  provider_session_id: string | null;
  worker_provider_session_id: string | null;
  continuation: string | null;
  continuation_by: string | null;
  continuation_at: number | null;
  created_at: number;
  activated_at: number | null;
  last_commit_at: number | null;
  resolved_at: number | null;
  auth_request_id: string | null;
  owner_user_id: string | null;
  owner_credential_id: string | null;
  custody_generation: number;
};

export type WorkUnitLiveness = {
  has_live_agent: boolean;
  agent_session_id: string | null;
  agent_status: string | null;
  is_processing: boolean;
  last_activity: number | null;
};

export type WorkUnitWithLiveness = WorkUnit & {
  liveness: WorkUnitLiveness;
};

export type {
  AcceptedConversationSubmission,
  ControllerOwnership,
  ControllerState,
  ConversationContinuationCapability,
  ConversationControlError,
  ConversationControlOperation,
  ConversationRuntimeOptions,
  ConversationControlSnapshot,
  ConversationSubmitRequest,
  ProviderAdapterCapabilities,
  ProviderAdapterEvent,
  ProviderAdapterMode,
  ProviderDeliveryReceipt,
  ProviderLiveProjection,
  TurnState,
} from "./conversation-control/types.js";

export type {
  ConversationSpawnError,
  ConversationSpawnProvider,
  ConversationSpawnReceipt,
  ConversationSpawnRequest,
  ConversationSpawnState,
} from "./conversation-spawn/types.js";


export type StoredConversationBlock = {
  id: string;
  conversation_id: string;
  type: BlockType;
  role: Role;
  content: string;
  position: number;
  timestamp: string;
  parent_id: string | null;
  metadata_json: string;
  dag_uuid?: string | null;
  dag_parent_uuid?: string | null;
  /** False when a display projection intentionally omits large block details. */
  details_loaded?: boolean;
};

export type ConversationExternalNavigation =
  | {
      kind: "codex-desktop-task";
      provider_session_id: string;
      label: "Open in Codex";
    }
  | {
      kind: "claude-native-background";
      provider_session_id: string;
      session_id: string;
      terminal: "iterm";
      label: "Go to terminal";
    };

export type Conversation = {
  id: string;
  source: ConversationSource;
  source_path: string;
  title: string;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  block_count: number;
  session_id: string;
  project_path: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  cli_version: string | null;
  is_sidechain: boolean;
  agent_id: string | null;
  starred: boolean;
  archived_at?: number | null;
  tags: string[];
  notes: string | null;
  parent_conversation_id: string | null;
  children_count: number;
  /**
   * Server-projected exact navigation. Absence means that no external action
   * was proven for this conversation; clients must not infer one from source.
   */
  external_navigation?: ConversationExternalNavigation;
};

export type ConversationChild = {
  id: string;
  title: string;
  block_count: number;
  started_at: string;
  ended_at: string | null;
  source: string;
  model: string | null;
  agent_id: string | null;
  is_sidechain: boolean;
  status: "active" | "finished";
  duration_seconds: number | null;
};

export type ConversationParent = {
  id: string;
  title: string;
};

export type ConversationPositionTargetKind = "initial" | "latest" | "position" | "block" | "turn";

export type ConversationPositionTarget = {
  kind: ConversationPositionTargetKind;
  requested_value: string | number | null;
  position: number | null;
  block_id: string | null;
  turn_id: string | null;
};

export type ConversationPositionWindow = {
  conversation: Conversation;
  body_source: "source" | "legacy";
  source_version_id: string | null;
  children: ConversationChild[];
  parent: ConversationParent | null;
  revision: number;
  total: number;
  target: ConversationPositionTarget;
  window: {
    start_position: number | null;
    end_position: number | null;
    has_before: boolean;
    has_after: boolean;
    after_count: number;
    limit: number;
  };
  blocks: StoredConversationBlock[];
};

export type ConversationStructure = {
  conversation_id: string;
  source_version_id: string | null;
  total: number;
  rows: Array<{
    id: string;
    position: number;
    type: string;
    role: string;
    parent_position: number | null;
    record_offset: number | null;
    record_length: number;
  }>;
};

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "warning";
export type WorkflowWorkerStatus = "pending" | "running" | "completed" | "failed" | "warning";

export type WorkflowWarning = {
  code: string;
  message: string;
  path?: string;
};

export type WorkflowPhase = {
  id: string;
  workflow_id: string;
  phase_index: number;
  title: string;
  status: WorkflowRunStatus;
  worker_count: number;
  completed_count: number;
};

export type WorkflowWorker = {
  id: string;
  workflow_id: string;
  phase_id: string | null;
  worker_index: number;
  agent_id: string | null;
  label: string;
  status: WorkflowWorkerStatus;
  model: string | null;
  queued_at: number | null;
  started_at: number | null;
  last_progress_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  tokens: number | null;
  tool_calls: number | null;
  last_tool_name: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  result_preview: string | null;
  transcript_path: string | null;
  conversation_id: string | null;
  warnings: WorkflowWarning[];
};

export type WorkflowRun = {
  id: string;
  provider: "claude_code";
  provider_run_id: string;
  session_id: string;
  project_path: string | null;
  summary_path: string;
  script_path: string | null;
  workflow_name: string;
  status: WorkflowRunStatus;
  started_at: number | null;
  updated_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  total_tokens: number | null;
  total_tool_calls: number | null;
  agent_count: number;
  completed_workers: number;
  total_workers: number;
  format_version: string;
  warnings: WorkflowWarning[];
  phases: WorkflowPhase[];
  workers: WorkflowWorker[];
};

export type WorkflowListResponse = { workflows: WorkflowRun[] };
export type WorkflowResponse = { workflow: WorkflowRun };

export type ArtifactAliasResolutionStatus = "resolved" | "unresolved" | "ambiguous" | "unsupported";

export type ArtifactAliasRecord = {
  id: string;
  blob_id: string | null;
  /** Historical HTTP projection; internal aliases carry blob_id. */
  artifact_id?: string | null;
  scheme: string;
  alias: string;
  normalized_ref: string;
  locator: Record<string, unknown>;
  resolution_status: ArtifactAliasResolutionStatus;
  source: string;
  created_at: number;
  updated_at: number;
};

export type ArtifactLinkRecord = {
  id: string;
  artifact_id: string;
  entity_type: string;
  entity_id: string;
  link_type: string;
  role: string | null;
  repo_id: string | null;
  provider_id: string | null;
  source: string;
  metadata: Record<string, unknown>;
  // Typed-link columns (migration v89, issue 10960ea). Canonical name is
  // `link_kind` (not `link_mode`). `pinned` (default) names one immutable
  // artifact version; `living` tracks a series head via `series_id`/`series_ref`
  // (both null for pinned links).
  link_kind: "pinned" | "living";
  series_id: string | null;
  series_ref: string | null;
  created_at: number;
  updated_at: number;
};

export type ArtifactRecord = {
  id: string;
  algorithm: string;
  content_hash: string;
  uri: string;
  media_type: string | null;
  role: string | null;
  size_bytes: number;
  provider_id: string | null;
  manifest_id: string | null;
  metadata: Record<string, unknown>;
  pinned: boolean;
  custody_mode: "git" | "managed" | null;
  home_repo_id: string | null;
  repo_locator: Record<string, unknown>;
  availability: "present" | "missing" | "stale" | "unchecked" | "remote_only" | "pinned";
  retention: Record<string, unknown>;
  reference: Record<string, unknown>;
  created_at: number;
  alias_schemes?: string[];
  aliases?: ArtifactAliasRecord[];
  links?: ArtifactLinkRecord[];
};

export type ArtifactIdentitySourceKind =
  | "tracked_repo"
  | "local_only"
  | "managed"
  | "external"
  | "mixed";

export type ArtifactBlobRecord = {
  id: string;
  algorithm: string;
  content_hash: string;
  storage_uri: string | null;
  media_type: string | null;
  role: string | null;
  size_bytes: number;
  provider_id: string | null;
  manifest_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
};

export type ArtifactIdentityRecord = {
  id: string;
  identity_key: string;
  source_kind: ArtifactIdentitySourceKind;
  title: string | null;
  source_project_id: string | null;
  source_repo_id: string | null;
  logical_name: string | null;
  source_path: string | null;
  latest_version_id: string | null;
  version_count: number;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type CanonicalArtifactVersionRecord = {
  id: string;
  artifact_id: string;
  version_no: number;
  blob_id: string;
  source_kind: Exclude<ArtifactIdentitySourceKind, "mixed">;
  content_hash: string;
  source_project_id: string | null;
  repo_path: string | null;
  commit_sha: string | null;
  observed_path: string | null;
  parent_version_id: string | null;
  custody_mode: "git" | "managed";
  label: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
};

export type Artifact = ArtifactIdentityRecord;
export type ArtifactVersion = CanonicalArtifactVersionRecord;

export type ProjectArtifactAssociationRecord = {
  id: string;
  project_id: string;
  target_type: "artifact" | "artifact_version";
  target_id: string;
  association_kind: "associated" | "canonical";
  role: string;
  title: string | null;
  description: string | null;
  rank: number | null;
  status: "active" | "superseded" | "archived";
  source: "user" | "agent_explicit" | "space_rule" | "migration" | "system";
  source_ref_type: string | null;
  source_ref_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type ProjectArtifactAssociation = ProjectArtifactAssociationRecord;

export type ArtifactVersionSourceKind = "tracked_repo" | "local_only" | "managed";
export type ArtifactSeriesSourceKind = ArtifactVersionSourceKind | "mixed";

export type ArtifactSeriesRecord = {
  id: string;
  series_key: string;
  source_kind: ArtifactSeriesSourceKind;
  title: string | null;
  repo_id: string | null;
  logical_name: string | null;
  latest_version_id: string | null;
  version_count: number;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type ArtifactVersionRecord = {
  id: string;
  series_id: string;
  artifact_id: string;
  version_no: number;
  parent_version_id: string | null;
  source_kind: ArtifactVersionSourceKind;
  content_hash: string;
  commit_sha: string | null;
  repo_path: string | null;
  observed_path: string | null;
  custody_mode: string | null;
  label: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
};

export type CanonicalArtifactTargetType = "artifact" | "artifact_version" | "artifact_blob";
export type ArtifactIdentityKind = "logical" | "pinned-version" | "blob";
export type ArtifactRequestedKind = ArtifactIdentityKind | "alias" | "series" | "unknown";

interface ArtifactIdentityBase {
  ref: string;
  scheme: string;
  normalized_ref: string;
  warnings: string[];
  alias: ArtifactAliasRecord | null;
}

export type ResolvedArtifactIdentity = ArtifactIdentityBase & { status: "resolved" } & (
  | { kind: "logical"; target_type: "artifact"; target_id: string;
      logical_artifact: ArtifactIdentityRecord } & (
      | { artifact_version: CanonicalArtifactVersionRecord; artifact_blob: ArtifactBlobRecord }
      | { artifact_version: null; artifact_blob: null })
  | { kind: "pinned-version"; target_type: "artifact_version"; target_id: string;
      logical_artifact: ArtifactIdentityRecord; artifact_version: CanonicalArtifactVersionRecord;
      artifact_blob: ArtifactBlobRecord }
  | { kind: "blob"; target_type: "artifact_blob"; target_id: string;
      logical_artifact: null; artifact_version: null; artifact_blob: ArtifactBlobRecord }
);

export interface FailedArtifactIdentity extends ArtifactIdentityBase {
  status: "unresolved" | "ambiguous" | "unsupported";
  kind: "unresolved" | "ambiguous" | "unsupported";
  requested_kind: ArtifactRequestedKind;
  target_type: CanonicalArtifactTargetType | null;
  target_id: null;
  logical_artifact: ArtifactIdentityRecord | null;
  artifact_version: null;
  artifact_blob: null;
}

export type ArtifactIdentityResolution = ResolvedArtifactIdentity | FailedArtifactIdentity;

export type ArtifactCustody =
  | { kind: "git"; project_id: string; commit: string; path: string; hash: string }
  | { kind: "managed"; storage_uri: string; hash: string };

export interface ArtifactMaterializationTarget {
  id: string;
  version_id: string | null;
  blob: ArtifactBlobRecord;
  custody: ArtifactCustody;
  metadata: Record<string, unknown>;
}

export type ArtifactMaterializationError = {
  code: "unknown_reference" | "unavailable_material" | "ambiguous_source" | "invalid_custody" | "hash_mismatch" | "size_limit";
  message: string;
};
export type ArtifactMaterializationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ArtifactMaterializationError };

/** Provider HTTP projection retained for historical and external consumers. */
export type ArtifactResolveResult = ArtifactIdentityResolution & {
  artifact: ArtifactRecord | null;
  series: ArtifactSeriesRecord | null;
  version: ArtifactVersionRecord | null;
};

export type ArtifactSeriesSummary = {
  id: string;
  ref: string;
  series_key: string;
  source_kind: ArtifactSeriesSourceKind;
  title: string | null;
  repo_id: string | null;
  logical_name: string | null;
  latest_version_id: string | null;
  version_count: number;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  latest_version: ArtifactVersionRecord | null;
  latest_artifact: ArtifactRecord | null;
  links: ArtifactLinkRecord[];
};

export type ArtifactDraftRecord = {
  id: string;
  series_id: string;
  base_version_id: string;
  base_version_no: number;
  latest_version_id: string | null;
  latest_version_no: number | null;
  stale: boolean;
  content: string;
  media_type: string | null;
  label: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type ArtifactVersionWriteResult = Extract<ResolvedArtifactIdentity, { kind: "pinned-version" }> & {
  created: boolean;
};
export type ArtifactDraftWriteResult = { draft: ArtifactDraftRecord; result: ArtifactVersionWriteResult };

export type ArtifactVersionRecordResult = ArtifactVersionWriteResult & {
  series: ArtifactSeriesRecord;
  version: ArtifactVersionRecord;
  artifact: ArtifactRecord;
  created: boolean;
  warnings: string[];
};

export type ArtifactDraftPublishResult = {
  draft: ArtifactDraftRecord;
  result: ArtifactVersionRecordResult;
};

// ---------------------------------------------------------------------------
// Spaces (umbrella de56ffa) — shared records, request/response envelopes, and
// the seed/block/export contract surface.
//
// These types mirror the FROZEN C2 route shapes (`src/routes/spaces.ts` over
// `src/ledger/spaces.ts`). They are declared structurally here, in the
// dependency-light shared module, so daemon route code and browser UI code can
// import one contract without pulling the ledger storage layer into the bundle.
//
// The backend record types in `src/ledger/spaces.ts` are the source of truth;
// the record shapes below are kept structurally identical to them and are
// compile-checked against that module by the contract tests. The `SpaceBlock`
// (C11) and `SpaceExport` (C13a) records mirror the planned `space_blocks` /
// `space_exports` schemas (docs/spaces UMBRELLA-PLAN §3.5 and
// DOCUMENT-CUSTODY-DESIGN §2.1); those routes are added by later children and
// MUST consume these types rather than re-declaring them.
// ---------------------------------------------------------------------------

/** Space-level renderer. `document` is only valid at the Space level (occurrences use the narrower {@link SpaceOccurrenceRenderer}). */
export type SpaceRenderer = 'canvas' | 'document' | 'board' | 'collection';
/** Occurrence-level renderer. `document` is intentionally excluded — document structure lives in {@link SpaceBlock}, not occurrences. */
export type SpaceOccurrenceRenderer = 'canvas' | 'board' | 'collection';
export type SpaceItemRefType = 'issue' | 'comment' | 'artifact' | 'external_ref' | 'space';

export const SPACE_RENDERERS: readonly SpaceRenderer[] = ['canvas', 'document', 'board', 'collection'];
export const SPACE_OCCURRENCE_RENDERERS: readonly SpaceOccurrenceRenderer[] = ['canvas', 'board', 'collection'];
export const SPACE_ITEM_REF_TYPES: readonly SpaceItemRefType[] = ['issue', 'comment', 'artifact', 'external_ref', 'space'];

export type Space = {
  id: string;
  /** Owning project, or `null` for a top-level / global Space (issue 812df41). */
  project_id: string | null;
  title: string;
  default_renderer: SpaceRenderer;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type SpaceItem = {
  id: string;
  space_id: string;
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type SpaceOccurrence = {
  id: string;
  space_id: string;
  item_id: string | null;
  renderer: SpaceOccurrenceRenderer;
  parent_id: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  z_index: number | null;
  sort_key: string | null;
  section_id: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type SpaceEdge = {
  id: string;
  space_id: string;
  source: string;
  target: string;
  label: string | null;
  style: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

/**
 * Document block (C11 `space_blocks`). Mirrors the planned schema at
 * docs/spaces/UMBRELLA-PLAN.md §3.5. An `item_id` embed ALWAYS carries an
 * `item_snapshot_json` placeholder (DB-level invariant) so it degrades to a
 * resolvable node when the embedded item is deleted.
 */
export type SpaceBlockType =
  | 'heading'
  | 'paragraph'
  | 'reference'
  | 'artifact_embed'
  | 'issue_embed'
  | 'comment_embed'
  | 'todo';

export type SpaceBlock = {
  id: string;
  space_id: string;
  parent_id: string | null;
  block_type: SpaceBlockType;
  item_id: string | null;
  /** Resolvable placeholder snapshot; non-null whenever `item_id` is set. */
  item_snapshot: Record<string, unknown> | null;
  sort_key: string;
  markdown: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

/**
 * Mutable export-tracking record (C13a `space_exports`). Mirrors the planned
 * schema at docs/spaces/DOCUMENT-CUSTODY-DESIGN.md §2.1. `authority` records who
 * owns the bytes; `status` is the drift state computed against live repo state.
 */
export type SpaceExportAuthority = 'mandible' | 'repo';
export type SpaceExportStatus = 'clean' | 'stale' | 'repo_changed' | 'worktree_dirty' | 'conflict';

export type SpaceExport = {
  id: string;
  space_id: string;
  /** References `ledger_project_checkouts.id` (the backed-up project-checkout identity), NOT `work_repos.id`. */
  repo_id: string;
  branch: string;
  path: string;
  authority: SpaceExportAuthority;
  status: SpaceExportStatus;
  last_export_artifact_id: string | null;
  pre_export_snapshot_artifact_id: string | null;
  last_export_commit: string | null;
  last_export_blob_sha: string | null;
  last_export_content_sha256: string | null;
  last_seen_commit: string | null;
  last_seen_content_sha256: string | null;
  created_at: number;
  updated_at: number;
};

// --- request bodies ---------------------------------------------------------

export type CreateSpaceRequest = {
  /** Owning project. Omit or pass `null` to create a top-level / global Space (issue 812df41). */
  project_id?: string | null;
  title: string;
  default_renderer?: SpaceRenderer;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateSpaceRequest = {
  title?: string;
  default_renderer?: SpaceRenderer;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export type AddSpaceItemRequest = {
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateSpaceItemRequest = {
  ref_uri?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
};

export type SpaceOccurrenceInput = {
  item_id?: string | null;
  renderer?: SpaceOccurrenceRenderer;
  parent_id?: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  z_index?: number | null;
  sort_key?: string | null;
  section_id?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreateSpaceOccurrenceRequest = SpaceOccurrenceInput;
export type UpdateSpaceOccurrenceRequest = SpaceOccurrenceInput;

/** One entry in a batch occurrence write; an `id` matching an existing occurrence updates it, otherwise it is created. */
export type BatchSpaceOccurrenceEntry = SpaceOccurrenceInput & { id?: string };

export type BatchSpaceOccurrenceRequest = {
  occurrences: BatchSpaceOccurrenceEntry[];
};

export type CreateSpaceEdgeRequest = {
  source: string;
  target: string;
  label?: string | null;
  style?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateSpaceEdgeRequest = {
  source?: string;
  target?: string;
  label?: string | null;
  style?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Seed request. The C2 route accepts the predicate under either `predicate` or
 * the legacy `scope` alias; the client helper sends `predicate`. The predicate
 * is the shared Timeline issue-predicate AST (`TimelineIssuePredicate`), kept as
 * an opaque object here so this contract module stays dependency-light.
 */
export type SeedSpaceRequest = {
  predicate: Record<string, unknown>;
  with_shelf_occurrences?: boolean;
  include_artifacts?: boolean;
};

// --- response envelopes -----------------------------------------------------

export type SpaceListResponse = { spaces: Space[] };

/**
 * One group in the grouped Spaces list (issue 812df41): a project (with id,
 * stable key, and name) or the top-level / global bucket (`project_id: null`,
 * `project_name: null`). `project_key` is the stable registry slug from
 * `ledger_projects.project_key` (null for the top-level group and for unresolvable
 * project rows). `project_name` is already disambiguated by the backend when
 * two project rows share the same `display_name` (issue 6fdd924).
 */
export type SpaceGroup = {
  project_id: string | null;
  /** Stable registry slug from `ledger_projects.project_key`, or null. */
  project_key: string | null;
  project_name: string | null;
  spaces: Space[];
};

/**
 * Grouped Spaces list response (`GET /api/spaces` with no `project_id`/`scope`,
 * issue 812df41). `groups` is the top-level group first (when non-empty) then one
 * group per owning project. `spaces` is every Space flattened across the groups so
 * existing flat-list callers keep working.
 */
export type SpaceGroupedListResponse = { groups: SpaceGroup[]; spaces: Space[] };
export type SpaceResponse = { space: Space };
export type DeleteSpaceResponse = { ok: true; id: string };

export type AddSpaceItemResponse = {
  item: SpaceItem;
  created: boolean;
  already_present: boolean;
};
export type SpaceItemResponse = { item: SpaceItem };
export type DeleteSpaceItemResponse = { ok: true; id: string };

export type SpaceOccurrenceResponse = { occurrence: SpaceOccurrence };
export type DeleteSpaceOccurrenceResponse = { ok: true; id: string };
export type BatchSpaceOccurrenceResponse = {
  occurrences: SpaceOccurrence[];
  created: number;
  updated: number;
};

export type SpaceEdgeResponse = { edge: SpaceEdge };
export type DeleteSpaceEdgeResponse = { ok: true; id: string };

/** One diagnostic emitted by predicate evaluation during seeding (opaque shape mirroring `TimelineDiagnostic`). */
export type SpaceSeedDiagnostic = Record<string, unknown>;

export type SeedSpaceResult = {
  matched_issue_ids: string[];
  items: SpaceItem[];
  items_created: number;
  items_existing: number;
  occurrences: SpaceOccurrence[];
  diagnostics: SpaceSeedDiagnostic[];
};

/** Read-only fact packet for a Space (items/occurrences/edges) as returned by `loadSpaceFactPacket`. */
export type SpaceFactPacket = {
  space: Space;
  items: SpaceItem[];
  occurrences: SpaceOccurrence[];
  edges: SpaceEdge[];
};

// --- unified ref resolver ---------------------------------------------------

export type ResolverRefKind = 'issue' | 'comment' | 'artifact' | 'mandible' | 'repo' | 'unknown';

export type ResolverResult = {
  ref: string;
  kind: ResolverRefKind;
  resolved: boolean;
  entity: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  error?: string;
};

export type ResolveRefResponse = { resolution: ResolverResult };

// --- Briefings: logical identity -> immutable artifact-backed rounds ---------

export type FeedbackResponseType = "verdict" | "single_choice" | "multi_choice" | "short_text" | "long_text" | "rating" | "text_variant";
export type FeedbackVerdictValue = { verdict: "keep" | "dismiss" };
export type FeedbackShortTextValue = { text: string };
export type FeedbackLongTextValue = { text: string };
export type FeedbackSingleChoiceValue = { option_key: string };
export type FeedbackMultiChoiceValue = { option_keys: string[] };
export type FeedbackRatingValue = { rating: number };
export type FeedbackTextVariantValue = { option_key: string };
export type FeedbackResponseValue = FeedbackVerdictValue | FeedbackShortTextValue | FeedbackLongTextValue
  | FeedbackSingleChoiceValue | FeedbackMultiChoiceValue | FeedbackRatingValue | FeedbackTextVariantValue;

export const BRIEFING_RUN_SCHEMA = "mandible-briefing-run@1" as const;
export type BriefingRunSourceHealth = {
  source: string;
  status: "healthy" | "degraded" | "unavailable";
  detail: string | null;
  observed_at: number;
};
export type BriefingRunRequest = {
  schema: typeof BRIEFING_RUN_SCHEMA;
  briefing_key: string;
  title: string;
  description?: string | null;
  task_identity: string;
  run_id: string;
  run_key: string;
  responder_user_ids: string[];
  evidence: { series_ref: string; version: number; digest: string };
  source_health: BriefingRunSourceHealth;
  document: { markdown: string } | null;
  quiet_reason: string | null;
  occurrences: Array<{ directive_key: string; evidence_digest: string; occurred_at: number; metadata: Record<string, unknown> }>;
};
export type BriefingRunReceipt = {
  receipt_id: string;
  briefing_id: string;
  run_id: string;
  round_id: string | null;
  artifact_version_id: string | null;
  quiet: boolean;
};
export type CreateBriefingFromArtifactVersionRequest = {
  artifact_version_ref: string;
  title: string;
  description?: string | null;
};
export type BriefingListEntry = {
  id: string;
  briefing_key: string;
  title: string;
  description: string | null;
  latest_round_id: string | null;
  round_count: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};
export type BriefingBundleMember = {
  position: number;
  briefing: BriefingListEntry;
};
export type BriefingBundleLayoutEntry =
  | { kind: "briefing"; position: number; briefing: BriefingListEntry }
  | { kind: "subgroup"; position: number; name: string; briefings: BriefingBundleMember[] };
export type BriefingBundleLayoutInputEntry =
  | { kind: "briefing"; briefing_ref: string }
  | { kind: "subgroup"; name: string; briefing_refs: string[] };
export type BriefingBundle = {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  /** Flattened compatibility projection. `layout` is the canonical ordered representation. */
  members: BriefingBundleMember[];
  layout: BriefingBundleLayoutEntry[];
};
export type BriefingGroup = {
  id: string;
  key: string;
  name: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  current: BriefingBundle | null;
  updates: BriefingBundle[];
  destinations: BriefingGroupDestination[];
  destination_history: Array<{ id: string; logical_artifact_id: string; prior_group_id: string | null;
    resulting_group_id: string; actor_user_id: string; created_at: number }>;
  review_candidates: BriefingGroupReviewCandidate[];
  history: BriefingGroupDisposition[];
};
export type BriefingGroupDestination = {
  logical_artifact_id: string;
  group_id: string;
  publication_mode: "reviewed-document" | "published-report" | null;
  route_keys: string[];
  created_at: number;
  updated_at: number;
};
export type BriefingGroupReviewLayoutEntry = {
  position: number;
  entry_kind: "briefing" | "subgroup";
  subgroup_name: string | null;
  subgroup_position: number;
  briefing_id: string;
  logical_artifact_id: string;
  artifact_version_id: string;
};
export type BriefingGroupDestinationChange = {
  position: number;
  logical_artifact_id: string;
  expected_group_id: string | null;
  resulting_group_id: string;
};
export type BriefingGroupReviewItem = {
  position: number;
  layout_position: number;
  subgroup_position: number;
  proposal_briefing_id: string;
  proposal_round_id: string;
  proposal_artifact_version_id: string;
  proposal_content_hash: string;
  base_briefing_id: string | null;
  base_round_id: string | null;
  base_artifact_version_id: string | null;
  base_content_hash: string | null;
  changed: boolean;
  submission_id: string | null;
};
export type BriefingGroupReviewCandidate = {
  proposal_bundle_id: string;
  expected_base_bundle_id: string | null;
  composition_run_id: string | null;
  binding_digest: string | null;
  ready: boolean;
  blocker_code: string | null;
  blocker_message: string | null;
  base_layout_digest: string | null;
  proposal_layout_digest: string | null;
  layout_changed: boolean;
  base_layout: BriefingGroupReviewLayoutEntry[];
  proposal_layout: BriefingGroupReviewLayoutEntry[];
  destination_changes: BriefingGroupDestinationChange[];
  items: BriefingGroupReviewItem[];
};
export type BriefingGroupDisposition = {
  id: string;
  kind: "promoted" | "dismissed" | "accepted" | "rejected";
  prior_base: BriefingBundle | null;
  proposal: BriefingBundle;
  resulting_base: BriefingBundle | null;
  auth_request_id: string | null;
  merge_head_sha: string | null;
  review_binding_digest: string | null;
  composition_run_id: string | null;
  review_items: BriefingGroupReviewItem[];
  base_layout_digest: string | null;
  proposal_layout_digest: string | null;
  base_layout: BriefingGroupReviewLayoutEntry[];
  proposal_layout: BriefingGroupReviewLayoutEntry[];
  destination_changes: BriefingGroupDestinationChange[];
  actor_user_id: string | null;
  evidence_method: string | null;
  credential_id: string | null;
  created_at: number;
};
export const BRIEFING_EVENTS = Object.freeze({
  created: "briefing:created",
  bundleCreated: "briefing:bundle-created",
  bundleMemberAdded: "briefing:bundle-member-added",
  bundleMembersReplaced: "briefing:bundle-members-replaced",
  bundleNameUpdated: "briefing:bundle-name-updated",
  bundleDeleted: "briefing:bundle-deleted",
  groupCreated: "briefing:group-created",
  groupUpdateAdded: "briefing:group-update-added",
  groupConfigurationUpdated: "briefing:group-configuration-updated",
  groupProposalPromoted: "briefing:group-proposal-promoted",
  groupProposalAccepted: "briefing:group-proposal-accepted",
  groupProposalRejected: "briefing:group-proposal-rejected",
  groupNameUpdated: "briefing:group-name-updated",
  groupArchived: "briefing:group-archived",
  groupRestored: "briefing:group-restored",
  roundPublished: "briefing:round-published",
  answered: "briefing:answered",
  annotated: "briefing:annotated",
  submitted: "briefing:submitted",
  titleUpdated: "briefing:title-updated",
  descriptionUpdated: "briefing:description-updated",
  archived: "briefing:archived",
  restored: "briefing:restored",
} as const);
export type BriefingEvent = (typeof BRIEFING_EVENTS)[keyof typeof BRIEFING_EVENTS];
export const BRIEFING_EVENT_VALUES: readonly BriefingEvent[] = Object.freeze(Object.values(BRIEFING_EVENTS));
export function isBriefingEvent(value: unknown): value is BriefingEvent {
  return typeof value === "string" && (BRIEFING_EVENT_VALUES as readonly string[]).includes(value);
}

// --- executor task inventory (issue 0bc2279) --------------------------------
//
// TELEMETRY, NOT CONTROL. An executor (today: agent-schedule) is the authority
// on which recurring tasks exist and what state they are in. Mandible stores
// what the executor REPORTS, verifies who reported it and that the payload has
// the declared shape, and projects the latest generation into a read-only view.
// It never runs, enables, or edits a task, and it never infers a fact the
// executor did not state.
//
// Three rules make the stored facts honest:
//
//  1. ATOMIC GENERATIONS. One POST is one complete snapshot of every task the
//     executor manages. There is no per-task upsert, so the view can never mix
//     halves of two different observations.
//  2. EXPLICIT UNKNOWN. Every field that an executor may not be able to answer
//     accepts the literal string `'unknown'`. Absent, null, and empty are
//     REJECTED — a publisher that does not know must say so. This is what keeps
//     "no bundle binding recorded for runs older than the feature" visibly
//     different from "not deployed".
//  3. IMMUTABLE RECEIPTS. Generations are append-only rows carrying the
//     authenticated principal that posted them and a content digest. Re-posting
//     the same canonical generation for one executor is a no-op that returns
//     the original receipt.
//
// The publisher-facing spec is docs/executor-inventory-contract.md.

export const TASK_INVENTORY_SCHEMA_V1 = 'executor-inventory@1';
export const TASK_INVENTORY_SCHEMA_V2 = 'executor-inventory@2';
export const TASK_INVENTORY_SCHEMA = 'executor-inventory@3';
export type TaskInventorySchema =
  | typeof TASK_INVENTORY_SCHEMA_V1
  | typeof TASK_INVENTORY_SCHEMA_V2
  | typeof TASK_INVENTORY_SCHEMA;

/** The literal an executor sends when it cannot answer a field. */
export const TASK_INVENTORY_UNKNOWN = 'unknown';
export type TaskInventoryUnknown = typeof TASK_INVENTORY_UNKNOWN;

/** A value the executor knows, or an explicit statement that it does not. */
export type TaskInventoryMaybe<T> = T | TaskInventoryUnknown;

/**
 * Who manages the task's lifecycle. Slice 1 admits `external` only: the
 * executor owns the task and Mandible observes it. The union exists so a later
 * slice can add a Mandible-managed mode without a schema change at this layer.
 */
export type TaskManagementMode = 'external';

export type TaskCircuitState = 'closed' | 'open' | 'half_open';
export type TaskKillSwitchState = 'engaged' | 'clear';
/** The EXECUTOR's own judgment about this task, not Mandible's view age. */
export type TaskStalenessClaim = 'fresh' | 'stale';
export type TaskRunOutcome = 'success' | 'failure' | 'timeout' | 'cancelled';

/** The deployed code a task currently executes. */
export type TaskBundleFacts = {
  /** Commit of the repository the bundle was built from. */
  commit: TaskInventoryMaybe<string>;
  /** Hash of the bundle's content as deployed. */
  content_hash: TaskInventoryMaybe<string>;
  /** Hash of the executable form actually invoked. */
  execution_hash: TaskInventoryMaybe<string>;
  /** Epoch ms the bundle became active. */
  deployed_at: TaskInventoryMaybe<number>;
};

/**
 * Activation deliberately reports TWO facts that a single `enabled` flag would
 * conflate: what the checked-in configuration asks for, and what this host is
 * actually running right now.
 */
export type TaskActivationLegacyFacts = {
  config_enabled: TaskInventoryMaybe<boolean>;
  locally_activated: TaskInventoryMaybe<boolean>;
};

export type TaskActivationState =
  | 'never_activated'
  | 'activated'
  | 'operator_disabled'
  | 'deployment_invalidated';
export type TaskActivationReason =
  | 'never_activated'
  | 'operator_enabled'
  | 'operator_disabled'
  | 'execution_hash_changed';
export type TaskActivationAction = 'none' | 'dry_run' | 'enable';
export type TaskAttention = 'none' | 'important';

/** The v3 state machine and the deployment transition that produced it. */
export type TaskActivationHealthFacts = TaskActivationLegacyFacts & {
  state: TaskActivationState;
  reason: TaskActivationReason;
  changed_at: TaskInventoryMaybe<number | 'none'>;
  previous_execution_hash: string | 'none';
  required_execution_hash: string | 'none';
  deployment_commit: string | 'none';
  deployment_content_hash: string | 'none';
  deployed_at: TaskInventoryMaybe<number | 'none'>;
  required_action: TaskActivationAction;
  attention: TaskAttention;
};

export type TaskActivationFacts = TaskActivationLegacyFacts | TaskActivationHealthFacts;

export type TaskExecutorHealthCondition =
  | 'healthy'
  | 'no_active_bundle'
  | 'bundle_link_mismatch'
  | 'execution_path_mismatch';

export type TaskExecutorHealth = {
  status: 'healthy' | 'operational_failure';
  condition: TaskExecutorHealthCondition;
  attention: TaskAttention;
};

/** Executor-reported configuration that determines what fires and how. */
export type TaskConfigFacts = {
  schedule_text: TaskInventoryMaybe<string>;
  not_before: TaskInventoryMaybe<string>;
  max_lateness_minutes: TaskInventoryMaybe<number>;
  missed_run_policy: TaskInventoryMaybe<string>;
  timeout_seconds: TaskInventoryMaybe<number>;
  runner: TaskInventoryMaybe<string>;
  runner_profile: TaskInventoryMaybe<string>;
  model: TaskInventoryMaybe<string>;
  max_total_tokens: TaskInventoryMaybe<number>;
  max_turns: TaskInventoryMaybe<number>;
  publish: TaskInventoryMaybe<boolean>;
  output_as_source: TaskInventoryMaybe<boolean>;
};

/** Runtime guards the executor applies to the task. */
export type TaskGuardFacts = {
  circuit: TaskInventoryMaybe<TaskCircuitState>;
  /** Retry attempts already spent on the pending run; 0 means none. */
  retry_attempt: TaskInventoryMaybe<number>;
  /** Epoch ms of the scheduled retry, or `'none'` when nothing is queued. */
  retry_next_at: TaskInventoryMaybe<number | 'none'>;
  kill_switch: TaskInventoryMaybe<TaskKillSwitchState>;
  staleness: TaskInventoryMaybe<TaskStalenessClaim>;
};

/**
 * One run, bound to the identities it ran under. The binding fields are the
 * point: a failure that cannot name the bundle it ran is reported as
 * `'unknown'` rather than silently attributed to whatever is deployed now.
 */
export type TaskRunFacts = {
  run_id: TaskInventoryMaybe<string>;
  started_at: TaskInventoryMaybe<number>;
  finished_at: TaskInventoryMaybe<number>;
  outcome: TaskInventoryMaybe<TaskRunOutcome>;
  bundle_commit: TaskInventoryMaybe<string>;
  content_hash: TaskInventoryMaybe<string>;
  execution_hash: TaskInventoryMaybe<string>;
  config_hash: TaskInventoryMaybe<string>;
  /** Free text the executor logged. Untrusted; render as text, never HTML. */
  detail: TaskInventoryMaybe<string>;
};

/** `'never'` is a positive claim ("this has not happened"), not an unknown. */
export type TaskRunSlot = TaskRunFacts | 'never' | TaskInventoryUnknown;

export type TaskInventoryEntry = {
  /** Stable id in the executor's own namespace. Unique within a generation. */
  task_id: string;
  display_name: string;
  management_mode: TaskManagementMode;
  /** Absent only on a preserved executor-inventory@1 generation. */
  config_hash?: TaskInventoryMaybe<string>;
  /** Absent only on a preserved executor-inventory@1 generation. */
  prompt_hash?: TaskInventoryMaybe<string>;
  /** Absent only on a preserved executor-inventory@1 generation. */
  config?: TaskConfigFacts;
  bundle: TaskBundleFacts | TaskInventoryUnknown;
  activation: TaskActivationFacts;
  guards: TaskGuardFacts;
  last_run: TaskRunSlot;
  last_failure: TaskRunSlot;
};

export type TaskExecutorIdentity = {
  /** Stable executor name. The projection key: one latest generation each. */
  name: string;
  version: TaskInventoryMaybe<string>;
  /** Free-form capability tokens; empty array means "declared none". */
  capabilities: string[];
  /** Absent only on preserved executor-inventory@1/@2 generations. */
  health?: TaskExecutorHealth;
};

/** One atomic inventory generation, exactly as posted. */
export type TaskInventoryGeneration = {
  schema: TaskInventorySchema;
  executor: TaskExecutorIdentity;
  /** Epoch ms the executor took the snapshot. Doubles as its heartbeat. */
  observed_at: number;
  tasks: TaskInventoryEntry[];
};

/** POST receipt. A replayed digest returns the original with `stored: false`. */
export type TaskInventoryPostResult = {
  generation_id: string;
  digest: string;
  /** False when this exact generation was already on record. */
  stored: boolean;
  executor: string;
  task_count: number;
  observed_at: number;
};

/** Mandible's view-age judgment about an executor, from `observed_at` alone. */
export type TaskExecutorFreshness = 'current' | 'stale' | 'unknown';

export type TaskExecutorSummary = {
  name: string;
  version: TaskInventoryMaybe<string>;
  capabilities: string[];
  /** Absent only when the selected generation predates executor-inventory@3. */
  health?: TaskExecutorHealth;
  observed_at: number;
  observed_age_ms: number;
  freshness: TaskExecutorFreshness;
  generation_id: string;
  digest: string;
  received_at: number;
  /** The authenticated principal that posted the generation. */
  posted_by_user_id: string;
  posted_by_slug: string | null;
  task_count: number;
};

export type TaskActivationObservation = {
  id: string;
  generation_id: string;
  state: TaskActivationState;
  reason: TaskActivationReason;
  observed_at: number;
  recorded_at: number;
  facts: TaskActivationHealthFacts;
};

export type TaskActivationCondition = {
  id: string;
  dedupe_key: string;
  required_execution_hash: string;
  attention: 'important';
  state: 'active' | 'resolved' | 'superseded';
  next_action: 'dry_run' | 'enable';
  raised_at: number;
  resolved_at: number | null;
  resolution: 'matching_dry_run_and_enable' | null;
  enable_command_id: string | null;
};

/** A task as reported by its executor, carrying that executor's view age. */
export type ExecutorTaskInventoryView = {
  source_kind: 'executor';
  /** `${executor}/${task_id}` — stable across generations, unique in a view. */
  key: string;
  executor: string;
  freshness: TaskExecutorFreshness;
  observed_at: number;
  observed_age_ms: number;
  task: TaskInventoryEntry;
  activation_condition: TaskActivationCondition | null;
  activation_history: TaskActivationObservation[];
};

/** A first-party reminder projected beside executor-owned tasks. */
export type MandibleTaskInventoryView = {
  source_kind: 'mandible';
  /** `mandible-reminder:<id>` — deliberately outside executor/task identity. */
  key: string;
  reminder: ManagedReminder;
};

/** Explicit source discrimination is required; field absence is never a source signal. */
export type TaskInventoryView = ExecutorTaskInventoryView | MandibleTaskInventoryView;

/**
 * The whole read surface. `executors` is empty exactly when no executor has
 * ever posted, which the view must state plainly rather than showing an empty
 * task list as though every task were gone.
 */
export type TaskInventoryResponse = {
  executors: TaskExecutorSummary[];
  tasks: TaskInventoryView[];
  /** Horizon used for `freshness`, so a client never guesses it. */
  stale_after_ms: number;
};

export const TASK_INVENTORY_EVENTS = Object.freeze({
  posted: 'tasks.inventory.posted',
} as const);

// --- operational incidents (issue 5308097) ---------------------------------

export const OPERATIONAL_INCIDENT_SCHEMA_V1 = 'operational-incidents@1';
export const OPERATIONAL_INCIDENT_SCHEMA = 'operational-incidents@2';
export type OperationalIncidentSchema =
  | typeof OPERATIONAL_INCIDENT_SCHEMA_V1
  | typeof OPERATIONAL_INCIDENT_SCHEMA;
export const OPERATIONAL_INCIDENT_RECEIPT_SCHEMA = 'operational-incidents-receipt@1';

export type OperationalIncidentCondition =
  | 'failed_permanent'
  | 'timeout'
  | 'circuit_open'
  | 'publish_stale'
  | 'publish_quarantined'
  | 'containment_blocked';

export type OperationalIncidentObservation = 'active' | 'recovered';
export type OperationalIncidentAttention = 'unacknowledged' | 'acknowledged';
export type OperationalIncidentRemediation =
  | 'none'
  | 'triaging'
  | 'fix_prepared'
  | 'awaiting_auth'
  | 'auth_expired'
  | 'awaiting_deploy'
  | 'awaiting_verification'
  | 'complete';
export type OperationalIncidentResolutionKind = 'successful_run' | 'operator_closure';

export type OperationalIncidentFacts = {
  run_id: string;
  run_status: string;
  exit_class: string;
  finished_at: number;
};

export type OperationalIncidentRecovery = {
  basis: 'newer_successful_run';
  run_id: string;
  run_status: 'succeeded';
  finished_at: number;
};

export type OperationalIncidentTelemetryEvent = {
  event_id: string;
  event_seq: 1 | 2;
  episode: {
    task: string;
    condition: OperationalIncidentCondition;
    first_seen: number;
  };
  observation: OperationalIncidentObservation;
  observed_at: number;
  facts: OperationalIncidentFacts;
  recovery: OperationalIncidentRecovery | null;
};

export type OperationalIncidentIngestEnvelope = {
  schema: OperationalIncidentSchema;
  executor: { name: string; version: string };
  generation: {
    inventory_schema: 'executor-inventory@2' | 'executor-inventory@3';
    inventory_digest: string;
    observed_at: number;
  };
  provenance: {
    basis: 'scheduler_computed';
    verification: 'unverified_by_mandible';
  };
  events: OperationalIncidentTelemetryEvent[];
};

export type OperationalIncidentReceipt = {
  event_id: string;
  incident_id: string;
  result: 'stored' | 'duplicate';
};

export type OperationalIncidentIngestResponse = {
  schema: typeof OPERATIONAL_INCIDENT_RECEIPT_SCHEMA;
  accepted: OperationalIncidentReceipt[];
};

export type OperationalIncidentProjection = {
  id: string;
  executor: string;
  task: string;
  condition: OperationalIncidentCondition;
  first_seen: number;
  observation: OperationalIncidentObservation;
  attention: OperationalIncidentAttention;
  remediation: OperationalIncidentRemediation;
  resolved: boolean;
  resolution_kind: OperationalIncidentResolutionKind | null;
  provenance: {
    label: 'Executor-reported; not verified by Mandible';
    value: 'executor_asserted_unverified';
  };
  latest_telemetry: { schema: OperationalIncidentSchema; event: unknown };
  latest_telemetry_sha256: string;
  latest_observed_at: number;
  recovered_at: number | null;
  recovery_run_id: string | null;
  acknowledged_at: number | null;
  acknowledged_by_user_id: string | null;
  resolved_at: number | null;
  operator_closed_at: number | null;
  operator_closed_by_user_id: string | null;
  updated_at: number;
};

export type OperationalIncidentCounts = {
  active_unacknowledged: number;
  active_acknowledged: number;
  resolved: number;
};

export type OperationalIncidentListResponse = {
  incidents: OperationalIncidentProjection[];
  counts: OperationalIncidentCounts;
  next_cursor: string | null;
};

export type OperationalIncidentAcknowledgementResponse = {
  incident_id: string;
  attention: 'acknowledged';
  event_id: string;
  acknowledged_at: number;
  acknowledged_by_user_id: string;
};

export type OperationalIncidentCloseResponse = {
  incident: OperationalIncidentProjection;
};

export const OPERATIONAL_INCIDENT_EVENTS = Object.freeze({
  ingested: 'operational-incident:ingested',
  acknowledged: 'operational-incident:acknowledged',
  remediationChanged: 'operational-incident:remediation-changed',
  closed: 'operational-incident:closed',
} as const);

export type OperationalIncidentEvent =
  (typeof OPERATIONAL_INCIDENT_EVENTS)[keyof typeof OPERATIONAL_INCIDENT_EVENTS];

// Immutable operator requests plus append-only executor receipts — issue
// 548bd73. These are deliberately separate from inventory telemetry: Mandible
// records the desired safety action, while only the addressed executor may
// attest acceptance and application.
export const TASK_COMMAND_SCHEMA_V1 = 'task-command@1';
export const TASK_COMMAND_SCHEMA = 'task-command@2';
export const TASK_COMMAND_EVENT_SCHEMA_V1 = 'task-command-event@1';
export const TASK_COMMAND_EVENT_SCHEMA = 'task-command-event@2';

export type TaskCommandSchema =
  | typeof TASK_COMMAND_SCHEMA_V1
  | typeof TASK_COMMAND_SCHEMA;
export type TaskCommandEventSchema =
  | typeof TASK_COMMAND_EVENT_SCHEMA_V1
  | typeof TASK_COMMAND_EVENT_SCHEMA;
export type Sha256 = string;
export type EmptyPayload = Record<string, never>;
export type ExecutionHashPayload = { execution_hash: Sha256 };

type TaskCommandCreateBase = {
  request_key: string;
  executor: string;
  task_id: string;
};

export type TaskCommandCreateRequest =
  | (TaskCommandCreateBase & {
      schema: typeof TASK_COMMAND_SCHEMA_V1;
      verb: 'disable';
      payload: EmptyPayload;
    })
  | (TaskCommandCreateBase & {
      schema: typeof TASK_COMMAND_SCHEMA;
      verb: 'disable';
      payload: EmptyPayload;
    })
  | (TaskCommandCreateBase & {
      schema: typeof TASK_COMMAND_SCHEMA;
      verb: 'dry_run' | 'enable';
      payload: ExecutionHashPayload;
    });

export type TaskCommandVerb = 'disable' | 'dry_run' | 'enable';
export type TaskCommandState =
  | 'requested'
  | 'accepted'
  | 'started'
  | 'applied'
  | 'rejected'
  | 'cancelled';
export type TaskCommandEventType =
  | 'accepted'
  | 'started'
  | 'progress'
  | 'applied'
  | 'rejected'
  | 'cancelled';
export type TaskCommandRejectionReason =
  | 'unknown_task'
  | 'unsupported_verb'
  | 'invalid_payload'
  | 'stale_target'
  | 'busy'
  | 'missing_receipt'
  | 'stale_receipt'
  | 'policy_refused'
  | 'dry_run_failed'
  | 'unknown';
export type TaskCommandFailureClass =
  | 'budget'
  | 'collector'
  | 'config'
  | 'containment'
  | 'limit'
  | 'output-source'
  | 'runner'
  | 'schema'
  | 'stale'
  | 'supervisor'
  | 'timeout'
  | 'unavailable'
  | 'validation';
/**
 * Which gate refused a `policy_refused` command. Closed and validated on both
 * sides: the executor's gates compute descriptive strings naming bundle roots,
 * symlink targets and individual file paths, and none of those may reach the
 * wire. Absent means the event came from an executor predating this field, not
 * that the gate is unknown.
 */
export type TaskCommandPolicyGate =
  | 'kill_switch'
  | 'no_bundle'
  | 'unprotected'
  | 'tampered'
  | 'misbound'
  | 'unreadable_config';
export type TaskCommandProgressStep =
  | 'preflight_passed'
  | 'collector_started'
  | 'snapshot_validated'
  | 'runner_started'
  | 'runner_completed'
  | 'output_validated';
export type TaskCommandProgressSequence = 1 | 2 | 3 | 4 | 5 | 6;

type TaskCommandExecutorEventRequestV1 = {
  schema: typeof TASK_COMMAND_EVENT_SCHEMA_V1;
  event_digest: Sha256;
} & (
  | { event: 'accepted' }
  | { event: 'applied'; no_op: boolean }
  | { event: 'rejected'; reason: TaskCommandRejectionReason }
);

type V2EventBase = {
  schema: typeof TASK_COMMAND_EVENT_SCHEMA;
  event_digest: Sha256;
};

export type TaskCommandExecutorEventRequestV2 =
  | (V2EventBase & { event: 'accepted' })
  | (V2EventBase & {
      event: 'started';
      execution_hash: Sha256;
      run_id: string;
    })
  | (V2EventBase & {
      event: 'progress';
      sequence: TaskCommandProgressSequence;
      step: TaskCommandProgressStep;
    })
  | (V2EventBase & { event: 'applied'; no_op: boolean })
  | (V2EventBase & {
      event: 'applied';
      execution_hash: Sha256;
      no_op: boolean;
    })
  | (V2EventBase & {
      event: 'applied';
      execution_hash: Sha256;
      run_id: string;
    })
  | (V2EventBase & {
      event: 'rejected';
      reason: Exclude<TaskCommandRejectionReason, 'dry_run_failed' | 'policy_refused'>;
    })
  | (V2EventBase & {
      event: 'rejected';
      reason: 'policy_refused';
      // Optional so an executor predating the field stays wire-compatible.
      // The amended executor supplies a member on every path it can take.
      policy_gate?: TaskCommandPolicyGate;
    })
  | (V2EventBase & {
      event: 'rejected';
      reason: 'dry_run_failed';
      failure_class: TaskCommandFailureClass;
    });

export type TaskCommandExecutorEventRequest =
  | TaskCommandExecutorEventRequestV1
  | TaskCommandExecutorEventRequestV2;

export type TaskCommandEvent = {
  id: string;
  schema: TaskCommandEventSchema;
  event: TaskCommandEventType;
  event_digest: string;
  payload: Record<string, unknown>;
  actor_user_id: string;
  actor_slug: string | null;
  created_at: number;
};

export type TaskCommand = {
  id: string;
  schema: TaskCommandSchema;
  request_key: string;
  request_digest: string;
  executor: string;
  task_id: string;
  verb: TaskCommandVerb;
  payload: EmptyPayload | ExecutionHashPayload;
  requested_by_user_id: string;
  requested_by_slug: string | null;
  requested_at: number;
  state: TaskCommandState;
  no_op: boolean | null;
  rejection_reason: TaskCommandRejectionReason | null;
  events: TaskCommandEvent[];
};

export type TaskCommandMutationResult = {
  command: TaskCommand;
  stored: boolean;
};

export type TaskCommandListResponse = {
  commands: TaskCommand[];
  polling: 'tick_aligned';
};

export const TASK_COMMAND_EVENTS = Object.freeze({
  changed: 'tasks.commands.changed',
} as const);

// --- managed reminders (umbrella d110073 / issue e257e5c) -------------------

export const MANAGED_REMINDER_SCHEMA = 'mandible-reminder@1';

export type ManagedReminderPredicate =
  | { kind: 'at'; at: string }
  | { kind: 'issue_closed'; issue_id: string }
  | {
      kind: 'auth_merge_count_gte';
      project_id: string;
      base_branch?: string;
      canonical_message?: boolean;
      threshold: number;
    };

export type ManagedReminderPayload = {
  schema: typeof MANAGED_REMINDER_SCHEMA;
  message: string;
  predicate: ManagedReminderPredicate;
  effect: { kind: 'inbox_occurrence' };
};

export type ManagedReminderLifecycle = 'armed' | 'completed' | 'cancelled';

export type ManagedReminderOccurrence = {
  id: string;
  task_id: string;
  revision_id: string;
  occurrence_key: string;
  kind: 'inbox_occurrence';
  message: string;
  triggering_evidence: Record<string, unknown>;
  created_by_user_id: string;
  fired_by_user_id: string;
  created_at: number;
  acknowledged_by: string | null;
  acknowledged_at: number | null;
};

export type ManagedReminder = {
  id: string;
  project_id: string;
  project_key: string;
  kind: 'mandible-reminder';
  lifecycle: ManagedReminderLifecycle;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
  revision: {
    id: string;
    revision_no: 1;
    schema: typeof MANAGED_REMINDER_SCHEMA;
    payload_digest: string;
    payload: ManagedReminderPayload;
    created_by_user_id: string;
    created_at: number;
  };
  occurrence: ManagedReminderOccurrence | null;
};

export type ManagedReminderCreateRequest = {
  schema: typeof MANAGED_REMINDER_SCHEMA;
  idempotency_key: string;
  project: string;
  message: string;
  predicate:
    | { kind: 'at'; at: string }
    | { kind: 'issue_closed'; issue: string }
    | {
        kind: 'auth_merge_count_gte';
        project: string;
        base_branch?: string;
        canonical_message?: boolean;
        threshold: number;
      };
};

export type ManagedReminderCreateResult = {
  reminder: ManagedReminder;
  stored: boolean;
  fired_immediately: boolean;
};

export const MANAGED_REMINDER_EVENTS = Object.freeze({
  changed: 'managed-reminders.changed',
  occurred: 'managed-reminders.occurred',
} as const);

const eventNameValues = Object.freeze([
  ...Object.values(DOMAIN_EVENTS), ...BRIEFING_EVENT_VALUES, ...SPACE_EVENT_VALUES,
  ...Object.values(USER_SETTING_EVENTS), ...Object.values(OPERATIONAL_INCIDENT_EVENTS),
  ...Object.values(TASK_INVENTORY_EVENTS), ...Object.values(TASK_COMMAND_EVENTS),
  ...Object.values(MANAGED_REMINDER_EVENTS),
]);
const eventNames = new Set<string>(eventNameValues);
export function isDomainEventType(value: unknown): value is MandibleEventType {
  return typeof value === "string" && eventNames.has(value);
}

const scopedChange = (key: string) => z.object({ [key]: z.string().min(1) }).passthrough();
const eventPayloadSchemas = new Map<MandibleEventType, z.ZodType>([
  [DOMAIN_EVENTS.HEARTBEAT, z.object({ timestamp: z.number() })],
  [DOMAIN_EVENTS.CONVERSATION_UPDATED, scopedChange("id")],
  ...BRIEFING_EVENT_VALUES.map((event): [MandibleEventType, z.ZodType] => [event,
    scopedChange(event.startsWith("briefing:group-") ? "group_id"
      : event.startsWith("briefing:bundle-") ? "bundle_id" : "briefing_id")]),
  ...SPACE_EVENT_VALUES.map((event): [MandibleEventType, z.ZodType] => [event,
    event === SPACE_EVENTS.SPACE_DOCUMENT_SETTINGS_UPDATED
      ? z.object({ scope: z.enum(["repo", "global"]), repo_id: z.string().nullable() })
      : scopedChange("space_id")]),
]);

export function parseDomainEvent(value: unknown): { ok: true; value: MandibleEvent } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "data")) {
    return { ok: false, error: "Invalid domain event envelope" };
  }
  const envelope = z.object({ type: z.custom<MandibleEventType>(isDomainEventType),
    event: z.custom<MandibleEventType>(isDomainEventType).optional(),
    data: z.unknown(), timestamp: z.string().optional() }).safeParse(value);
  if (!envelope.success) return { ok: false, error: "Invalid domain event envelope" };
  if (envelope.data.event !== undefined && envelope.data.event !== envelope.data.type) {
    return { ok: false, error: "Conflicting domain event names" };
  }
  const schema = eventPayloadSchemas.get(envelope.data.type);
  if (schema && !schema.safeParse(envelope.data.data).success) {
    return { ok: false, error: `Invalid ${envelope.data.type} event payload` };
  }
  return { ok: true, value: envelope.data as MandibleEvent };
}
