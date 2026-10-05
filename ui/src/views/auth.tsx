import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DiffView,
  type DiffViewClassNames,
  type DiffViewMode,
} from '../components/DiffView';
import { ViewSidebar } from '../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { EntityPill } from '../components/shared/EntityPill';
import { AttributionIdentity } from '../components/shared/DetailHeaderIdentity';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneMenuTrigger } from '../components/shared/DetailPaneMenuTrigger';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { ContextualAction } from '../components/shared/ContextualAction';
import { EntityTimestamps } from '../components/shared/EntityTimestamps';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { DisclosureChevronIcon } from '../components/shared/DisclosureChevronIcon';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { IconTabList, type IconTab } from '../components/shared/IconTabList';
import { DiffIcon, InfoIcon, TerminalIcon } from '../components/icons/TabIcons';
import { linkifyResourceRefs as linkifyArtifactRefs } from '../resource-refs';
import { formatRelativeTime } from '../lib/format';
import { renderInlineMarkdown, renderMarkdown } from '../lib/markdown';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import {
  fetchAuthHooks,
  cancelApprovalProof,
  canPerformOperation,
  findIssue,
  getAuthRequestActions,
  getAuthRequestDetail,
  isApiErrorStatus,
  createAuthHook,
  setAuthRequestActionVeto,
  updateAuthHook,
  deleteAuthHook,
  type AuthRequestAction,
  type AuthHook,
  type AttributionReadProjection,
  type MergeSignatureClaim,
  type InstanceInfo,
  type ReadUserIdentity,
} from '../api';
import { exhausted } from '../../../src/exhaustive';
import {
  AUTH_REQUEST_TYPES,
  type AuthRequestType,
  isAuthDependencyReady,
  type AuthChangeReport,
  type AuthDependencyProjection,
} from '../../../src/contracts';
import { AuthChangeBreakdown } from './AuthChangeBreakdown';

const RETAINED_FINALIZED_AUTH_KEY = 'mandible.auth.retained-finalized-selection';

type AuthActionRetry =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'retry' }
  | { kind: 'veto'; action: AuthRequestAction; vetoed: boolean };

type AuthActionError = {
  message: string;
  retry: AuthActionRetry;
};

export type { AuthRequestType } from '../../../src/contracts';

export type AuthRequest = {
  id?: string;
  request_id?: string;
  session_id?: string | null;
  type?: AuthRequestType;
  title?: string;
  summary?: string;
  repo?: string;
  base?: string;
  head?: string;
  base_branch?: string;
  head_branch?: string;
  merge_preflight_base_sha?: string | null;
  merge_preflight_queue_fingerprint?: string | null;
  change_report?: AuthChangeReport | null;
  status?: string;
  state?: string;
  exit_code?: number | null;
  error?: string | null;
  output?: string;
  stats?: {
    files?: number;
    additions?: number;
    deletions?: number;
  };
  files_changed?: number;
  additions?: number;
  deletions?: number;
  commit_message?: string;
  // Issue 7d64d8f — present when commit_message is the agent-authored
  // canonical change message the merge will commit verbatim.
  commit_message_digest?: string | null;
  spec_content?: string;
  diff_summary?: string;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  issue_ids?: string[] | null;
  created_at?: string | number;
  updated_at?: string | number;
  last_executed_at?: string | number | null;
  resolved_at?: number | string | null;
  depends_on_id?: string | null;
  dependency?: AuthDependencyProjection | null;
  approval_source?: string;
  approval_lease_id?: string | null;
  requested_by_user_id?: string | null;
  requester_evidence_method?: string | null;
  requester_credential_id?: string | null;
  approved_by_user_id?: string | null;
  execution_evidence_id?: string | null;
  clearance_use_id?: string | null;
  supersedes_request_id?: string | null;
  superseded_by_request_id?: string | null;
  lifecycle_events?: Array<{
    revision: number;
    event_type: string;
    snapshot_sha256: string;
    actor_user_id: string | null;
    reason: string | null;
    related_request_id: string | null;
  }>;
  requester?: ReadUserIdentity | null;
  approver?: ReadUserIdentity | null;
  execution_evidence?: AttributionReadProjection | null;
  merge_signature?: MergeSignatureClaim;
  action_count?: number;
  actions?: AuthRequestAction[];
  [key: string]: unknown;
};

export type AuthQueueViewProps = {
  queue: AuthRequest[];
  historyQueue?: AuthRequest[];
  outputs: Record<string, string>;
  /** Known branch names per repo — used to detect stale entries whose branch was merged & deleted. */
  branchesByRepo?: Record<string, string[]>;
  selectedAuthId?: string | null;
  /** Deep-link: select and scroll to a specific request on mount (from graph node click). */
  initialRequestId?: string;
  sidebarHidden?: boolean;
  /**
   * Bug: 645f8a8 — daemon readiness gate. When false (daemon is rebuilding /
   * starting / not yet ready for normal mutations), the mutating action buttons
   * (Approve/Reject/Retry) are disabled and their handlers are blocked
   * so no mutation POST fires into a half-initialized daemon. Defaults to true.
   */
  daemonReady?: boolean;
  instance?: InstanceInfo | null;
  onSelectAuth?: (id: string | null) => void;
  onApprove: (requestId: string) => void | Promise<void>;
  onReject: (requestId: string) => void | Promise<void>;
  onRetry: (requestId: string) => void | Promise<void>;
  onUpdateField?: (requestId: string, field: string, value: string) => void | Promise<void>;
  autoShowConsoleOnApproval?: boolean;
  autoReturnToAbstractOnSuccess?: boolean;
  retainFinalizedSelection?: boolean;
};

function getAuthId(request: AuthRequest): string {
  return request.id || request.request_id || '';
}

function getAuthTitle(request: AuthRequest): string {
  return request.title || request.summary || 'Approval Request';
}

function getAuthStatus(request: AuthRequest): string {
  return request.status || request.state || 'pending';
}

function getAuthType(request: AuthRequest): AuthRequestType {
  return request.type ?? 'merge';
}

const AUTH_TYPE_META: Record<AuthRequestType, { label: string; cssClass: string }> = {
  'merge':          { label: 'Merge',       cssClass: 'type-badge--merge' },
  'commit':         { label: 'Commit',      cssClass: 'type-badge--commit' },
  'force-push':     { label: 'Force Push',  cssClass: 'type-badge--force-push' },
  'branch-delete':  { label: 'Delete',      cssClass: 'type-badge--branch-delete' },
  'config-change':  { label: 'Config',      cssClass: 'type-badge--config-change' },
  'data-delete':    { label: 'Delete Data', cssClass: 'type-badge--data-delete' },
};

const AUTH_DIFF_VIEW_CLASS_NAMES: DiffViewClassNames = {
  toolbar: 'auth-detail__diff-toolbar',
  modeGroup: 'auth-detail__diff-mode',
  modeButton: 'auth-detail__diff-mode-button',
  modeButtonActive: 'auth-detail__diff-mode-button--active',
  empty: 'auth-detail__diff-empty',
  file: 'auth-diff-file',
  fileHeader: 'auth-diff-file__header',
  filePath: 'auth-diff-file__path',
  fileBody: 'auth-diff-file__body',
  fileHtml: 'auth-diff-file__html',
  fileFallback: 'auth-diff-file__fallback',
};

/** Returns true when the request type has meaningful diff stats to display. */
function typeHasDiffStats(type: AuthRequestType): boolean {
  return type === 'merge' || type === 'commit';
}

function getStats(request: AuthRequest): { files: number | null; additions: number | null; deletions: number | null } {
  const files = request.stats?.files ?? request.files_changed ?? null;
  const additions = request.stats?.additions ?? request.additions ?? null;
  const deletions = request.stats?.deletions ?? request.deletions ?? null;
  return { files, additions, deletions };
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** Parse [branch-name] prefix from commit message first line. */
function parseBranchTag(message: string): { branch: string | null; body: string } {
  const match = message.match(/^\[([^\]]+)\]\s*/);
  if (match) {
    return { branch: match[1], body: message.slice(match[0].length) };
  }
  return { branch: null, body: message };
}

function looksLikeBranchName(value: string): boolean {
  if (!value) return false;
  if (value === 'main' || value === 'master' || value === 'develop') {
    return true;
  }
  return /^(feature|fix|bugfix|hotfix|chore|release)\//.test(value);
}

const RESOLVED_LINGER_MS = 1500;


function getTimestampMs(value?: string | number | null): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getCreatedAtMs(request: AuthRequest): number | null {
  return getTimestampMs(request.created_at ?? null);
}

function getLastExecutedAtMs(request: AuthRequest): number | null {
  return getTimestampMs(request.last_executed_at ?? null);
}

function getResolvedAtMs(request: AuthRequest): number {
  const resolved = getTimestampMs(request.resolved_at ?? null);
  if (resolved != null) return resolved;
  const created = getCreatedAtMs(request);
  return created ?? Date.now();
}

function isFailedLikeStatus(status: string, exitCode?: number | null): boolean {
  if (status === 'needs_rebase') return true;
  if (status === 'expired') return true;
  if (status !== 'completed') return false;
  return exitCode != null && exitCode !== 0;
}

function isHistoryStatus(status: string, exitCode?: number | null): boolean {
  if (status === 'rejected' || status === 'withdrawn' || status === 'superseded' || status === 'dismissed' || status === 'error') {
    return true;
  }
  if (status !== 'completed') return false;
  return exitCode == null || exitCode === 0;
}

function isAuthExecutingStatus(status: string): boolean {
  return status === 'approved' || status === 'executing';
}

type AuthExecutionCallout = {
  text: string;
  spinner: boolean;
};

function getAuthExecutionCallout(status: string, consoleText: string): AuthExecutionCallout | null {
  if (!isAuthExecutingStatus(status)) return null;
  const text = consoleText.toLowerCase();
  if (text.includes('merge conflict') || text.includes('conflicts remain') || text.includes('manual resolution')) {
    return { text: 'Merge needs attention in the terminal', spinner: false };
  }
  if (text.includes('waiting for yubikey touch')) {
    return { text: 'Touch your YubiKey now', spinner: true };
  }
  if (text.includes('delegated signing key ready')) {
    return { text: 'Authentication complete; starting git work', spinner: true };
  }
  if (text.includes('reusing submit-time merge preflight')) {
    return { text: 'Using submit-time merge check', spinner: true };
  }
  if (text.includes('running merge preflight')) {
    return { text: 'Running merge preflight checks', spinner: true };
  }
  if (text.includes('checking git locks')) {
    return { text: 'Checking git lock state', spinner: true };
  }
  if (text.includes('checking signing configuration')) {
    return { text: 'Checking signing configuration', spinner: true };
  }
  if (text.includes('creating signed merge commit')) {
    return { text: 'Creating signed merge commit', spinner: true };
  }
  if (text.includes('signed merge complete') || text.includes('[hook:')) {
    return { text: 'Signed merge complete; running follow-up actions', spinner: true };
  }
  return { text: 'Preparing auth merge', spinner: true };
}

function getStatusLabel(request: AuthRequest): string {
  const status = getAuthStatus(request);
  if (isAuthExecutingStatus(status)) return 'Executing';
  if (status === 'needs_rebase') return 'Needs rebase';
  if (status === 'completed') {
    if (request.exit_code != null && request.exit_code !== 0) return 'Failed';
    const type = getAuthType(request);
    if (type === 'merge') {
      const convergence = getConvergence(request);
      if (convergence?.state === 'pending') return 'Converging';
      if (convergence?.state === 'failed') return 'Merged, not live';
      return 'Merged';
    }
    return {
      commit: 'Committed',
      'force-push': 'Force-pushed',
      'branch-delete': 'Deleted',
      'config-change': 'Updated',
      'data-delete': 'Deleted',
    }[type];
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Issue 27241e6 — convergence is the second half of "delivered". `Completed`
 * on its own only says the merge landed; these three values say whether the
 * registered post-merge hooks actually made the machine live.
 */
type ConvergenceHookSummary = {
  hook_id?: string;
  label?: string;
  state?: string;
  required?: boolean;
  attempts?: number;
  max_attempts?: number;
  exit_code?: number | null;
};

type ConvergenceSummary = {
  state: 'complete' | 'pending' | 'failed';
  hooks: ConvergenceHookSummary[];
};

function getConvergence(request: AuthRequest): ConvergenceSummary | null {
  const raw = request.convergence;
  if (!raw || typeof raw !== 'object') return null;
  const state = (raw as { state?: unknown }).state;
  if (state !== 'complete' && state !== 'pending' && state !== 'failed') return null;
  const hooks = (raw as { hooks?: unknown }).hooks;
  return { state, hooks: Array.isArray(hooks) ? (hooks as ConvergenceHookSummary[]) : [] };
}

function convergenceTitle(convergence: ConvergenceSummary): string {
  const hooks = convergence.hooks
    .map((hook) => {
      const name = hook.label || hook.hook_id || 'hook';
      const attempts = hook.attempts != null && hook.max_attempts != null
        ? ` (${hook.attempts}/${hook.max_attempts} attempts)`
        : '';
      return `${name}: ${hook.state ?? 'unknown'}${attempts}`;
    })
    .join('\n');
  const heading = convergence.state === 'complete'
    ? 'Merged and every registered post-merge hook succeeded.'
    : convergence.state === 'pending'
      ? 'Merged. A registered post-merge hook has not finished yet, so this machine is not live.'
      : 'Merged. A required post-merge hook failed, so this machine is not live. Issue closures are withheld.';
  return hooks ? `${heading}\n\n${hooks}` : heading;
}

function getStatusClass(request: AuthRequest): string {
  const status = getAuthStatus(request);
  if (isFailedLikeStatus(status, request.exit_code ?? null)) {
    return 'status-pill status-pill--failed';
  }
  return `status-pill status-pill--${status.toLowerCase()}`;
}

function getActionCount(request: AuthRequest): number {
  if (Array.isArray(request.actions)) return request.actions.length;
  return typeof request.action_count === 'number' && Number.isFinite(request.action_count)
    ? request.action_count
    : 0;
}

function formatActionKind(kind: AuthRequestAction['kind']): string {
  switch (kind) {
    case 'comment_add': return 'Comment';
    case 'issue_close': return 'Close issue';
    case 'worker_status_set': return 'Worker status';
    case 'label_add': return 'Add label';
    case 'label_rm': return 'Remove label';
    case 'checkpoint_add': return 'Checkpoint';
    case 'link_add': return 'Link issue';
    case 'briefing_group_promote': return 'Promote Briefing Base';
    default:
      // Render rather than throw — a newer daemon must not blank this pane —
      // but bind to `never` so a new kind is a build error here, not a raw
      // enum string in the pane a human reads before approving a merge.
      return exhausted(kind, String(kind));
  }
}

function actionPayloadSummary(action: AuthRequestAction): string {
  const payload = action.payload ?? {};
  switch (action.kind) {
    case 'comment_add':
      return truncateSummary(String(payload.body ?? ''), 180);
    case 'issue_close':
      return payload.reason_comment
        ? `Reason: ${truncateSummary(String(payload.reason_comment), 160)}`
        : '';
    case 'worker_status_set':
      return `Set to ${String(payload.value ?? '')}`;
    case 'label_add':
      return `Add ${String(payload.label ?? '')}`;
    case 'label_rm':
      return `Remove ${String(payload.label ?? '')}`;
    case 'checkpoint_add':
      return `Checkpoint ${String(payload.kind ?? '')}`;
    case 'link_add': {
      const target = String(payload.target ?? '');
      const type = payload.type ? ` as ${String(payload.type)}` : '';
      const note = payload.note ? `: ${truncateSummary(String(payload.note), 120)}` : '';
      return `Link ${target}${type}${note}`;
    }
    case 'briefing_group_promote': {
      // The one staged action that mutates canonical Briefing Base state, so
      // the approver needs to read which bundle replaces which — not raw JSON.
      const proposal = String(payload.proposal_bundle_ref ?? '');
      const base = String(payload.expected_base_bundle_ref ?? '');
      const group = String(payload.group_ref ?? '');
      return `Promote ${proposal} to Base of ${group} (replacing ${base})`;
    }
    default:
      return exhausted(action.kind, JSON.stringify(payload));
  }
}

function actionStateLabel(state: AuthRequestAction['state']): string {
  switch (state) {
    case 'staged': return 'Staged';
    case 'applied': return 'Applied';
    case 'failed': return 'Failed';
    case 'skipped_stale': return 'Skipped stale';
    case 'vetoed': return 'Vetoed';
    default: return exhausted(state, String(state));
  }
}

function issueTitleFromDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.title === 'string') return record.title;
  const issue = record.issue;
  if (issue && typeof issue === 'object' && typeof (issue as { title?: unknown }).title === 'string') {
    return (issue as { title: string }).title;
  }
  return null;
}

function truncateSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

const DEFAULT_EXPANDED_ACTION_IDS: string[] = [];

function normalizeExpandedActionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string')));
}

function AuthActionBundle({
  request,
  actions,
  inFlightActionIds,
  instance,
  onToggleVeto,
}: {
  request: AuthRequest;
  actions: AuthRequestAction[];
  inFlightActionIds: Set<string>;
  instance?: InstanceInfo | null;
  onToggleVeto: (requestId: string, action: AuthRequestAction, vetoed: boolean) => void;
}): JSX.Element | null {
  const requestId = getAuthId(request);
  const repoId = request.repo ?? '';
  const [expandedActionIds, setExpandedActionIds] = usePersistedViewState(
    `auth-action-expanded:${requestId}`,
    normalizeExpandedActionIds,
    DEFAULT_EXPANDED_ACTION_IDS,
  );
  const expandedIds = useMemo(() => new Set(expandedActionIds), [expandedActionIds]);
  const [targetTitles, setTargetTitles] = useState<Record<string, string>>({});
  const status = getAuthStatus(request);
  const canVeto = status === 'pending';

  useEffect(() => {
    const refs = uniqueStrings(actions.map((action) => action.target_issue_ref));
    let active = true;
    for (const ref of refs) {
      if (targetTitles[ref]) continue;
      findIssue(ref)
        .then((detail) => {
          if (!active) return;
          const title = issueTitleFromDetail(detail);
          if (!title) return;
          setTargetTitles((prev) => ({ ...prev, [ref]: title }));
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [actions, targetTitles]);

  if (actions.length === 0) {
    return null;
  }

  const toggleExpanded = (actionId: string) => {
    setExpandedActionIds((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return Array.from(next);
    });
  };

  return (
    <section className="auth-action-bundle" aria-label="Deferred approval actions">
      <div className="auth-action-bundle__header">
        <span className="auth-action-bundle__title">On merge...</span>
        <span className="auth-action-bundle__count">{actions.length}</span>
      </div>
      <div className="auth-action-bundle__rows">
        {actions.map((action) => {
          const title = (action as AuthRequestAction & { target_issue_title?: string }).target_issue_title
            ?? targetTitles[action.target_issue_ref]
            ?? '';
          const vetoed = action.state === 'vetoed';
          const vetoBusy = inFlightActionIds.has(action.id);
          const canToggle = canVeto && (action.state === 'staged' || action.state === 'vetoed');
          const detail = action.outcome_detail || actionPayloadSummary(action);
          const canExpand = Boolean(detail) && (action.kind !== 'issue_close' || action.state !== 'staged');
          const expanded = canExpand && expandedIds.has(action.id);
          const summary = action.kind === 'issue_close' ? title : actionPayloadSummary(action);
          return (
            <div
              key={action.id}
              className={`auth-action-row auth-action-row--${action.state}${canExpand ? ' auth-action-row--expandable' : ''}${expanded ? ' auth-action-row--expanded' : ''}`}
              title={action.outcome_detail ?? undefined}
            >
              {canExpand ? (
                <button
                  type="button"
                  className="auth-action-row__expand"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${formatActionKind(action.kind)} action`}
                  onClick={() => toggleExpanded(action.id)}
                >
                  <DisclosureChevronIcon expanded={expanded} size={13} />
                </button>
              ) : null}
              <div className="auth-action-row__main">
                <div className="auth-action-row__top">
                  <span className="auth-action-row__kind">{formatActionKind(action.kind)}:</span>
                  <EntityPill
                    type="issue"
                    id={action.target_issue_ref}
                    repoId={repoId}
                  />
                  {action.state !== 'staged' && (
                    <span className={`auth-action-row__state auth-action-row__state--${action.state}`}>
                      {actionStateLabel(action.state)}
                    </span>
                  )}
                </div>
                {summary && <div className="auth-action-row__summary">{summary}</div>}
                {expanded && detail && (
                  <div className="auth-action-row__detail">{detail}</div>
                )}
              </div>
              {canToggle && (
                <button
                  type="button"
                  className={`auth-action-row__veto${vetoed ? ' auth-action-row__veto--on' : ''}`}
                  role="switch"
                  aria-checked={vetoed}
                  disabled={vetoBusy || !canPerformOperation(
                    instance,
                    'POST',
                    `/api/auth/request/${encodeURIComponent(requestId)}/actions/${encodeURIComponent(action.id)}/veto`,
                    { vetoed: !vetoed },
                  )}
                  onClick={() => onToggleVeto(requestId, action, !vetoed)}
                >
                  {vetoBusy ? 'Saving' : vetoed ? 'Restore' : 'Veto'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function buildFailureSummary(request: AuthRequest, outputs: Record<string, string>): string | null {
  const id = getAuthId(request);
  const errorText = typeof request.error === 'string' ? request.error.trim() : '';
  const outputText =
    outputs[id] ||
    (typeof request.output === 'string' ? request.output : '');
  const source = errorText || outputText.trim();
  if (!source) {
    return null;
  }
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  return truncateSummary(lines.slice(-3).join(' / '), 240);
}

/** Strip ANSI escape sequences from a string for clean console display. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Check if the request's head_branch no longer exists in the repo's known branches. */
function isBranchMerged(
  request: AuthRequest,
  branchesByRepo?: Record<string, string[]>,
): boolean {
  if (!branchesByRepo) return false;
  const repo = request.repo ?? '';
  const headBranch = request.head_branch ?? request.head ?? '';
  if (!repo || !headBranch) return false;
  const branches = branchesByRepo[repo];
  if (!branches || branches.length === 0) return false;
  return !branches.includes(headBranch);
}

function getRequestHash(request: AuthRequest): string {
  const id = getAuthId(request);
  return id ? id.slice(0, 8) : '';
}

function getStatusOrder(request: AuthRequest): number {
  const status = getAuthStatus(request);
  if (status === 'pending') return 0;
  if (status === 'approved' || status === 'executing') return 1;
  if (isFailedLikeStatus(status, request.exit_code ?? null)) return 2;
  return 3;
}

function getSubmissionTimestampLabel(request: AuthRequest): string {
  const createdAtMs = getCreatedAtMs(request);
  const lastExecutedAtMs = getLastExecutedAtMs(request);
  const showLastAttempt =
    lastExecutedAtMs != null &&
    (createdAtMs == null || lastExecutedAtMs !== createdAtMs);

  const submissionLabel = createdAtMs != null
    ? formatRelativeTime(createdAtMs, { style: 'recent' })
    : 'unknown';
  const lastAttemptLabel = showLastAttempt && lastExecutedAtMs != null
    ? `last attempt: ${formatRelativeTime(lastExecutedAtMs, { style: 'recent' })}`
    : null;
  return lastAttemptLabel
    ? `${submissionLabel} · ${lastAttemptLabel}`
    : submissionLabel;
}

function getResolvedTimestampLabel(request: AuthRequest): string {
  const resolvedAtMs = getResolvedAtMs(request);
  return `resolved ${formatRelativeTime(resolvedAtMs, { style: 'recent' })}`;
}

function formatMetadataTimestamp(value?: string | number | null): string | null {
  const timestamp = getTimestampMs(value ?? null);
  if (timestamp == null) return null;
  return `${formatRelativeTime(timestamp, { style: 'recent' })} (${new Date(timestamp).toLocaleString()})`;
}

function getStringField(request: AuthRequest, field: string): string | null {
  const value = request[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

function MetadataRow({ label, value }: { label: string; value: string | JSX.Element | null | undefined }): JSX.Element | null {
  if (value == null || value === '') return null;
  return (
    <div className="auth-detail-metadata__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

async function copyAuthText(value: string): Promise<void> {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(value);
}

function AuthRequestDetail({
  request,
  history,
  failureSummary,
  attemptCount,
  actionBundle,
  actions,
  executionOutput,
  notice,
  onUpdateField,
  mutationsAllowed = true,
  autoShowConsoleOnApproval = true,
  autoReturnToAbstractOnSuccess = true,
}: {
  request: AuthRequest;
  history?: boolean;
  failureSummary?: string | null;
  attemptCount?: number | null;
  branchMerged?: boolean;
  actionBundle?: JSX.Element | null;
  actions?: JSX.Element | null;
  executionOutput?: string;
  notice?: JSX.Element | null;
  onUpdateField?: (requestId: string, field: string, value: string) => void | Promise<void>;
  mutationsAllowed?: boolean;
  autoShowConsoleOnApproval?: boolean;
  autoReturnToAbstractOnSuccess?: boolean;
}): JSX.Element {
  const [showCommit, setShowCommit] = useState(true);
  const [showSpec, setShowSpec] = useState(false);
  const [viewMode, setViewMode] = useState<'abstract' | 'console' | 'diff'>('abstract');
  const [diffMode, setDiffMode] = useState<DiffViewMode>('split');
  const [editingCommitMsg, setEditingCommitMsg] = useState(false);
  const [editCommitValue, setEditCommitValue] = useState('');
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuStyle = useAnchoredMenu({
    open: actionsOpen,
    anchorRef: actionsTriggerRef,
    menuRef: actionsMenuRef,
    onDismiss: () => setActionsOpen(false),
  });

  const commitMsg = typeof request.commit_message === 'string' ? request.commit_message : '';
  // Issue 7d64d8f — a digest means these exact bytes are the merge commit
  // message. It controls editability only; display still uses the shared,
  // sanitized Markdown pipeline without mutating the stored source bytes.
  const canonicalDigest =
    typeof request.commit_message_digest === 'string' && request.commit_message_digest
      ? request.commit_message_digest
      : '';
  const isCanonicalMessage = canonicalDigest !== '' && commitMsg !== '';
  const specContent = typeof request.spec_content === 'string' ? request.spec_content : '';
  const diffRaw = typeof request.diff_summary === 'string' ? request.diff_summary : '';

  const { branch: commitBranch, body: commitBody } = useMemo(
    () => parseBranchTag(commitMsg),
    [commitMsg],
  );
  const commitHtml = useMemo(
    () => commitBody ? linkifyArtifactRefs(renderMarkdown(commitBody)) : '',
    [commitBody],
  );
  const specHtml = useMemo(
    () => specContent ? linkifyArtifactRefs(renderMarkdown(specContent)) : '',
    [specContent],
  );
  // Streamed output is already ANSI-stripped in the reducer; only strip the
  // persisted fallback here.
  const consoleText = useMemo(() => {
    if (executionOutput) return executionOutput;
    const fallback = typeof request.output === 'string' ? request.output : '';
    return stripAnsi(fallback);
  }, [executionOutput, request.output]);
  const hasConsoleOutput = consoleText.trim().length > 0;

  const stats = getStats(request);
  const status = getAuthStatus(request);
  const statusLabel = getStatusLabel(request);
  const completedConvergence = status === 'completed' && (request.exit_code ?? 0) === 0
    ? getConvergence(request)
    : null;
  const statusClass = getStatusClass(request);
  const failedLike = isFailedLikeStatus(status, request.exit_code ?? null);
  const executionCallout = getAuthExecutionCallout(status, consoleText);
  const showFailure = failedLike;
  const attemptLabel = attemptCount && attemptCount > 1 ? `Attempt ${attemptCount}` : null;
  const requestHash = getRequestHash(request);
  const fullId = getAuthId(request);

  const baseBranch = request.base_branch ?? request.base;
  const headBranch = request.head_branch ?? request.head;
  const repoId = request.repo ?? '';
  const repoName = repoId.includes('/') && !looksLikeBranchName(repoId) && repoId.split('/').length === 2
    ? repoId.split('/')[1]
    : repoId;

  const sessionId = request.session_id;
  const structuredReferenceIds = request.issue_references;
  const referenceRefs = useMemo(
    () => uniqueStrings([
      ...(Array.isArray(structuredReferenceIds) ? structuredReferenceIds : []),
    ]),
    [structuredReferenceIds]
  );
  const closureRefs = useMemo(
    () => uniqueStrings([
      ...(Array.isArray(request.issue_closures) ? request.issue_closures : []),
      ...(Array.isArray(request.issues) ? request.issues as string[] : []),
    ]),
    [request.issue_closures, request.issues]
  );
  const canIssueLink = Boolean(repoId) && !looksLikeBranchName(repoId);
  const hasLinks = (referenceRefs.length > 0 || closureRefs.length > 0) && canIssueLink;

  const previousRequestIdRef = useRef<string | null>(null);
  const previousStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const selectionChanged = previousRequestIdRef.current !== fullId;
    const previous = previousStatusRef.current;

    if (selectionChanged) {
      setViewMode(autoShowConsoleOnApproval && isAuthExecutingStatus(status) ? 'console' : 'abstract');
    } else if (autoShowConsoleOnApproval && isAuthExecutingStatus(status)
      && (previous === null || !isAuthExecutingStatus(previous))) {
      setViewMode('console');
    }
    if (autoReturnToAbstractOnSuccess && status === 'completed'
      && (request.exit_code == null || request.exit_code === 0)
      && previous !== null && isAuthExecutingStatus(previous)) {
      setViewMode('abstract');
    }

    previousRequestIdRef.current = fullId;
    previousStatusRef.current = status;
  }, [autoReturnToAbstractOnSuccess, autoShowConsoleOnApproval, fullId, request.exit_code, status]);

  useEffect(() => {
    if (viewMode === 'console' && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [viewMode, consoleText]);

  const authType = getAuthType(request);
  const typeMeta = AUTH_TYPE_META[authType];
  const showDiffStats = typeHasDiffStats(authType);
  const hasStats = stats.files != null || stats.additions != null || stats.deletions != null;
  const statsSummary = showDiffStats && hasStats
    ? `${formatNumber(stats.files ?? 0)} files · +${formatNumber(stats.additions ?? 0)} -${formatNumber(stats.deletions ?? 0)}`
    : null;
  const shortRef = requestHash || 'unknown';
  const requester = request.requester ?? null;
  const requesterDisplayName = requester?.display_name
    ? /^(codex|claude(?: code)?)$/i.test(requester.display_name.trim())
      ? requester.display_name.toLowerCase().startsWith('codex') ? 'codex' : 'claude'
      : requester.display_name
    : null;
  const approver = request.approver ?? null;
  const latestLifecycle = request.lifecycle_events?.at(-1) ?? null;
  // A daemon that predates `merge_signature` sends nothing; absent evidence is
  // "none", never "verified".
  const signatureClaim: MergeSignatureClaim = request.merge_signature ?? { state: 'none' };
  const hasActionBundle = Boolean(actionBundle);
  const panelsClass = hasActionBundle
    ? 'auth-detail__panels auth-detail__panels--with-actions'
    : 'auth-detail__panels auth-detail__panels--single';

  const createdAt = formatMetadataTimestamp(request.created_at ?? null);
  const lastExecutedAt = formatMetadataTimestamp(request.last_executed_at ?? null);
  const resolvedAt = formatMetadataTimestamp(request.resolved_at ?? null);
  const finalizedAt = formatMetadataTimestamp(request.finalized_at as string | number | null | undefined);
  const mergeSha = getStringField(request, 'merge_sha') ?? getStringField(request, 'merged_sha');
  const targetSession = getStringField(request, 'target_session_id');
  const targetRepo = getStringField(request, 'target_repo');
  const conversationId = getStringField(request, 'conversation_id') ?? getStringField(request, 'target_conversation_id');
  const closeActionsAfter = (callback: () => void) => {
    callback();
    setActionsOpen(false);
  };

  const modeTabs: readonly IconTab[] = [
    { id: 'abstract', label: 'Info', tooltip: 'Info', icon: <InfoIcon size={18} /> },
    { id: 'console', label: 'Console', tooltip: 'Console', icon: <TerminalIcon size={18} /> },
    { id: 'diff', label: 'Diff', tooltip: 'Diff', icon: <DiffIcon size={18} /> },
  ];
  const subheader = (
    <>
      <div className="auth-detail__aux-left">
        <IconTabList
          ariaLabel="Approval request view"
          tabs={modeTabs}
          activeTab={viewMode}
          onActiveTabChange={(tab) => setViewMode(tab as typeof viewMode)}
          idPrefix="auth-detail"
          className="auth-detail__mode-tabs"
        />
      </div>
      <div className="auth-detail__action-strip">
        {actions}
      </div>
    </>
  );

  const overlays = (
    <DetailPaneModal
      open={metadataOpen}
      onClose={() => setMetadataOpen(false)}
      titleId="auth-metadata-title"
      title="Approval metadata"
      closeLabel="Close auth metadata"
      excludeAboveRef={headerRef}
      scrollOwnerSelector=".auth-detail"
      scrollLockClassName="auth-detail--metadata-open"
      className="auth-detail__metadata-modal"
      panelClassName="auth-detail__metadata-panel"
    >
      <dl className="auth-detail-metadata__content">
        <MetadataRow
          label="Full request id"
          value={(
            <button
              type="button"
              className="auth-detail-metadata__copy"
              onClick={() => void copyAuthText(fullId)}
            >
              {fullId || 'unknown'}
            </button>
          )}
        />
        <MetadataRow label="Status" value={status} />
        <MetadataRow label="Type" value={authType} />
        <MetadataRow label="Repo" value={repoId || null} />
        <MetadataRow label="Head branch" value={headBranch ?? null} />
        <MetadataRow label="Base branch" value={baseBranch ?? null} />
        <MetadataRow label="Created" value={createdAt} />
        <MetadataRow label="Updated" value={formatMetadataTimestamp(request.updated_at ?? null)} />
        <MetadataRow label="Last executed" value={lastExecutedAt} />
        <MetadataRow label="Resolved" value={resolvedAt} />
        <MetadataRow label="Approval source" value={request.approval_source ?? null} />
        <MetadataRow label="Approval lease" value={request.approval_lease_id ?? null} />
        <MetadataRow label="Clearance use" value={request.clearance_use_id ?? null} />
        <MetadataRow label="Requester evidence" value={request.requester_evidence_method ?? null} />
        <MetadataRow label="Requester credential" value={request.requester_credential_id ?? null} />
        <MetadataRow label="Requester" value={requester?.display_name ?? request.requested_by_user_id ?? null} />
        <MetadataRow label="Approver" value={approver?.display_name ?? request.approved_by_user_id ?? null} />
        <MetadataRow label="Execution evidence" value={request.execution_evidence?.evidence_method ?? null} />
        <MetadataRow label="Lifecycle revision" value={latestLifecycle ? String(latestLifecycle.revision) : null} />
        <MetadataRow label="Revision digest" value={latestLifecycle?.snapshot_sha256 ?? null} />
        <MetadataRow label="Lifecycle actor" value={latestLifecycle?.actor_user_id ?? null} />
        <MetadataRow label="Lifecycle reason" value={latestLifecycle?.reason ?? null} />
        <MetadataRow label="Supersedes request" value={request.supersedes_request_id ?? null} />
        <MetadataRow label="Superseded by request" value={request.superseded_by_request_id ?? null} />
        <MetadataRow label="Dependency id" value={request.depends_on_id ?? null} />
        <MetadataRow label="Dependency readiness" value={request.dependency?.state ?? null} />
        <MetadataRow label="Dependency status" value={request.dependency?.status ?? null} />
        <MetadataRow label="Dependency outcome" value={request.dependency?.outcome ?? null} />
        <MetadataRow label="Merge SHA" value={mergeSha} />
        <MetadataRow label="Finalized" value={finalizedAt} />
        <MetadataRow label="Session" value={sessionId ?? null} />
        <MetadataRow label="Target session" value={targetSession} />
        <MetadataRow label="Target repo" value={targetRepo} />
        <MetadataRow label="Conversation" value={conversationId} />
      </dl>
    </DetailPaneModal>
  );

  return (
    <DetailPaneShell
      className={`auth-detail__pane auth-detail-pane${history ? ' auth-detail-pane--history' : ''}`}
      headerClassName="auth-detail__header"
      headerPrimaryClassName="auth-detail__header-primary"
      subheaderClassName="auth-detail__aux-header"
      bodyClassName={`auth-detail__body${viewMode === 'console' ? ' auth-detail__body--console' : ''}`}
      headerRef={headerRef}
      subheader={subheader}
      notice={notice}
      overlays={overlays}
      header={(
        <DetailPaneHeader
          variant="standard"
          identity={{
            entityLabel: repoName,
            displayRef: shortRef,
            canonicalRef: fullId,
            copyRef: `auth:${shortRef}`,
            copyLabel: `Copy auth:${shortRef}`,
          }}
          title={<span dangerouslySetInnerHTML={{
            __html: linkifyArtifactRefs(renderInlineMarkdown(getAuthTitle(request))),
          }} />}
          status={(
            <>
              <span
                className={statusClass}
                title={completedConvergence ? convergenceTitle(completedConvergence) : undefined}
              >
                {statusLabel}
              </span>
              {attemptLabel && <span className="attempt-tag">{attemptLabel}</span>}
            </>
          )}
          actions={(
            <div className="auth-detail__header-actions">
              <DetailPaneMenuTrigger
                buttonRef={actionsTriggerRef}
                label="Approval actions"
                expanded={actionsOpen}
                onClick={() => setActionsOpen((open) => !open)}
              />
              {actionsOpen && (
                <div
                  ref={actionsMenuRef}
                  className="auth-detail__actions-menu app-anchored-menu"
                  role="menu"
                  popover="manual"
                  style={actionsMenuStyle}
                >
                  <button
                    type="button"
                    className="auth-detail__actions-item"
                    role="menuitem"
                    onClick={() => closeActionsAfter(() => setMetadataOpen(true))}
                  >
                    Show metadata
                  </button>
                </div>
              )}
            </div>
          )}
          actionsLabel="Approval header actions"
          secondaryMetadata={(
            <div className="auth-detail__secondary-metadata">
              <div className="auth-detail__subtitle">
                <span className="auth-detail__primary-metadata">
                  {statsSummary && <span>{statsSummary}</span>}
                  <EntityTimestamps
                    createdAt={request.created_at}
                    updatedAt={request.updated_at}
                    createdBy={requesterDisplayName}
                  />
                </span>
                <span className="auth-detail__subtitle-line">
                  {typeMeta.label.toLowerCase()}
                  {(headBranch && baseBranch) ? (
                    <>
                      {' · '}<code>{headBranch}</code>{' \u2192 '}<code>{baseBranch}</code>
                    </>
                  ) : commitBranch ? (
                    <>{' · '}<code>{commitBranch}</code></>
                  ) : null}
                </span>
              </div>
              {(approver || signatureClaim.state !== 'none') && (
                <div className="auth-detail__attribution" aria-label="Approval attribution">
                  {approver && (
                    <div>
                      Approved by{' '}
                      <AttributionIdentity
                        display={approver.display_name}
                        user={approver}
                        attribution={request.execution_evidence}
                        source="auth_queue"
                      />
                    </div>
                  )}
                  {signatureClaim.state === 'unverified' && (
                    <span className="auth-detail__unverified-signature">
                      {signatureClaim.reason
                        ? `Signature NOT verified: ${signatureClaim.reason}`
                        : 'Signature NOT verified'}
                    </span>
                  )}
                </div>
              )}
              {hasLinks && (
                <div className="auth-detail__links">
                  {referenceRefs.length > 0 && canIssueLink && (
                    <span className="auth-card__issue-group">
                      <span className="auth-card__issue-group-label">References</span>
                      {referenceRefs.map((ref) => (
                        <EntityPill key={ref} type="issue" id={ref} repoId={repoId} />
                      ))}
                    </span>
                  )}
                  {closureRefs.length > 0 && canIssueLink && (
                    <span className="auth-card__issue-group">
                      <span className="auth-card__issue-group-label">Closes</span>
                      {closureRefs.map((ref) => (
                        <EntityPill key={ref} type="issue" id={ref} repoId={repoId} />
                      ))}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        />
      )}
    >
        {showFailure && (
          <div className={`auth-failure${status === 'expired' ? ' auth-failure--expired' : ''}`}>
            <div className="auth-failure__header">
              <span className="auth-failure__title">
                {status === 'expired'
                  ? 'Expired'
                  : status === 'needs_rebase'
                    ? 'Needs rebase'
                    : 'Failed'}
              </span>
              {request.exit_code != null && request.exit_code !== 0 && (
                <span className="auth-failure__code">Exit {request.exit_code}</span>
              )}
            </div>
            <p className="auth-failure__summary">
              {failureSummary ||
                (status === 'expired'
                  ? 'Expired without a response.'
                  : status === 'needs_rebase'
                    ? 'Another auth merge changed the target branch; rebase and retry this request.'
                    : 'No output captured.')}
            </p>
          </div>
        )}

        {executionCallout && (
          <div className="auth-yubikey-warning">
            {executionCallout.spinner && (
              <span className="auth-yubikey-warning__spinner" aria-hidden="true" />
            )}
            <span className="auth-yubikey-warning__text">
              {executionCallout.text}
            </span>
          </div>
        )}

        {viewMode === 'diff' ? (
          <div id="auth-detail-panel-diff" role="tabpanel" aria-labelledby="auth-detail-tab-diff">
          <DiffView
            diffText={diffRaw}
            mode={diffMode}
            onModeChange={setDiffMode}
            ariaLabel="Approval request changes"
            emptyMessage="No diff available for this request."
            className="auth-detail__diff-view"
            classNames={AUTH_DIFF_VIEW_CLASS_NAMES}
          />
          </div>
        ) : viewMode === 'console' ? (
          <div id="auth-detail-panel-console" role="tabpanel" aria-labelledby="auth-detail-tab-console" className="auth-detail__console-view">
            {hasConsoleOutput ? (
              <pre className="console-output__pre">{consoleText}<div ref={consoleEndRef} /></pre>
            ) : (
              <div className="auth-detail__console-empty">No console output.</div>
            )}
          </div>
        ) : (
          <div id="auth-detail-panel-abstract" role="tabpanel" aria-labelledby="auth-detail-tab-abstract">
          <div className={panelsClass}>
            <div className="auth-detail__left-col">
              <CollapsiblePanel
                title="Commit message"
                expanded={showCommit}
                onExpandedChange={setShowCommit}
                bodyClassName="spec-panel"
                actions={onUpdateField && mutationsAllowed
                    && (status === 'pending' || (failedLike && !isCanonicalMessage))
                    && !editingCommitMsg && (
                    <button
                      type="button"
                      className="panel__edit-btn"
                      onClick={() => {
                        setEditCommitValue(commitMsg);
                        setEditingCommitMsg(true);
                      }}
                    >
                      edit
                    </button>
                  )}
              >
                  {editingCommitMsg ? (
                    <>
                      <textarea
                        className="panel__edit-textarea"
                        value={editCommitValue}
                        onInput={(e) => setEditCommitValue((e.target as HTMLTextAreaElement).value)}
                        disabled={!mutationsAllowed}
                        rows={8}
                      />
                      <div className="panel__edit-actions">
                        <button
                          type="button"
                          className="panel__edit-save"
                          disabled={!mutationsAllowed}
                          onClick={() => {
                            const id = getAuthId(request);
                            if (id && onUpdateField && mutationsAllowed) {
                              void onUpdateField(id, 'commit_message', editCommitValue);
                            }
                            setEditingCommitMsg(false);
                          }}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="panel__edit-cancel"
                          onClick={() => setEditingCommitMsg(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : commitHtml ? (
                    <div
                      className="rendered-markdown"
                      dangerouslySetInnerHTML={{ __html: commitHtml }}
                    />
                  ) : (
                    <div className="spec-panel--empty">
                      No commit message provided. Merge will use git's default message.
                    </div>
                  )}
              </CollapsiblePanel>
              <CollapsiblePanel
                title="Specification"
                expanded={showSpec}
                onExpandedChange={setShowSpec}
                bodyClassName="spec-panel"
              >
                {specHtml ? (
                    <div
                      className="rendered-markdown"
                      dangerouslySetInnerHTML={{ __html: specHtml }}
                    />
                  ) : (
                    <div className="spec-panel--empty">
                      No specification attached.
                    </div>
                  )}
              </CollapsiblePanel>
              {authType === 'merge' && (
                <AuthChangeBreakdown
                  requestId={fullId}
                  report={request.change_report ?? null}
                />
              )}
            </div>
            {hasActionBundle && (
              <div className="auth-detail__right-col">
                {actionBundle}
              </div>
            )}
          </div>
          </div>
        )}
    </DetailPaneShell>
  );
}

/** Compact sidebar list item for the auth queue sidebar layout. */
function AuthSidebarItem({
  request,
  selected,
  onSelect,
}: {
  request: AuthRequest;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const id = getAuthId(request);
  const status = getAuthStatus(request);
  const exitCode = request.exit_code ?? null;
  const failedLike = isFailedLikeStatus(status, exitCode);

  // Determine dot class for status indicator
  let dotStatus: string;
  if (failedLike) {
    dotStatus = 'failed';
  } else if (status === 'completed') {
    dotStatus = 'completed';
  } else if (isAuthExecutingStatus(status)) {
    dotStatus = 'approved';  // Keep CSS class as 'approved' for now
  } else if (status === 'rejected' || status === 'withdrawn' || status === 'superseded' || status === 'dismissed') {
    dotStatus = 'dismissed';
  } else {
    dotStatus = status;
  }

  const authType = getAuthType(request);
  const sidebarTypeMeta = AUTH_TYPE_META[authType];
  const actionCount = getActionCount(request);

  const headBranch = request.head_branch ?? request.head ?? '';
  const baseBranch = request.base_branch ?? request.base ?? '';
  const branchInfo = headBranch && baseBranch ? `${headBranch} \u2192 ${baseBranch}` : headBranch;

  const isHistory = isHistoryStatus(status, exitCode);
  const timestampLabel = isHistory
    ? getResolvedTimestampLabel(request)
    : getSubmissionTimestampLabel(request);

  const repo = request.repo && request.repo.trim() ? request.repo.trim() : null;

  return (
    <button
      type="button"
      className={`auth-sidebar-item${selected ? ' auth-sidebar-item--selected' : ''}`}
      data-request-id={id}
      onClick={() => onSelect(id)}
    >
      <span className={`auth-sidebar-item__dot auth-sidebar-item__dot--${dotStatus}`} />
      <span className="auth-sidebar-item__body">
        <span className="auth-sidebar-item__title-row">
          <span className={`type-badge type-badge--sm ${sidebarTypeMeta.cssClass}`}>
            {sidebarTypeMeta.label}
          </span>
          {/* Bug: a44fd6a — render auth sidebar title as inline markdown */}
          <span
            className="auth-sidebar-item__title"
            dangerouslySetInnerHTML={{
              __html: linkifyArtifactRefs(renderInlineMarkdown(getAuthTitle(request))),
            }}
          />
          {actionCount > 0 && (
            <span className="auth-sidebar-item__action-badge" title={`${actionCount} deferred actions`}>
              {actionCount}
            </span>
          )}
        </span>
        {repo && (
          <span className="auth-sidebar-item__repo">{repo}</span>
        )}
        {branchInfo && (
          <span className="auth-sidebar-item__branch">{branchInfo}</span>
        )}
        <span className="auth-sidebar-item__time">{timestampLabel}</span>
      </span>
    </button>
  );
}

/** Hooks management panel for auth hook settings. */
export function AuthHooksPanel({
  onClose,
  instance,
}: {
  onClose?: () => void;
  instance?: InstanceInfo | null;
}): JSX.Element {
  const [hooks, setHooks] = useState<AuthHook[]>([]);
  const readAvailable = canPerformOperation(instance, 'GET', '/api/auth/hooks');
  const createAllowed = canPerformOperation(instance, 'POST', '/api/auth/hooks');
  const [loading, setLoading] = useState(readAvailable);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editSaveError, setEditSaveError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editSaveState, setEditSaveState] = useState<'idle' | 'incomplete' | 'saving' | 'saved'>('idle');
  const editSaveTimerRef = useRef<number | null>(null);
  const editSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const editSaveRevisionRef = useRef(0);
  const editSaveBaselineRef = useRef<string | null>(null);
  const editSaveQueuedSignatureRef = useRef<string | null>(null);
  const pendingEditRef = useRef<{
    id: string;
    values: { repo_pattern: string; auth_type: AuthRequestType; command: string; label: string };
    signature: string;
  } | null>(null);
  const updateAllowed = (id: string) => canPerformOperation(instance, 'PUT', `/api/auth/hooks/${id}`);
  const deleteAllowed = (id: string) => canPerformOperation(instance, 'DELETE', `/api/auth/hooks/${id}`);
  const formChangesAllowed = readAvailable && (editId ? updateAllowed(editId) : createAllowed);
  const changesUnavailable = !createAllowed || hooks.some((hook) => !updateAllowed(hook.id) || !deleteAllowed(hook.id));

  // Form fields
  const [formRepo, setFormRepo] = useState('*');
  const [formType, setFormType] = useState<AuthRequestType>('merge');
  const [formCommand, setFormCommand] = useState('');
  const [formLabel, setFormLabel] = useState('');

  const editValues = { repo_pattern: formRepo, auth_type: formType, command: formCommand, label: formLabel };
  const editSignature = JSON.stringify(editValues);
  const editSignatureRef = useRef(editSignature);
  editSignatureRef.current = editSignature;

  if (showForm && editId && editSignature !== editSaveQueuedSignatureRef.current) {
    pendingEditRef.current = { id: editId, values: editValues, signature: editSignature };
  } else {
    pendingEditRef.current = null;
  }

  const persistEdit = useCallback(async (
    id: string,
    values: typeof editValues,
    signature: string,
  ): Promise<boolean> => {
    if (!values.repo_pattern.trim() || !values.command.trim()) {
      setEditSaveState('incomplete');
      return false;
    }
    if (signature === editSaveQueuedSignatureRef.current) {
      await editSaveQueueRef.current;
      return signature === editSaveBaselineRef.current;
    }
    const revision = ++editSaveRevisionRef.current;
    editSaveQueuedSignatureRef.current = signature;
    setEditSaveError(null);
    setEditSaveState('saving');
    let succeeded = false;
    editSaveQueueRef.current = editSaveQueueRef.current.catch(() => undefined).then(async () => {
      try {
        const saved = await updateAuthHook(id, values);
        succeeded = true;
        if (revision === editSaveRevisionRef.current) {
          editSaveBaselineRef.current = signature;
          setHooks((current) => current.map((hook) => hook.id === id ? saved : hook));
          if (editSignatureRef.current === signature) setEditSaveState('saved');
        }
      } catch (err) {
        if (revision === editSaveRevisionRef.current) {
          setEditSaveError(err instanceof Error ? err.message : 'Failed to update hook');
          editSaveQueuedSignatureRef.current = editSaveBaselineRef.current;
          setEditSaveState('idle');
        }
      }
    });
    await editSaveQueueRef.current;
    return succeeded;
  }, []);

  const persistEditRef = useRef(persistEdit);
  persistEditRef.current = persistEdit;

  useEffect(() => () => {
    if (editSaveTimerRef.current !== null) window.clearTimeout(editSaveTimerRef.current);
    const pending = pendingEditRef.current;
    if (pending) void persistEditRef.current(pending.id, pending.values, pending.signature);
  }, []);

  useEffect(() => {
    if (!showForm || !editId) return;
    if (editSaveTimerRef.current !== null) window.clearTimeout(editSaveTimerRef.current);
    if (editSignature === editSaveQueuedSignatureRef.current) {
      setEditSaveState(editSignature === editSaveBaselineRef.current ? 'saved' : 'saving');
      return;
    }
    if (!formRepo.trim() || !formCommand.trim()) {
      setEditSaveState('incomplete');
      return;
    }
    setEditSaveState('idle');
    setEditSaveError(null);
    editSaveTimerRef.current = window.setTimeout(() => {
      editSaveTimerRef.current = null;
      void persistEdit(editId, editValues, editSignature);
    }, 350);
    return () => {
      if (editSaveTimerRef.current !== null) window.clearTimeout(editSaveTimerRef.current);
      editSaveTimerRef.current = null;
    };
  }, [showForm, editId, editSignature, formRepo, formCommand, persistEdit]);

  const loadHooks = useCallback(async () => {
    if (!readAvailable) {
      setHooks([]);
      setLoadError(null);
      setActionError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchAuthHooks();
      setHooks(data);
      setActionError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load hooks');
    } finally {
      setLoading(false);
    }
  }, [readAvailable]);

  useEffect(() => { void loadHooks(); }, [loadHooks]);

  const resetForm = () => {
    if (editSaveTimerRef.current !== null) window.clearTimeout(editSaveTimerRef.current);
    editSaveTimerRef.current = null;
    editSaveRevisionRef.current += 1;
    editSaveBaselineRef.current = null;
    editSaveQueuedSignatureRef.current = null;
    pendingEditRef.current = null;
    setFormRepo('*');
    setFormType('merge');
    setFormCommand('');
    setFormLabel('');
    setEditId(null);
    setShowForm(false);
    setEditSaveState('idle');
    setEditSaveError(null);
  };

  const handleCreate = async () => {
    if (!createAllowed) {
      setActionError('Approval hook changes are unavailable in this instance.');
      return;
    }
    setActionError(null);
    try {
      await createAuthHook(editValues);
      resetForm();
      await loadHooks();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create hook');
    }
  };

  const handleFinishEdit = async () => {
    if (!editId) return true;
    if (editSaveTimerRef.current !== null) window.clearTimeout(editSaveTimerRef.current);
    editSaveTimerRef.current = null;
    const saved = await persistEdit(editId, editValues, editSignature);
    if (saved) resetForm();
    return saved;
  };

  const handleAdd = async () => {
    if (editId && !(await handleFinishEdit())) return;
    resetForm();
    setShowForm(true);
  };

  const handleEdit = async (hook: AuthHook) => {
    if (!updateAllowed(hook.id)) return;
    if (editId && editId !== hook.id && !(await handleFinishEdit())) return;
    setFormRepo(hook.repo_pattern);
    setFormType(hook.auth_type as AuthRequestType);
    setFormCommand(hook.command);
    setFormLabel(hook.label);
    setEditId(hook.id);
    editSaveBaselineRef.current = JSON.stringify({
      repo_pattern: hook.repo_pattern,
      auth_type: hook.auth_type,
      command: hook.command,
      label: hook.label,
    });
    editSaveQueuedSignatureRef.current = editSaveBaselineRef.current;
    setEditSaveState('saved');
    setShowForm(true);
  };

  const handleToggle = async (hook: AuthHook) => {
    if (hook.builtin || !updateAllowed(hook.id)) return; // Built-in hooks cannot be toggled
    setActionError(null);
    try {
      await updateAuthHook(hook.id, { enabled: !hook.enabled });
      await loadHooks();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to toggle hook');
    }
  };

  const handleDelete = async (hook: AuthHook) => {
    if (hook.builtin || !deleteAllowed(hook.id)) return;
    setActionError(null);
    try {
      await deleteAuthHook(hook.id);
      await loadHooks();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete hook');
    }
  };

  return (
    <div className="auth-hooks-panel">
      <div className="auth-hooks-panel__header">
        <h2 className="auth-hooks-panel__title">Approval Hooks</h2>
        <div className="auth-hooks-panel__actions">
          <button
            type="button"
            className="auth-hooks-panel__add-button"
            onClick={() => void handleAdd()}
            disabled={!createAllowed}
            aria-label="Add approval hook"
            title="Add approval hook"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
              <path d="M8 2.5v11M2.5 8h11" />
            </svg>
          </button>
          {onClose && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={onClose}
            >
              Close
            </button>
          )}
        </div>
      </div>

      {loadError && readAvailable && (
        <DetailPaneNotice severity="error" density="compact" title="Approval Hooks could not be loaded" actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => { void loadHooks(); }}>Retry loading</button>
        }>{loadError}</DetailPaneNotice>
      )}
      {actionError && <DetailPaneNotice severity="error" density="compact" title="Approval Hooks action failed">{actionError}</DetailPaneNotice>}
      {!readAvailable && (
        <DetailPaneNotice severity="info" density="compact" title="Approval Hooks unavailable">
          This instance cannot read approval-hook configuration.
        </DetailPaneNotice>
      )}
      {readAvailable && changesUnavailable && (
        <DetailPaneNotice severity="info" density="compact" title="Approval-hook changes unavailable">
          This instance can read approval hooks, but cannot change their configuration.
        </DetailPaneNotice>
      )}

      {showForm && (
        <div className="auth-hooks-panel__form" data-settings-searchable>
          <div className="auth-hooks-panel__form-row" data-settings-searchable>
            <label>Label</label>
            <input
              type="text"
              placeholder="Hook description"
              value={formLabel}
              onInput={(e) => setFormLabel((e.target as HTMLInputElement).value)}
              disabled={!formChangesAllowed}
              aria-label="Hook label"
            />
          </div>
          <div className="auth-hooks-panel__form-row" data-settings-searchable>
            <label>Repo pattern</label>
            <input
              type="text"
              placeholder="* for all, or repo name"
              value={formRepo}
              onInput={(e) => setFormRepo((e.target as HTMLInputElement).value)}
              disabled={!formChangesAllowed}
              aria-label="Repository pattern"
            />
          </div>
          <div className="auth-hooks-panel__form-row" data-settings-searchable>
            <label>Approval type</label>
            <select
              value={formType}
              onChange={(e) => setFormType((e.target as HTMLSelectElement).value as AuthRequestType)}
              disabled={!formChangesAllowed}
              aria-label="Approval type"
            >
              <option value="merge">Merge</option>
              <option value="commit">Commit</option>
              <option value="force-push">Force Push</option>
              <option value="branch-delete">Branch Delete</option>
              <option value="config-change">Config Change</option>
              <option value="data-delete">Data Delete</option>
            </select>
          </div>
          <div className="auth-hooks-panel__form-row" data-settings-searchable>
            <label>Command</label>
            <textarea
              placeholder="Shell command to run after approval action"
              value={formCommand}
              rows={3}
              onInput={(e) => setFormCommand((e.target as HTMLTextAreaElement).value)}
              disabled={!formChangesAllowed}
              aria-label="Hook command"
            />
            {editId && (editSaveError ? (
              <span className="auth-hooks-panel__save-status auth-hooks-panel__save-status--error" role="alert">
                {editSaveError}
              </span>
            ) : (
              <span className="auth-hooks-panel__save-status" role="status" aria-live="polite">
                {editSaveState === 'saving' ? 'Saving…' : editSaveState === 'saved' ? 'Saved' : editSaveState === 'incomplete' ? 'Enter a repository pattern and command to save' : 'Changes save automatically'}
              </span>
            ))}
          </div>
          <div className="auth-hooks-panel__form-actions">
            {editId ? (
              <>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => void handleFinishEdit()}>
                  Done
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="auth-hooks-panel__add-button auth-hooks-panel__add-button--commit"
                  onClick={() => void handleCreate()}
                  disabled={!formChangesAllowed || !formRepo.trim() || !formCommand.trim()}
                  aria-label="Create approval hook"
                  title="Create approval hook"
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
                    <path d="M8 2.5v11M2.5 8h11" />
                  </svg>
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={resetForm}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!readAvailable ? (
        <div className="auth-hooks-panel__empty">Approval hooks are unavailable in this instance.</div>
      ) : loading ? (
        <div className="auth-hooks-panel__empty">Loading hooks...</div>
      ) : loadError ? null : hooks.length === 0 ? (
        <div className="auth-hooks-panel__empty">No hooks configured.</div>
      ) : (
        <div className="auth-hooks-panel__list">
          {hooks.map((hook) => (
            <div
              key={hook.id}
              data-settings-searchable
              className={`auth-hooks-panel__item${!hook.enabled ? ' auth-hooks-panel__item--disabled' : ''}${hook.builtin ? ' auth-hooks-panel__item--builtin' : ''}`}
            >
              <div className="auth-hooks-panel__item-header">
                <button
                  type="button"
                  className={`auth-hooks-panel__toggle${hook.enabled ? ' auth-hooks-panel__toggle--on' : ''}`}
                  onClick={() => void handleToggle(hook)}
                  disabled={hook.builtin || !updateAllowed(hook.id)}
                  title={hook.builtin ? 'Built-in hooks are always enabled' : !updateAllowed(hook.id) ? 'Unavailable in this instance' : (hook.enabled ? 'Disable' : 'Enable')}
                >
                  {hook.enabled ? 'ON' : 'OFF'}
                </button>
                <span className="auth-hooks-panel__item-label">
                  {hook.label || hook.command}
                </span>
                {hook.builtin && (
                  <span className="auth-hooks-panel__builtin-badge">built-in</span>
                )}
              </div>
              <div className="auth-hooks-panel__item-meta">
                <span className={`type-badge type-badge--sm ${AUTH_TYPE_META[hook.auth_type as AuthRequestType]?.cssClass ?? 'type-badge--merge'}`}>
                  {AUTH_TYPE_META[hook.auth_type as AuthRequestType]?.label ?? hook.auth_type}
                </span>
                <span className="auth-hooks-panel__item-repo">{hook.repo_pattern}</span>
              </div>
              <div className="auth-hooks-panel__item-command">
                <code>{hook.command}</code>
              </div>
              {!hook.builtin && (
                <div className="auth-hooks-panel__item-actions">
                  <button
                    type="button"
                    className="auth-hooks-panel__item-action"
                    onClick={() => void handleEdit(hook)}
                    disabled={!updateAllowed(hook.id)}
                    aria-label={`Edit ${hook.label || hook.command}`}
                    title="Edit hook"
                  >
                    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m10.8 2.5 2.7 2.7M3 13l2.5-.5L13 5a1.9 1.9 0 0 0-2.7-2.7L2.8 9.8 2.3 12.3 3 13Z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="auth-hooks-panel__item-action auth-hooks-panel__item-action--delete"
                    onClick={() => void handleDelete(hook)}
                    disabled={!deleteAllowed(hook.id)}
                    aria-label={`Delete ${hook.label || hook.command}`}
                    title="Delete hook"
                  >
                    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2.5 4h11M6 4V2.5h4V4m2.5 0-.6 9H4.1l-.6-9m3 2.5v4m3-4v4" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const AUTH_TYPE_OPTIONS: { value: AuthRequestType | 'all'; label: string }[] = [
  { value: 'all', label: 'All types' },
  ...AUTH_REQUEST_TYPES.map(value => ({ value, label: AUTH_TYPE_META[value].label })),
];

type AuthFilterMode = 'active' | 'all' | 'historical';

export function AuthQueueView({
  queue,
  historyQueue,
  outputs,
  branchesByRepo,
  selectedAuthId: externalSelectedId,
  initialRequestId,
  onSelectAuth,
  onApprove,
  onReject,
  onRetry,
  onUpdateField,
  sidebarHidden = false,
  daemonReady = true,
  instance = null,
  autoShowConsoleOnApproval = true,
  autoReturnToAbstractOnSuccess = true,
  retainFinalizedSelection = true,
}: AuthQueueViewProps): JSX.Element {
  // Sidebar filter: Active (default) | All | Historical
  const [filterMode, setFilterMode] = useState<AuthFilterMode>('active');

  // Type filter: 'all' = show all types
  const [typeFilter, setTypeFilter] = useState<AuthRequestType | 'all'>('all');

  // Repo filter: null = show all repos
  const [repoFilter, setRepoFilter] = useState<string | null>(null);

  // Branch filter: null = show all branches within the selected repo
  const [branchFilter, setBranchFilter] = useState<string | null>(null);

  // Branch autocomplete input text (separate from the committed filter value)
  const [branchInput, setBranchInput] = useState<string>('');
  const [authSearch, setAuthSearch] = useState('');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Local selection state — mirrors app state via onSelectAuth
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = externalSelectedId !== undefined ? externalSelectedId : localSelectedId;

  // Bug: 0de95bf — history list rows omit the diff/spec/output body blobs. The
  // detail body is fetched from the detail route when a request is selected and
  // cached here so the detail pane can render the full spec/diff/console.
  // (commit_message stays in the list projection, so it is not re-fetched.)
  type AuthRequestBody = {
    diff_summary: string;
    spec_content: string;
    output: string;
    change_report: AuthChangeReport | null;
  };
  const [hydratedBodies, setHydratedBodies] = useState<Record<string, AuthRequestBody>>({});

  // Bug: 2cddba2 — the deep-linked selection propagates through a state update
  // that lands after the first effect pass, and may reference a request outside
  // the loaded lists. While set, sidebar reconciliation holds that selection;
  // cleared when the user picks another row.
  const pendingDeepLinkRef = useRef<string | null>(null);
  const previousSelectionFiltersRef = useRef({ filterMode, typeFilter, repoFilter, branchFilter, authSearch });
  useEffect(() => {
    const previous = previousSelectionFiltersRef.current;
    const changed = previous.filterMode !== filterMode
      || previous.typeFilter !== typeFilter
      || previous.repoFilter !== repoFilter
      || previous.branchFilter !== branchFilter
      || previous.authSearch !== authSearch;
    previousSelectionFiltersRef.current = { filterMode, typeFilter, repoFilter, branchFilter, authSearch };
    if (!changed) return;
    pendingDeepLinkRef.current = null;
  }, [authSearch, branchFilter, filterMode, repoFilter, typeFilter]);

  // Track newly finalized requests so the active queue can retain the selected
  // row until the user deliberately moves elsewhere.
  const [recentlyResolved, setRecentlyResolved] = useState<
    Map<string, { status: string; resolvedAt: number }>
  >(() => new Map());

  const [retainedFinalizedId, setRetainedFinalizedId] = useState<string | null>(() => (
    typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(RETAINED_FINALIZED_AUTH_KEY)
  ));

  const clearRetainedFinalized = useCallback(() => {
    if (retainedFinalizedId) {
      setRecentlyResolved((previous) => {
        if (!previous.has(retainedFinalizedId)) return previous;
        const next = new Map(previous);
        next.delete(retainedFinalizedId);
        return next;
      });
    }
    setRetainedFinalizedId(null);
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(RETAINED_FINALIZED_AUTH_KEY);
  }, [retainedFinalizedId]);

  useEffect(() => {
    if (!selectedId || !retainedFinalizedId) return;
    const sameRequest = selectedId === retainedFinalizedId
      || retainedFinalizedId.startsWith(selectedId);
    if (!sameRequest) clearRetainedFinalized();
  }, [clearRetainedFinalized, retainedFinalizedId, selectedId]);

  const handleSelect = useCallback((id: string) => {
    pendingDeepLinkRef.current = null;
    setLocalSelectedId(id);
    onSelectAuth?.(id);
  }, [onSelectAuth]);

  // Bug: bdcc1f5 — deep-link from graph node click: select the initial request
  useEffect(() => {
    if (!initialRequestId) return;
    pendingDeepLinkRef.current = initialRequestId;
    setLocalSelectedId(initialRequestId);
    onSelectAuth?.(initialRequestId);
  // Only run on mount / when initialRequestId changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRequestId]);

  // Bug: bdcc1f5 / review D2 (issue f59b5bd) — scroll the deep-linked row into
  // view keyed on the CURRENT selection: a short-form deep link only matches a
  // sidebar row (keyed by full id) after the canonical-id upgrade below, so
  // this re-arms when the selection upgrades, and each re-run cancels the
  // stale timer so a superseded selection can never scroll.
  useEffect(() => {
    if (!selectedId || pendingDeepLinkRef.current !== selectedId) return;
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-request-id="${selectedId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [selectedId]);

  // Use a ref for timeout tracking so we can clean up
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clean up timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // Detect newly resolved requests by comparing queue status changes.
  const prevQueueRef = useRef<Map<string, { status: string; exitCode: number | null }>>(
    new Map(),
  );
  const [retryCounts, setRetryCounts] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    const prevStatuses = prevQueueRef.current;
    const nextStatuses = new Map<string, { status: string; exitCode: number | null }>();

    for (const request of queue) {
      const id = getAuthId(request);
      const status = getAuthStatus(request);
      const exitCode = request.exit_code ?? null;
      nextStatuses.set(id, { status, exitCode });

      const prevStatus = prevStatuses.get(id);
      if (
        prevStatus &&
        !isHistoryStatus(prevStatus.status, prevStatus.exitCode) &&
        isHistoryStatus(status, exitCode)
      ) {
        setRecentlyResolved((prev) => {
          const next = new Map(prev);
          next.set(id, { status, resolvedAt: Date.now() });
          return next;
        });

        if (retainFinalizedSelection && selectedId === id) {
          setRetainedFinalizedId(id);
          if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(RETAINED_FINALIZED_AUTH_KEY, id);
          continue;
        }

        const existingTimer = timersRef.current.get(id);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          setRecentlyResolved((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          timersRef.current.delete(id);
        }, RESOLVED_LINGER_MS);
        timersRef.current.set(id, timer);
      }

      if (
        prevStatus &&
        isFailedLikeStatus(prevStatus.status, prevStatus.exitCode) &&
        status === 'pending'
      ) {
        setRetryCounts((prev) => {
          const next = new Map(prev);
          next.set(id, (next.get(id) ?? 0) + 1);
          return next;
        });
      }
    }

    prevQueueRef.current = nextStatuses;
  }, [queue, retainFinalizedSelection, selectedId]);

  useEffect(() => {
    if (!retainFinalizedSelection && retainedFinalizedId) clearRetainedFinalized();
  }, [clearRetainedFinalized, retainFinalizedSelection, retainedFinalizedId]);

  const activeQueue = useMemo(
    () =>
      queue.filter((r) => {
        const status = getAuthStatus(r);
        return status === 'pending' || isAuthExecutingStatus(status) ||
          isFailedLikeStatus(status, r.exit_code ?? null);
      }),
    [queue],
  );

  const lingeringQueue = useMemo(
    () => {
      const candidates = [...queue, ...(historyQueue ?? [])];
      const seen = new Set<string>();
      return candidates.filter((r) => {
        const id = getAuthId(r);
        if (seen.has(id)) return false;
        seen.add(id);
        return recentlyResolved.has(id) || retainedFinalizedId === id;
      });
    },
    [historyQueue, queue, recentlyResolved, retainedFinalizedId],
  );

  // Bug: 72384c5 — deduplicate history: exclude IDs already shown in the active queue
  // (failed items with exit_code != 0 live in both listActive and listHistory).
  const activeIds = useMemo(
    () => new Set(activeQueue.map((r) => getAuthId(r))),
    [activeQueue],
  );

  const historyRequests = useMemo(() => {
    // Use dedicated history endpoint data if available, fall back to filtering active queue
    const source = historyQueue && historyQueue.length > 0
      ? historyQueue
      : queue.filter((r) => {
          const status = getAuthStatus(r);
          return isHistoryStatus(status, r.exit_code ?? null);
        });
    // Exclude items still lingering from recent resolution AND items already in active queue
    const filtered = source.filter((r) => {
      const id = getAuthId(r);
      return !recentlyResolved.has(id) && !activeIds.has(id);
    });
    return filtered
      .slice()
      .sort((a, b) => getResolvedAtMs(b) - getResolvedAtMs(a));
  }, [queue, historyQueue, recentlyResolved, activeIds]);

  type SortMode = 'newest' | 'oldest' | 'status';
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [customOrder, setCustomOrder] = useState<string[] | null>(null);

  const sortedActiveQueue = useMemo(() => {
    const sorted = [...activeQueue];
    switch (sortMode) {
      case 'oldest':
        return sorted.sort((a, b) => (getCreatedAtMs(a) ?? 0) - (getCreatedAtMs(b) ?? 0));
      case 'status':
        return sorted.sort((a, b) => getStatusOrder(a) - getStatusOrder(b));
      case 'newest':
      default:
        return sorted.sort((a, b) => (getCreatedAtMs(b) ?? 0) - (getCreatedAtMs(a) ?? 0));
    }
  }, [activeQueue, sortMode]);

  const orderedActiveQueue = useMemo(() => {
    if (!customOrder) return sortedActiveQueue;
    const byId = new Map(sortedActiveQueue.map((request) => [getAuthId(request), request]));
    const ordered = customOrder
      .map((id) => byId.get(id))
      .filter((request): request is AuthRequest => Boolean(request));
    for (const request of sortedActiveQueue) {
      const id = getAuthId(request);
      if (!customOrder.includes(id)) {
        ordered.push(request);
      }
    }
    return ordered;
  }, [customOrder, sortedActiveQueue]);

  const handleSortChange = useCallback((nextMode: SortMode) => {
    setSortMode(nextMode);
    setCustomOrder(null);
  }, []);

  const hasActiveList = orderedActiveQueue.length + lingeringQueue.length > 0;
  const [, setTimeTick] = useState(0);
  useEffect(() => {
    if (!hasActiveList) {
      return;
    }
    const interval = setInterval(() => setTimeTick((t) => t + 1), 30000);
    return () => clearInterval(interval);
  }, [hasActiveList]);

  const [inFlight, setInFlight] = useState<Set<string>>(() => new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const setInFlightState = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setInFlight((prev) => {
        const next = updater(prev);
        inFlightRef.current = next;
        return next;
      });
    },
    [],
  );
  const [actionLists, setActionLists] = useState<Map<string, AuthRequestAction[]>>(() => new Map());
  const [inFlightActionIds, setInFlightActionIds] = useState<Set<string>>(() => new Set());
  const inFlightActionIdsRef = useRef<Set<string>>(new Set());

  const setActionListForRequest = useCallback((requestId: string, actions: AuthRequestAction[]) => {
    setActionLists((prev) => {
      const next = new Map(prev);
      next.set(requestId, actions);
      return next;
    });
  }, []);

  // Install a first-paint action list without overwriting one this session has
  // already loaded or mutated (issue 80ced49).
  const seedActionListForRequest = useCallback((requestId: string, actions: AuthRequestAction[]) => {
    setActionLists((prev) => {
      if (prev.has(requestId)) return prev;
      const next = new Map(prev);
      next.set(requestId, actions);
      return next;
    });
  }, []);

  const updateActionForRequest = useCallback((requestId: string, action: AuthRequestAction) => {
    setActionLists((prev) => {
      const current = prev.get(requestId) ?? [];
      const nextActions = current.some((item) => item.id === action.id)
        ? current.map((item) => (item.id === action.id ? action : item))
        : [...current, action].sort((a, b) => a.ordinal - b.ordinal);
      const next = new Map(prev);
      next.set(requestId, nextActions);
      return next;
    });
  }, []);

  const [actionErrors, setActionErrors] = useState<Map<string, AuthActionError>>(() => new Map());
  const clearActionError = useCallback((requestId: string) => {
    setActionErrors((prev) => {
      if (!prev.has(requestId)) return prev;
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
  }, []);

  const setActionError = useCallback((
    requestId: string,
    error: unknown,
    fallback: string,
    retry: AuthActionRetry,
  ) => {
    const message = error instanceof Error ? error.message : fallback;
    setActionErrors((prev) => {
      const next = new Map(prev);
      next.set(requestId, { message, retry });
      return next;
    });
  }, []);

  const runAction = useCallback(
    (
      id: string,
      action: (requestId: string) => void | Promise<void>,
      fallbackError: string,
      retry: AuthActionRetry,
      pathForRequest: (requestId: string) => string,
    ): boolean => {
      // Bug: 645f8a8 — block all mutating actions while the daemon is not ready
      // (rebuilding / starting). The buttons are also disabled, but gate here too
      // so no mutation POST can fire from a keyboard/programmatic trigger.
      if (!daemonReady || !id || !canPerformOperation(instance, 'POST', pathForRequest(id))) {
        return false;
      }
      if (!id || inFlightRef.current.has(id)) {
        return false;
      }
      clearActionError(id);
      setInFlightState((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      Promise.resolve(action(id))
        .catch((err) => {
          setActionError(id, err, fallbackError, retry);
        })
        .finally(() => {
          setInFlightState((prev) => {
            if (!prev.has(id)) {
              return prev;
            }
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });
      return true;
    },
    [clearActionError, setActionError, setInFlightState, daemonReady, instance],
  );

  const handleApprove = useCallback(
    (id: string) => runAction(
      id,
      onApprove,
      'Approval failed. Try again.',
      { kind: 'approve' },
      (requestId) => `/api/auth/request/${encodeURIComponent(requestId)}/approve`,
    ),
    [runAction, onApprove],
  );

  const handleReject = useCallback(
    (id: string) => runAction(
      id,
      onReject,
      'Rejection failed. Try again.',
      { kind: 'reject' },
      (requestId) => `/api/auth/request/${encodeURIComponent(requestId)}/reject`,
    ),
    [runAction, onReject],
  );

  // Track retry-specific in-flight state so the button label stays exact.
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set());
  const retryingIdsRef = useRef<Set<string>>(new Set());
  const setRetryingIdsState = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setRetryingIds((prev) => {
        const next = updater(prev);
        retryingIdsRef.current = next;
        return next;
      });
    },
    [],
  );

  const handleRetry = useCallback(
    (id: string) => {
      const started = runAction(
        id,
        onRetry,
        'Retry failed. Try again.',
        { kind: 'retry' },
        (requestId) => `/api/auth/request/${encodeURIComponent(requestId)}/retry`,
      );
      if (!started) return;
      setRetryingIdsState((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [runAction, onRetry, setRetryingIdsState],
  );

  // Keep retryingIds in sync with inFlight: remove ids from retryingIds when
  // they leave inFlight (action completed or failed).
  useEffect(() => {
    setRetryingIdsState((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (!inFlight.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlight]);

  const handleToggleActionVeto = useCallback(
    (requestId: string, action: AuthRequestAction, vetoed: boolean) => {
      if (!canPerformOperation(
        instance,
        'POST',
        `/api/auth/request/${encodeURIComponent(requestId)}/actions/${encodeURIComponent(action.id)}/veto`,
        { vetoed },
      )) {
        return;
      }
      if (inFlightActionIdsRef.current.has(action.id)) return;
      clearActionError(requestId);
      setInFlightActionIds((prev) => {
        const next = new Set(prev);
        next.add(action.id);
        inFlightActionIdsRef.current = next;
        return next;
      });
      setAuthRequestActionVeto(requestId, action.id, vetoed)
        .then((updated) => updateActionForRequest(requestId, updated))
        .catch((err) => setActionError(
          requestId,
          err,
          'Action veto update failed.',
          { kind: 'veto', action, vetoed },
        ))
        .finally(() => {
          setInFlightActionIds((prev) => {
            const next = new Set(prev);
            next.delete(action.id);
            inFlightActionIdsRef.current = next;
            return next;
          });
        });
    },
    [clearActionError, instance, setActionError, updateActionForRequest],
  );

  const retryActionError = useCallback((requestId: string, retry: AuthActionRetry) => {
    switch (retry.kind) {
      case 'approve':
        handleApprove(requestId);
        return;
      case 'reject':
        handleReject(requestId);
        return;
      case 'retry':
        handleRetry(requestId);
        return;
      case 'veto':
        handleToggleActionVeto(requestId, retry.action, retry.vetoed);
    }
  }, [handleApprove, handleReject, handleRetry, handleToggleActionVeto]);

  const [rejectConfirmId, setRejectConfirmId] = useState<string | null>(null);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (rejectTimerRef.current) {
        clearTimeout(rejectTimerRef.current);
      }
    };
  }, []);

  const toggleRejectConfirm = useCallback(
    (id: string) => {
      if (rejectConfirmId === id) {
        setRejectConfirmId(null);
        if (rejectTimerRef.current) {
          clearTimeout(rejectTimerRef.current);
          rejectTimerRef.current = null;
        }
        handleReject(id);
        return;
      }
      setRejectConfirmId(id);
      if (rejectTimerRef.current) {
        clearTimeout(rejectTimerRef.current);
      }
      rejectTimerRef.current = setTimeout(() => {
        setRejectConfirmId(null);
        rejectTimerRef.current = null;
      }, 3000);
    },
    [rejectConfirmId, handleReject],
  );

  // Build the sidebar list based on the active filter mode
  const sidebarItems = useMemo((): AuthRequest[] => {
    if (filterMode === 'active') {
      // Active = pending, approved (executing), recently-failed — plus lingering
      const active = [...orderedActiveQueue, ...lingeringQueue];
      // Deduplicate (lingering items may overlap with orderedActiveQueue)
      const seen = new Set<string>();
      return active.filter((r) => {
        const id = getAuthId(r);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    if (filterMode === 'historical') {
      return historyRequests;
    }
    // 'all': active items first (newest), then history
    const allActive = [...orderedActiveQueue, ...lingeringQueue];
    const activeSet = new Set(allActive.map((r) => getAuthId(r)));
    const allHistory = historyRequests.filter((r) => !activeSet.has(getAuthId(r)));
    return [...allActive, ...allHistory];
  }, [filterMode, orderedActiveQueue, lingeringQueue, historyRequests]);

  // Derive unique repo names from all sidebar items (before repo filtering),
  // sorted by most recent activity (most-recently-touched repo first).
  // Bug: 74dd78b — sort repos by recency instead of alphabetically
  const uniqueRepos = useMemo((): string[] => {
    // Track the latest timestamp per repo
    const repoLatest = new Map<string, number>();
    for (const r of sidebarItems) {
      const repo = r.repo && r.repo.trim() ? r.repo.trim() : null;
      if (!repo) continue;
      const ts =
        getTimestampMs(r.resolved_at ?? null) ??
        getTimestampMs(r.last_executed_at ?? null) ??
        getTimestampMs(r.created_at ?? null) ??
        0;
      const existing = repoLatest.get(repo) ?? 0;
      if (ts > existing) repoLatest.set(repo, ts);
    }
    return Array.from(repoLatest.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([repo]) => repo)
      // Bug: bdcc1f5 — filter out old worktree directory artifacts and non-canonical names
      .filter((repo) =>
        !repo.toLowerCase().startsWith('feature') &&
        !repo.includes('__') &&
        repo !== 'main' &&
        repo !== 'Main' &&
        repo !== 'test' &&
        repo !== 'tmp'
      );
  }, [sidebarItems]);

  // Derive unique head-branch names for the currently selected repo (for autocomplete).
  // Bug: 74dd78b — branch autocomplete within selected repo
  const uniqueBranchesForRepo = useMemo((): string[] => {
    if (!repoFilter) return [];
    const branchLatest = new Map<string, number>();
    for (const r of sidebarItems) {
      const repo = r.repo && r.repo.trim() ? r.repo.trim() : null;
      if (repo !== repoFilter) continue;
      const branch = (r.head_branch ?? r.head ?? '').trim();
      if (!branch) continue;
      const ts =
        getTimestampMs(r.resolved_at ?? null) ??
        getTimestampMs(r.last_executed_at ?? null) ??
        getTimestampMs(r.created_at ?? null) ??
        0;
      const existing = branchLatest.get(branch) ?? 0;
      if (ts > existing) branchLatest.set(branch, ts);
    }
    return Array.from(branchLatest.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([branch]) => branch);
  }, [sidebarItems, repoFilter]);

  // Reset repoFilter if it no longer exists in the current list;
  // also reset branchFilter whenever repoFilter changes.
  useEffect(() => {
    if (repoFilter && !uniqueRepos.includes(repoFilter)) {
      setRepoFilter(null);
      setBranchFilter(null);
      setBranchInput('');
    }
  }, [uniqueRepos, repoFilter]);

  // Apply type, repo, and branch filters on top of the mode-filtered list
  const filteredSidebarItems = useMemo((): AuthRequest[] => {
    let items = sidebarItems;
    const query = authSearch.trim().toLowerCase();
    if (query) {
      items = items.filter((r) => {
        const values = [
          getAuthId(r),
          getAuthTitle(r),
          getAuthStatus(r),
          getAuthType(r),
          r.repo ?? '',
          r.head_branch ?? r.head ?? '',
          r.base_branch ?? r.base ?? '',
          r.commit_message ?? '',
        ];
        return values.some((value) => String(value).toLowerCase().includes(query));
      });
    }
    if (typeFilter !== 'all') {
      items = items.filter((r) => getAuthType(r) === typeFilter);
    }
    if (repoFilter) {
      items = items.filter((r) => {
        const repo = r.repo && r.repo.trim() ? r.repo.trim() : null;
        return repo === repoFilter;
      });
    }
    if (branchFilter) {
      items = items.filter((r) => {
        const branch = (r.head_branch ?? r.head ?? '').trim();
        return branch === branchFilter;
      });
    }
    return items;
  }, [sidebarItems, authSearch, typeFilter, repoFilter, branchFilter]);

  // Find the selected request from whichever loaded list contains it — exact
  // id matches ONLY. Review C1 (issue f59b5bd): a short prefix must never be
  // resolved against the loaded lists, because a second matching request can
  // exist outside the loaded slice and the loaded lists cannot prove global
  // uniqueness. Every shortened route id canonicalizes through
  // GET /api/auth/request/:id below, which resolves unambiguous prefixes and
  // reports ambiguity honestly as 409.
  const selectedListRequest = useMemo((): AuthRequest | null => {
    if (!selectedId) return null;
    return (
      queue.find((r) => getAuthId(r) === selectedId) ??
      (historyQueue ?? []).find((r) => getAuthId(r) === selectedId) ??
      null
    );
  }, [selectedId, queue, historyQueue]);

  // Bug: 2cddba2 — a deep-linked request (`#/auth?request=<id>`) that resolved
  // outside the loaded history slice matches neither list. Fetch it from the
  // detail route so the pane can render it; a 404 is cached as 'not_found' so
  // the pane shows an honest missing-request state instead of the placeholder.
  // Issue f59b5bd — the detail route also resolves unambiguous short prefixes;
  // a 409 (ambiguous prefix) is cached as 'ambiguous' and surfaced honestly.
  // Review D1 — any other failure is cached as 'error' and rendered with an
  // explicit retry affordance instead of an eternal "Loading request…".
  const [fetchedRequests, setFetchedRequests] = useState<Record<string, AuthRequest | 'not_found' | 'ambiguous' | 'error'>>({});
  useEffect(() => {
    if (!selectedId || selectedListRequest || fetchedRequests[selectedId]) return;
    const id = selectedId;
    let active = true;
    getAuthRequestDetail(id)
      .then((detail) => {
        if (!active) return;
        const record = detail as AuthRequest | null;
        setFetchedRequests((prev) => ({
          ...prev,
          [id]: record && getAuthId(record) ? record : 'not_found',
        }));
      })
      .catch((error) => {
        if (!active) return;
        if (isApiErrorStatus(error, 404)) {
          setFetchedRequests((prev) => ({ ...prev, [id]: 'not_found' }));
        } else if (isApiErrorStatus(error, 409)) {
          setFetchedRequests((prev) => ({ ...prev, [id]: 'ambiguous' }));
        } else {
          setFetchedRequests((prev) => ({ ...prev, [id]: 'error' }));
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId, selectedListRequest, fetchedRequests]);

  // Review D1 — clear the cached failure so the fetch effect retries.
  const retrySelectedFetch = useCallback(() => {
    if (!selectedId) return;
    setFetchedRequests((prev) => {
      if (!(selectedId in prev)) return prev;
      const next = { ...prev };
      delete next[selectedId];
      return next;
    });
  }, [selectedId]);

  const selectedFetched = selectedId ? fetchedRequests[selectedId] : undefined;
  const selectedNotFound = Boolean(selectedId) && !selectedListRequest && selectedFetched === 'not_found';
  const selectedAmbiguous = Boolean(selectedId) && !selectedListRequest && selectedFetched === 'ambiguous';
  const selectedFetchFailed = Boolean(selectedId) && !selectedListRequest && selectedFetched === 'error';
  const selectedRequestRaw = useMemo((): AuthRequest | null => {
    if (selectedListRequest) return selectedListRequest;
    return selectedFetched && typeof selectedFetched === 'object' ? selectedFetched : null;
  }, [selectedListRequest, selectedFetched]);

  // Issue f59b5bd — once a short-prefix selection resolves to a concrete
  // record, upgrade the selection to the full id so sidebar highlighting,
  // action lookups, and caches all key on the canonical id. The deep-link hold
  // moves with it so sidebar reconciliation cannot steal the selection.
  useEffect(() => {
    if (!selectedId || !selectedRequestRaw) return;
    const fullId = getAuthId(selectedRequestRaw);
    if (!fullId || fullId === selectedId || !fullId.startsWith(selectedId)) return;
    if (pendingDeepLinkRef.current === selectedId) pendingDeepLinkRef.current = fullId;
    setFetchedRequests((prev) => (
      prev[selectedId] && !prev[fullId] ? { ...prev, [fullId]: prev[selectedId] } : prev
    ));
    setLocalSelectedId(fullId);
    onSelectAuth?.(fullId);
  }, [selectedId, selectedRequestRaw, onSelectAuth]);

  // Bug: 0de95bf — a list row from the history projection carries no body
  // blobs (diff_summary/spec_content/output are undefined, not null). Fetch the
  // full body from the detail route on selection and cache it. Active-queue
  // rows already carry the full body, so no fetch fires for them.
  const selectedNeedsBody = Boolean(
    selectedRequestRaw &&
      selectedRequestRaw.diff_summary === undefined &&
      selectedRequestRaw.spec_content === undefined &&
      selectedRequestRaw.output === undefined,
  );
  useEffect(() => {
    if (!selectedId || !selectedNeedsBody || hydratedBodies[selectedId]) return;
    let active = true;
    getAuthRequestDetail(selectedId)
      .then((detail) => {
        if (!active || !detail) return;
        const hydrated = detail as AuthRequest;
        setHydratedBodies((prev) => ({
          ...prev,
          [selectedId]: {
            diff_summary: typeof hydrated.diff_summary === 'string' ? hydrated.diff_summary : '',
            spec_content: typeof hydrated.spec_content === 'string' ? hydrated.spec_content : '',
            output: typeof hydrated.output === 'string' ? hydrated.output : '',
            change_report: hydrated.change_report ?? null,
          },
        }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedId, selectedNeedsBody, hydratedBodies]);

  // Merge any fetched body into the selected request for the detail pane.
  const selectedRequest = useMemo((): AuthRequest | null => {
    if (!selectedRequestRaw) return null;
    const hydration = hydratedBodies[getAuthId(selectedRequestRaw)];
    return hydration ? { ...selectedRequestRaw, ...hydration } : selectedRequestRaw;
  }, [selectedRequestRaw, hydratedBodies]);

  useEffect(() => {
    if (!selectedRequest) return;
    const requestId = getAuthId(selectedRequest);
    const inlineActions = Array.isArray(selectedRequest.actions) ? selectedRequest.actions : [];
    if (inlineActions.length > 0) {
      // Issue 80ced49: the queue prop's inline actions are a first-paint seed,
      // not an authoritative refresh. This effect re-runs whenever the selected
      // request object is re-derived (body hydration rewrites its identity), and
      // an unconditional re-seed replayed the stale prop over a locally applied
      // veto toggle, silently reverting the user's action. Seed once per request
      // and let the actions refetch below carry real server updates.
      seedActionListForRequest(requestId, inlineActions);
    }
    if (getActionCount(selectedRequest) === 0) {
      setActionListForRequest(requestId, []);
      return;
    }
    let active = true;
    getAuthRequestActions(requestId)
      .then((actions) => {
        if (active) setActionListForRequest(requestId, actions);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedRequest, seedActionListForRequest, setActionListForRequest]);

  // Auto-select first item when sidebar list changes and nothing is selected.
  // Bug: 2eeadd0 — Also clear selectedId when the selected item is no longer
  // present in the sidebar (e.g. all items completed/dismissed and queue empties),
  // so the orphaned detail card does not remain visible with an empty sidebar.
  useEffect(() => {
    // Bug: 2cddba2 — a deep-linked selection may still be propagating through
    // state (selectedId is null on the mount pass), or may reference a request
    // outside both loaded lists (rendered from the by-id fetch above). Until
    // the user picks another row, don't clear it or promote another row over
    // it. Once the selection has moved elsewhere, release the hold.
    const pendingDeepLink = pendingDeepLinkRef.current;
    if (pendingDeepLink) {
      if (selectedId === null || selectedId === pendingDeepLink) return;
      pendingDeepLinkRef.current = null;
    }
    if (
      selectedId &&
      filteredSidebarItems.length === 0
    ) {
      // Sidebar is now empty — clear the orphaned selection.
      setLocalSelectedId(null);
      onSelectAuth?.(null);
      return;
    }
    if (
      selectedId &&
      !filteredSidebarItems.some((item) => getAuthId(item) === selectedId)
    ) {
      // Selected item no longer in the filtered list — promote first item.
      const firstId = getAuthId(filteredSidebarItems[0]);
      setLocalSelectedId(firstId);
      onSelectAuth?.(firstId);
      return;
    }
    if (!selectedId && filteredSidebarItems.length > 0) {
      const firstId = getAuthId(filteredSidebarItems[0]);
      setLocalSelectedId(firstId);
      onSelectAuth?.(firstId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterMode, authSearch, typeFilter, repoFilter, branchFilter, filteredSidebarItems]);

  const clearAuthFilters = useCallback(() => {
    setFilterMode('active');
    setTypeFilter('all');
    setRepoFilter(null);
    setBranchFilter(null);
    setBranchInput('');
    setSortMode('newest');
    setCustomOrder(null);
  }, []);

  const activeFilterSummary = useMemo(() => {
    const labels: string[] = [];
    if (filterMode !== 'active') labels.push(filterMode);
    if (typeFilter !== 'all') labels.push(AUTH_TYPE_META[typeFilter].label);
    if (repoFilter) labels.push(repoFilter.includes('/') ? repoFilter.split('/')[1] : repoFilter);
    if (branchFilter) labels.push(branchFilter.split('/').pop() ?? branchFilter);
    if (filterMode === 'active' && sortMode !== 'newest') labels.push(sortMode);
    return labels.join(' · ');
  }, [branchFilter, filterMode, repoFilter, sortMode, typeFilter]);

  // Render the action buttons for the selected request in the detail panel
  const renderDetailActions = (request: AuthRequest): JSX.Element | null => {
    const id = getAuthId(request);
    const status = getAuthStatus(request);
    const exitCode = request.exit_code ?? null;
    const isFailed = isFailedLikeStatus(status, exitCode);
    const isHistory = isHistoryStatus(status, exitCode);
    if (isHistory && !isFailed) {
      // Completed and terminal dispositions have no actions.
      return null;
    }
    // Bug: 645f8a8 — while the daemon is not ready (rebuilding / starting), all
    // mutating actions are blocked. Kept separate from actionDisabled (in-flight)
    // so it doesn't trip the "Submitting…" label when nothing is actually queued.
    const rejectAllowed = daemonReady && canPerformOperation(instance, 'POST', `/api/auth/request/${encodeURIComponent(id)}/reject`);
    const retryAllowed = daemonReady && canPerformOperation(instance, 'POST', `/api/auth/request/${encodeURIComponent(id)}/retry`);
    const approvalAllowed = daemonReady && canPerformOperation(instance, 'POST', `/api/auth/request/${encodeURIComponent(id)}/approve`);
    const actionDisabled = inFlight.has(id);
    // Bug: 816476e — isExecuting covers both the optimistic 'approved' status and
    // the inFlight window before the API returns (where status is still 'pending'
    // but a click is in progress). Both cases should hide Approve/Reject and show
    // an in-progress label.
    const isExecuting = isAuthExecutingStatus(status);
    const isSubmitting = actionDisabled && !isExecuting && !isFailed;

    if (isFailed) {
      const isRetrying = retryingIds.has(id);
      return (
        <div className="auth-actions">
          <button
            type="button"
            className="btn btn--success"
            onClick={() => handleRetry(id)}
            disabled={actionDisabled || !retryAllowed}
          >
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      );
    }

    // During the inFlight window (API call in progress, status still 'pending'),
    // show a single disabled "Submitting…" button so users get immediate feedback.
    if (isSubmitting) {
      return (
        <div className="auth-actions">
          <button
            type="button"
            className="btn btn--success btn--submitting"
            disabled
          >
            Verify signing key; touch it if prompted…
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => {
            void cancelApprovalProof(id).catch((error) => setActionError(id, error, 'Could not cancel signing.', { kind: 'approve' }));
          }}>Cancel signing</button>
        </div>
      );
    }

    // Once status becomes 'approved' (optimistic or via SSE), hide Approve/Reject
    // and let the phase-aware callout in the card body carry status.
    if (isExecuting) {
      return (
        <div className="auth-actions">
          <button
            type="button"
            className="btn btn--ghost btn--submitting"
            disabled
          >
            Executing…
          </button>
        </div>
      );
    }

    const dependencyBlocked = Boolean(
      request.depends_on_id && !isAuthDependencyReady(request.dependency),
    );
    const dependencyState = request.dependency?.state ?? 'unavailable';
    return (
      <div className="auth-actions">
        <button
          type="button"
          className="btn btn--success"
          onClick={() => {
            if (!dependencyBlocked) handleApprove(id);
          }}
          disabled={actionDisabled || !approvalAllowed || dependencyBlocked}
          title={dependencyBlocked
            ? `Dependency is ${dependencyState}; approval requires successful durable finalization.`
            : !approvalAllowed ? 'Approval is unavailable in this instance.' : undefined}
        >
          {actionDisabled ? 'Verify signing key…' : dependencyBlocked ? `Blocked: dependency ${dependencyState}` : 'Approve'}
        </button>
        <button
          type="button"
          className={`btn btn--danger${rejectConfirmId === id ? ' btn--confirm' : ''}`}
          onClick={() => toggleRejectConfirm(id)}
          disabled={actionDisabled || !rejectAllowed}
        >
          {rejectConfirmId === id ? 'Confirm reject?' : 'Reject'}
        </button>
      </div>
    );
  };

  return (
    <div className="auth-sidebar-layout">
      <ViewSidebar
        {...VIEW_SIDEBAR_GEOMETRY.auth}
        className="auth-sidebar"
        ariaLabel="Approval requests"
        hidden={sidebarHidden}
        header={
          <SidebarSearchFilterHeader
            value={authSearch}
            onValueChange={setAuthSearch}
            placeholder="Search approval requests..."
            searchAriaLabel="Search approval requests"
            clearAriaLabel="Clear auth search"
            inputType="text"
            onBlurWithin={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setFilterMenuOpen(false);
                }
              }}
            filterTrigger={{
              ariaLabel: 'Advanced approval filters',
              title: 'Advanced approval filters',
              open: filterMenuOpen,
              active: Boolean(activeFilterSummary),
              onToggle: () => setFilterMenuOpen((prev) => !prev),
            }}
            summarySlot={activeFilterSummary ? <span>{activeFilterSummary}</span> : undefined}
            panel={filterMenuOpen ? {
              id: 'auth-filter-panel',
              variant: 'popover',
              ariaLabel: 'Approval filter and sort controls',
              onDismiss: () => setFilterMenuOpen(false),
              children: (
                <>
              <div className="sidebar-search-filter__section sidebar-search-filter__section--header">
                <span>Filters</span>
                <button type="button" className="sidebar-search-filter__clear-action" onClick={clearAuthFilters}>Clear</button>
              </div>
              <div className="sidebar-search-filter__section">
                <span className="sidebar-search-filter__label">Queue</span>
                <div className="sidebar-search-filter__options sidebar-search-filter__options--segmented">
                  {(['active', 'all', 'historical'] as AuthFilterMode[]).map((mode) => (
                    <button key={mode} type="button" className={`sidebar-search-filter__option${filterMode === mode ? ' sidebar-search-filter__option--active' : ''}`} onClick={() => setFilterMode(mode)}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
              {filterMode === 'active' && (
                <div className="sidebar-search-filter__section">
                  <span className="sidebar-search-filter__label">Sort</span>
                  <div className="sidebar-search-filter__options sidebar-search-filter__options--segmented">
                    {(['newest', 'oldest', 'status'] as SortMode[]).map((mode) => (
                      <button key={mode} type="button" className={`sidebar-search-filter__option${sortMode === mode ? ' sidebar-search-filter__option--active' : ''}`} onClick={() => handleSortChange(mode)}>
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="sidebar-search-filter__section">
                <span className="sidebar-search-filter__label">Type</span>
                <div className="sidebar-search-filter__options">
                  {AUTH_TYPE_OPTIONS.map((opt) => (
                    <button key={opt.value} type="button" className={`sidebar-search-filter__option${typeFilter === opt.value ? ' sidebar-search-filter__option--active' : ''}`} onClick={() => setTypeFilter(opt.value)}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {uniqueRepos.length > 1 && (
                <div className="sidebar-search-filter__section">
                  <span className="sidebar-search-filter__label">Repo</span>
                  <div className="sidebar-search-filter__options">
                    <button
                      type="button"
                      className={`sidebar-search-filter__option${repoFilter === null ? ' sidebar-search-filter__option--active' : ''}`}
                      onClick={() => {
                        setRepoFilter(null);
                        setBranchFilter(null);
                        setBranchInput('');
                      }}
                    >
                      All repos
                    </button>
                    {uniqueRepos.map((repo) => {
                      const displayName = repo.includes('/') && repo.split('/').length === 2 ? repo.split('/')[1] : repo;
                      return (
                        <button
                          key={repo}
                          type="button"
                          className={`sidebar-search-filter__option${repoFilter === repo ? ' sidebar-search-filter__option--active' : ''}`}
                          onClick={() => {
                            setRepoFilter(repoFilter === repo ? null : repo);
                            setBranchFilter(null);
                            setBranchInput('');
                          }}
                        >
                          {displayName}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {repoFilter && uniqueBranchesForRepo.length > 1 && (
                <div className="sidebar-search-filter__section">
                  <span className="sidebar-search-filter__label">Branch</span>
                  <div className="auth-sidebar__branch-filter-row">
                    <input
                      type="text"
                      className="auth-sidebar__branch-input"
                      placeholder="Filter by branch..."
                      value={branchInput}
                      list="auth-branch-list"
                      onInput={(e) => {
                        const val = (e.target as HTMLInputElement).value;
                        setBranchInput(val);
                        setBranchFilter(uniqueBranchesForRepo.includes(val) ? val : null);
                      }}
                    />
                    {branchInput && (
                      <button type="button" className="auth-sidebar__branch-clear" onClick={() => { setBranchInput(''); setBranchFilter(null); }} aria-label="Clear branch filter">
                        ×
                      </button>
                    )}
                  </div>
                  <datalist id="auth-branch-list">
                    {uniqueBranchesForRepo.map((branch) => <option key={branch} value={branch} />)}
                  </datalist>
                  <div className="auth-sidebar__branch-tags">
                    {uniqueBranchesForRepo.slice(0, 5).map((branch) => (
                      <button
                        key={branch}
                        type="button"
                        className={`auth-sidebar__branch-tag${branchFilter === branch ? ' auth-sidebar__branch-tag--active' : ''}`}
                        onClick={() => {
                          if (branchFilter === branch) {
                            setBranchFilter(null);
                            setBranchInput('');
                          } else {
                            setBranchFilter(branch);
                            setBranchInput(branch);
                          }
                        }}
                        title={branch}
                      >
                        {branch.split('/').pop() ?? branch}
                      </button>
                    ))}
                  </div>
                </div>
              )}
                </>
              ),
            } : undefined}
          />
        }
        bodyClassName="auth-sidebar__list"
      >
              {filteredSidebarItems.length === 0 ? (
                <div className="auth-sidebar__empty">
                  {authSearch
                    ? 'No requests match the search.'
                    : typeFilter !== 'all'
                      ? `No ${AUTH_TYPE_META[typeFilter].label.toLowerCase()} requests.`
                      : branchFilter
                        ? `No requests for branch ${branchFilter.split('/').pop() ?? branchFilter}.`
                        : repoFilter
                          ? `No requests for ${repoFilter.includes('/') ? repoFilter.split('/')[1] : repoFilter}.`
                          : filterMode === 'active'
                            ? 'No active requests.'
                            : filterMode === 'historical'
                              ? 'No historical requests.'
                              : 'No approval requests.'}
                </div>
              ) : (
                filteredSidebarItems.map((request) => (
                  <AuthSidebarItem
                    key={getAuthId(request)}
                    request={request}
                    selected={getAuthId(request) === selectedId}
                    onSelect={handleSelect}
                  />
                ))
              )}
      </ViewSidebar>

      {/* RIGHT detail panel */}
      <div
        className="auth-detail"
        style={{ position: 'relative' }}
      >
        {!selectedRequest ? (
          <div className="auth-detail__empty">
            <p className="text-muted">
              {selectedId && selectedNotFound
                ? `Approval request ${selectedId.slice(0, 8)} was not found — it may have been deleted or expired.`
                : selectedId && selectedAmbiguous
                  ? `Approval request reference ${selectedId.slice(0, 8)} is ambiguous — it matches multiple requests. Use a longer id.`
                  : selectedId && selectedFetchFailed
                    ? `Failed to load approval request ${selectedId.slice(0, 8)} — the daemon may be unavailable.`
                    : selectedId && !selectedListRequest
                      ? 'Loading request…'
                      : 'No requests in this view'}
            </p>
            {selectedId && selectedFetchFailed ? (
              <button type="button" onClick={retrySelectedFetch}>
                Retry
              </button>
            ) : null}
          </div>
        ) : (() => {
          const request = selectedRequest;
          const id = getAuthId(request);
          const status = getAuthStatus(request);
          const exitCode = request.exit_code ?? null;
          const isFailed = isFailedLikeStatus(status, exitCode);
          const retryCount = retryCounts.get(id) ?? 0;
          const attemptCount = isFailed && retryCount > 0 ? retryCount + 1 : null;
          const failureSummary = isFailed ? buildFailureSummary(request, outputs) : null;
          const isHistory = isHistoryStatus(status, exitCode);
          const requestActions = actionLists.get(id) ?? (Array.isArray(request.actions) ? request.actions : []);
          const actionError = actionErrors.get(id) ?? null;
          return (
            <AuthRequestDetail
              request={request}
              history={isHistory}
              failureSummary={failureSummary}
              attemptCount={attemptCount}
              branchMerged={isHistory && !isFailed && isBranchMerged(request, branchesByRepo)}
              executionOutput={outputs[id]}
              notice={actionError ? (
                <DetailPaneNotice
                  severity="error"
                  density="compact"
                  title="Approval action failed"
                  actions={(
                    <>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        disabled={inFlight.has(id)}
                        onClick={() => retryActionError(id, actionError.retry)}
                      >
                        Retry
                      </button>
                      <ContextualAction
                        aria-label="Dismiss auth error"
                        title="Dismiss auth error"
                        onClick={() => clearActionError(id)}
                      >
                        ×
                      </ContextualAction>
                    </>
                  )}
                >
                  {actionError.message}
                </DetailPaneNotice>
              ) : null}
              actionBundle={requestActions.length > 0 ? (
                <AuthActionBundle
                  request={request}
                  actions={requestActions}
                  inFlightActionIds={inFlightActionIds}
                  instance={instance}
                  onToggleVeto={handleToggleActionVeto}
                />
              ) : undefined}
              actions={renderDetailActions(request)}
              onUpdateField={onUpdateField}
              mutationsAllowed={canPerformOperation(instance, 'PUT', `/api/auth/request/${encodeURIComponent(id)}`)}
              autoShowConsoleOnApproval={autoShowConsoleOnApproval}
              autoReturnToAbstractOnSuccess={autoReturnToAbstractOnSuccess}
            />
          );
        })()}

      </div>
    </div>
  );
}
