import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  DiffView,
  parseUnifiedDiffSections,
  renderUnifiedDiffFallbackHtml,
  type DiffViewClassNames,
  type DiffViewMode,
} from '../components/DiffView';
import { ViewSidebar } from '../components/ViewSidebar';
import { EntityPill } from '../components/shared/EntityPill';
import { AttributionIdentity, DetailHeaderIdentity } from '../components/shared/DetailHeaderIdentity';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { PreviewDisabledNotice } from '../components/shared/PreviewDisabledNotice';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { linkifyResourceRefs as linkifyArtifactRefs } from '../resource-refs';
import { formatRelativeTime } from '../lib/format';
import { renderInlineMarkdown, renderMarkdown } from '../lib/markdown';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import {
  disableAuthAutoApprove,
  enableAuthAutoApprove,
  fetchAuthHooks,
  findIssue,
  getAuthAutoApproveStatus,
  getAuthRequestActions,
  getAuthRequestDetail,
  createAuthHook,
  setAuthRequestActionVeto,
  updateAuthHook,
  deleteAuthHook,
  type AuthRequestAction,
  type AuthAutoApproveStatus,
  type AuthHook,
  type AttributionReadProjection,
  type InstanceInfo,
  type ReadUserIdentity,
} from '../api';

export type AuthRequestType =
  | 'merge'
  | 'commit'
  | 'force-push'
  | 'branch-delete'
  | 'config-change'
  | 'preset-promote'
  | 'data-delete';

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
  spec_content?: string;
  diff_summary?: string;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  issue_ids?: string[] | null;
  created_at?: string | number;
  last_executed_at?: string | number | null;
  resolved_at?: number | string | null;
  depends_on_id?: string | null;
  depends_on_status?: string | null;
  approval_source?: string;
  approval_lease_id?: string | null;
  requested_by_user_id?: string | null;
  approved_by_user_id?: string | null;
  execution_evidence_id?: string | null;
  requester?: ReadUserIdentity | null;
  approver?: ReadUserIdentity | null;
  execution_evidence?: AttributionReadProjection | null;
  verified_signature?: boolean;
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
   * (Approve/Reject/Retry/Dismiss) are disabled and their handlers are blocked
   * so no mutation POST fires into a half-initialized daemon. Defaults to true.
   */
  daemonReady?: boolean;
  instance?: InstanceInfo | null;
  onSelectAuth?: (id: string | null) => void;
  onApprove: (requestId: string) => void | Promise<void>;
  onReject: (requestId: string) => void | Promise<void>;
  onRetry: (requestId: string) => void | Promise<void>;
  onDismiss: (requestId: string) => void | Promise<void>;
  onUpdateField?: (requestId: string, field: string, value: string) => void | Promise<void>;
};

function getAuthId(request: AuthRequest): string {
  return request.id || request.request_id || '';
}

function getAuthTitle(request: AuthRequest): string {
  return request.title || request.summary || 'Auth Request';
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
  'preset-promote': { label: 'Promote',     cssClass: 'type-badge--preset-promote' },
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
  chevron: 'panel__chevron',
  chevronOpen: 'panel__chevron--open',
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

function compactPath(value: string): string {
  const parts = value.split('/').filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join('/')}`;
}

function extractMandibleIssueRefs(message: string): string[] {
  if (!message) return [];
  const refs: string[] = [];
  const regex = /^Mandible-Issue:\s+(\S+)/gm;
  let match;
  while ((match = regex.exec(message)) !== null) {
    refs.push(match[1]);
  }
  return refs;
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

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

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
  if (status === 'rejected' || status === 'dismissed' || status === 'error') {
    return true;
  }
  if (status !== 'completed') return false;
  return exitCode == null || exitCode === 0;
}

type AuthExecutionCallout = {
  text: string;
  spinner: boolean;
};

function getAuthExecutionCallout(status: string, consoleText: string): AuthExecutionCallout | null {
  if (status !== 'approved' && status !== 'executing') return null;
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
  if (status === 'approved' || status === 'executing') return 'Executing';
  if (status === 'needs_rebase') return 'Needs rebase';
  if (status === 'completed') {
    if (request.exit_code != null && request.exit_code !== 0) return 'Failed';
    return 'Completed';
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
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
    default: return String(kind);
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
        : 'Close target issue';
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
    default:
      return JSON.stringify(payload);
  }
}

function actionStateLabel(state: string): string {
  switch (state) {
    case 'staged': return 'Staged';
    case 'applied': return 'Applied';
    case 'failed': return 'Failed';
    case 'skipped_stale': return 'Skipped stale';
    case 'vetoed': return 'Vetoed';
    default: return state;
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
  mutationsAllowed,
  onToggleVeto,
}: {
  request: AuthRequest;
  actions: AuthRequestAction[];
  inFlightActionIds: Set<string>;
  mutationsAllowed: boolean;
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
    <section className="auth-action-bundle" aria-label="Deferred auth actions">
      <div className="auth-action-bundle__header">
        <span className="auth-action-bundle__title">On merge...</span>
        <span className="auth-action-bundle__count">{actions.length}</span>
      </div>
      <div className="auth-action-bundle__rows">
        {actions.map((action) => {
          const title = (action as AuthRequestAction & { target_issue_title?: string }).target_issue_title
            ?? targetTitles[action.target_issue_ref]
            ?? '';
          const expanded = expandedIds.has(action.id);
          const vetoed = action.state === 'vetoed';
          const vetoBusy = inFlightActionIds.has(action.id);
          const canToggle = canVeto && (action.state === 'staged' || action.state === 'vetoed');
          const detail = action.outcome_detail || actionPayloadSummary(action);
          return (
            <div
              key={action.id}
              className={`auth-action-row auth-action-row--${action.state}${expanded ? ' auth-action-row--expanded' : ''}`}
              title={action.outcome_detail ?? undefined}
            >
              <button
                type="button"
                className="auth-action-row__expand"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${formatActionKind(action.kind)} action`}
                onClick={() => toggleExpanded(action.id)}
              >
                <span className={`panel__chevron${expanded ? ' panel__chevron--open' : ''}`}>
                  {'\u25B8'}
                </span>
              </button>
              <div className="auth-action-row__main">
                <div className="auth-action-row__top">
                  <span className="auth-action-row__kind">{formatActionKind(action.kind)}</span>
                  <EntityPill
                    type="issue"
                    id={action.target_issue_ref}
                    repoId={repoId}
                    label={title ? `${action.target_issue_ref} · ${title}` : action.target_issue_ref}
                  />
                  <span className={`auth-action-row__state auth-action-row__state--${action.state}`}>
                    {actionStateLabel(action.state)}
                  </span>
                </div>
                <div className="auth-action-row__summary">{actionPayloadSummary(action)}</div>
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
                  disabled={vetoBusy || !mutationsAllowed}
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

function AuthCard({
  request,
  expanded,
  history,
  resolved,
  failureSummary,
  attemptCount,
  timestampLabel,
  branchMerged,
  onToggle,
  actionBundle,
  actions,
  executionOutput,
  dragging,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onUpdateField,
  mutationsAllowed = true,
}: {
  request: AuthRequest;
  expanded: boolean;
  history?: boolean;
  resolved?: boolean;
  failureSummary?: string | null;
  attemptCount?: number | null;
  timestampLabel?: string;
  branchMerged?: boolean;
  onToggle?: (id: string) => void;
  actionBundle?: JSX.Element | null;
  actions?: JSX.Element | null;
  executionOutput?: string;
  dragging?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  onUpdateField?: (requestId: string, field: string, value: string) => void | Promise<void>;
  mutationsAllowed?: boolean;
}): JSX.Element {
  const [showCommit, setShowCommit] = useState(true);
  const [showSpec, setShowSpec] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [showConsole, setShowConsole] = useState(false);
  const [selectedFile, setSelectedFile] = useState<number>(-1);
  const [editingCommitMsg, setEditingCommitMsg] = useState(false);
  const [editCommitValue, setEditCommitValue] = useState('');
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const commitMsg = typeof request.commit_message === 'string' ? request.commit_message : '';
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
  const diffSections = useMemo(() => parseUnifiedDiffSections(diffRaw), [diffRaw]);
  const diffHtml = useMemo(() => {
    if (selectedFile === -1) {
      return renderUnifiedDiffFallbackHtml(diffSections.map((s) => s.hunks).join('\n'));
    }
    return renderUnifiedDiffFallbackHtml(diffSections[selectedFile]?.hunks || '');
  }, [diffSections, selectedFile]);

  // Determine console output: prefer streaming outputs, fall back to request.output.
  // Streamed output is already ANSI-stripped incrementally in the reducer, so we
  // only strip the persisted fallback here — no re-stripping the whole buffer per
  // chunk.
  const consoleText = useMemo(() => {
    if (executionOutput) return executionOutput;
    const fallback = typeof request.output === 'string' ? request.output : '';
    return stripAnsi(fallback);
  }, [executionOutput, request.output]);
  const hasConsoleOutput = consoleText.trim().length > 0;

  const stats = getStats(request);
  const status = getAuthStatus(request);
  const statusLabel = getStatusLabel(request);
  const statusClass = getStatusClass(request);
  const cardClass = `auth-card auth-card--condensed${expanded ? ' auth-card--expanded' : ''}` +
    `${history ? ' auth-card--history' : ''}` +
    `${resolved ? ' auth-card--resolved' : ''}` +
    `${dragging ? ' auth-card--dragging' : ''}`;
  const failedLike = isFailedLikeStatus(status, request.exit_code ?? null);

  // Bug: 816476e — show execution callout and auto-open output for approved/executing state
  const isApproved = status === 'approved' || status === 'executing';
  const executionCallout = expanded ? getAuthExecutionCallout(status, consoleText) : null;

  // Show console toggle for executing, completed, or failed statuses — also show
  // when approved even before output arrives so the panel is visible immediately.
  const showConsoleToggle = expanded &&
    (isApproved || (hasConsoleOutput && (status === 'completed' || failedLike)));
  const showFailure = expanded && failedLike;
  const attemptLabel = attemptCount && attemptCount > 1 ? `Attempt ${attemptCount}` : null;
  const requestHash = getRequestHash(request);
  const fullId = getAuthId(request);

  const baseBranch = request.base_branch ?? request.base;
  const headBranch = request.head_branch ?? request.head;
  const repoId = request.repo ?? '';
  const repoName = repoId.includes('/') && !looksLikeBranchName(repoId) && repoId.split('/').length === 2
    ? repoId.split('/')[1]
    : repoId;
  const hasTags = Boolean(commitBranch || attemptLabel || (headBranch && baseBranch));

  // Session & issue links
  const sessionId = request.session_id;
  const structuredReferenceIds = request.issue_references;
  const structuredLegacyIds = request.issue_ids;
  const referenceRefs = useMemo(
    () => uniqueStrings([
      ...(Array.isArray(structuredReferenceIds) ? structuredReferenceIds : []),
      ...(Array.isArray(structuredLegacyIds) ? structuredLegacyIds : extractMandibleIssueRefs(commitMsg)),
    ]),
    [structuredReferenceIds, structuredLegacyIds, commitMsg]
  );
  const closureRefs = useMemo(
    () => uniqueStrings([
      ...(Array.isArray(request.issue_closures) ? request.issue_closures : []),
      ...(Array.isArray(request.issues) ? request.issues as string[] : []),
    ]),
    [request.issue_closures, request.issues]
  );
  const canIssueLink = Boolean(repoId) && !looksLikeBranchName(repoId);
  const hasLinks = Boolean(sessionId) || ((referenceRefs.length > 0 || closureRefs.length > 0) && canIssueLink);

  // Bug: 816476e — auto-open console output when status transitions to approved
  // so live output is visible without requiring a manual click.
  useEffect(() => {
    if (isApproved) {
      setShowConsole(true);
    }
  }, [isApproved]);

  // Auto-scroll console to bottom when output updates. Use 'auto' (instant):
  // 'smooth' restarts an animation on every streamed chunk, which stacks up and
  // janks while output is arriving fast.
  useEffect(() => {
    if (showConsole && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [showConsole, consoleText]);

  const effectiveTimestampLabel = timestampLabel ?? getSubmissionTimestampLabel(request);

  const authType = getAuthType(request);
  const typeMeta = AUTH_TYPE_META[authType];
  const showDiffStats = typeHasDiffStats(authType);

  const hasStats = stats.files != null || stats.additions != null || stats.deletions != null;
  const statsLine = showDiffStats ? (
    <span className="auth-card__stats">
      {hasStats ? (
        <>
          <span>{formatNumber(stats.files ?? 0)} files</span>
          <span className="stats-plus">+{formatNumber(stats.additions ?? 0)}</span>
          <span className="stats-minus">-{formatNumber(stats.deletions ?? 0)}</span>
        </>
      ) : (
        <span className="stats-unavailable">—</span>
      )}
    </span>
  ) : null;

  const summaryContent = (
    <div className="auth-card__summary">
      <div className="auth-card__row auth-card__row--primary">
        <span className={statusClass}>{statusLabel}</span>
        <span className={`type-badge ${typeMeta.cssClass}`}>{typeMeta.label}</span>
        {/* Bug: a44fd6a — render auth request title as inline markdown */}
        <span
          className="auth-card__title"
          dangerouslySetInnerHTML={{
            __html: linkifyArtifactRefs(renderInlineMarkdown(getAuthTitle(request))),
          }}
        />
        {repoName && (
          <span className="auth-card__repo">{repoName}</span>
        )}
      </div>
      <div className="auth-card__row auth-card__row--stats">
        {statsLine}
        {statsLine && <span className="auth-card__divider">|</span>}
        <span
          className="auth-card__request-id"
          onClick={(event) => {
            event.stopPropagation();
            if (fullId) {
              navigator.clipboard.writeText(fullId);
            }
          }}
        >
          {requestHash}
        </span>
        <span className="auth-card__divider">|</span>
        <span className="auth-card__timestamps">{effectiveTimestampLabel}</span>
      </div>
      {hasTags && (
        <div className="auth-card__row auth-card__row--tags">
          {commitBranch && (
            <span className="branch-tag">{commitBranch}</span>
          )}
          {attemptLabel && (
            <span className="attempt-tag">{attemptLabel}</span>
          )}

          {headBranch && baseBranch && (
            <span className="branch-flow">
              <span className="branch-name">{headBranch}</span>
              {' \u2192 '}
              <span className="branch-name">{baseBranch}</span>
            </span>
          )}
        </div>
      )}
      {hasLinks && (
        <div className="auth-card__row auth-card__row--links">
          {sessionId && (
            <a
              className="auth-card__link"
              href={`#/sessions?session=${encodeURIComponent(sessionId)}`}
              onClick={(e) => e.stopPropagation()}
            >
              Session
            </a>
          )}
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
  );

  return (
    <div
      className={cardClass}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="auth-card__summary-button"
        onClick={() => onToggle?.(getAuthId(request))}
      >
        {summaryContent}
      </button>

      {expanded && (
        <div className="auth-card__expanded">
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

          <div className="auth-card__panels">
            <div className="auth-card__left-col">
              <div className="panel">
                <div className="panel__header">
                  <button
                    type="button"
                    className="panel__toggle"
                    onClick={() => setShowCommit((prev) => !prev)}
                  >
                    <span className={`panel__chevron${showCommit ? ' panel__chevron--open' : ''}`}>
                      {'\u25B8'}
                    </span>
                    Commit Message
                  </button>
                  {/* Bug: 2c826ca — editable commit message for pending/failed requests */}
                  {onUpdateField && mutationsAllowed && (status === 'pending' || failedLike) && !editingCommitMsg && (
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
                </div>
                {showCommit && (
                  editingCommitMsg ? (
                    <div className="panel__body spec-panel">
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
                    </div>
                  ) : commitHtml ? (
                    <div
                      className="panel__body spec-panel"
                      dangerouslySetInnerHTML={{ __html: commitHtml }}
                    />
                  ) : (
                    <div className="panel__body spec-panel spec-panel--empty">
                      No commit message provided. Merge will use git's default message.
                    </div>
                  )
                )}
              </div>
              <div className="panel">
                <button
                  type="button"
                  className="panel__toggle"
                  onClick={() => setShowSpec((prev) => !prev)}
                >
                  <span className={`panel__chevron${showSpec ? ' panel__chevron--open' : ''}`}>
                    {'\u25B8'}
                  </span>
                  Specification
                </button>
                {showSpec && (
                  specHtml ? (
                    <div
                      className="panel__body spec-panel"
                      dangerouslySetInnerHTML={{ __html: specHtml }}
                    />
                  ) : (
                    <div className="panel__body spec-panel spec-panel--empty">
                      No specification attached.
                    </div>
                  )
                )}
              </div>
            </div>
            <div className="panel auth-card__right-col">
              <button
                type="button"
                className="panel__toggle"
                onClick={() => setShowDiff((prev) => !prev)}
              >
                <span className={`panel__chevron${showDiff ? ' panel__chevron--open' : ''}`}>
                  {'\u25B8'}
                </span>
                {showDiffStats ? 'Changes' : 'Details'}
              </button>
              {showDiff && (
                showDiffStats ? (
                  diffSections.length > 0 ? (
                    <div className="panel__body diff-panel">
                      <div className="diff-file-tabs">
                        {diffSections.length > 1 && (
                          <button
                            className={`diff-file-tab${selectedFile === -1 ? ' diff-file-tab--active' : ''}`}
                            onClick={() => setSelectedFile(-1)}
                          >All</button>
                        )}
                        {diffSections.map((section, i) => (
                          <button
                            key={i}
                            className={`diff-file-tab${selectedFile === i ? ' diff-file-tab--active' : ''}`}
                            onClick={() => setSelectedFile(i)}
                            title={section.filename}
                          >
                            {section.filename.split('/').pop()}
                          </button>
                        ))}
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: diffHtml }} />
                    </div>
                  ) : (
                    <div className="panel__body diff-panel spec-panel--empty">
                      No diff available.
                    </div>
                  )
                ) : (
                  <div className="panel__body spec-panel">
                    <p className="type-detail-summary">
                      <span className={`type-badge ${typeMeta.cssClass}`}>{typeMeta.label}</span>
                      {' '}{getAuthTitle(request)}
                    </p>
                    {specContent && (
                      <div dangerouslySetInnerHTML={{ __html: specHtml }} />
                    )}
                    {!specContent && (
                      <p className="text-muted">No additional details for this request type.</p>
                    )}
                  </div>
                )
              )}
            </div>
          </div>

          {actionBundle}

          {showConsoleToggle && (
            <div className="console-output">
              <button
                type="button"
                className="console-output__toggle"
                onClick={() => setShowConsole((prev) => !prev)}
              >
                <span className={`panel__chevron${showConsole ? ' panel__chevron--open' : ''}`}>
                  {'\u25B8'}
                </span>
                {showConsole ? 'Hide output' : 'Show output'}
                {isApproved && (
                  <span className="console-output__live-dot" />
                )}
              </button>
              {showConsole && (
                <div className="console-output__panel">
                  {/* Bug: 816476e — show waiting placeholder when approved but no output yet */}
                  {hasConsoleOutput ? (
                    <pre className="console-output__pre">{consoleText}<div ref={consoleEndRef} /></pre>
                  ) : (
                    <div className="console-output__waiting">
                      Waiting for output…
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {actions}
        </div>
      )}
    </div>
  );
}

function AuthRequestDetail({
  request,
  history,
  failureSummary,
  attemptCount,
  timestampLabel,
  branchMerged,
  actionBundle,
  actions,
  executionOutput,
  onUpdateField,
  mutationsAllowed = true,
}: {
  request: AuthRequest;
  history?: boolean;
  failureSummary?: string | null;
  attemptCount?: number | null;
  timestampLabel?: string;
  branchMerged?: boolean;
  actionBundle?: JSX.Element | null;
  actions?: JSX.Element | null;
  executionOutput?: string;
  onUpdateField?: (requestId: string, field: string, value: string) => void | Promise<void>;
  mutationsAllowed?: boolean;
}): JSX.Element {
  const [showCommit, setShowCommit] = useState(true);
  const [showSpec, setShowSpec] = useState(true);
  const [diffViewActive, setDiffViewActive] = useState(false);
  const [diffMode, setDiffMode] = useState<DiffViewMode>('split');
  const [showConsole, setShowConsole] = useState(false);
  const [editingCommitMsg, setEditingCommitMsg] = useState(false);
  const [editCommitValue, setEditCommitValue] = useState('');
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  const commitMsg = typeof request.commit_message === 'string' ? request.commit_message : '';
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
  const statusClass = getStatusClass(request);
  const failedLike = isFailedLikeStatus(status, request.exit_code ?? null);
  const isApproved = status === 'approved' || status === 'executing';
  const executionCallout = getAuthExecutionCallout(status, consoleText);
  const showConsoleToggle = isApproved || (hasConsoleOutput && (status === 'completed' || failedLike));
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
  const structuredLegacyIds = request.issue_ids;
  const referenceRefs = useMemo(
    () => uniqueStrings([
      ...(Array.isArray(structuredReferenceIds) ? structuredReferenceIds : []),
      ...(Array.isArray(structuredLegacyIds) ? structuredLegacyIds : extractMandibleIssueRefs(commitMsg)),
    ]),
    [structuredReferenceIds, structuredLegacyIds, commitMsg]
  );
  const closureRefs = useMemo(
    () => uniqueStrings([
      ...(Array.isArray(request.issue_closures) ? request.issue_closures : []),
      ...(Array.isArray(request.issues) ? request.issues as string[] : []),
    ]),
    [request.issue_closures, request.issues]
  );
  const canIssueLink = Boolean(repoId) && !looksLikeBranchName(repoId);
  const hasLinks = Boolean(sessionId) || ((referenceRefs.length > 0 || closureRefs.length > 0) && canIssueLink);

  useEffect(() => {
    if (isApproved) {
      setShowConsole(true);
    }
  }, [isApproved]);

  useEffect(() => {
    if (showConsole && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [showConsole, consoleText]);

  useEffect(() => {
    if (!actionsOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const node = actionsMenuRef.current;
      if (!node || node.contains(event.target as Node)) return;
      setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [actionsOpen]);

  const effectiveTimestampLabel = timestampLabel ?? (history
    ? getResolvedTimestampLabel(request)
    : getSubmissionTimestampLabel(request));

  const authType = getAuthType(request);
  const typeMeta = AUTH_TYPE_META[authType];
  const showDiffStats = typeHasDiffStats(authType);
  const hasStats = stats.files != null || stats.additions != null || stats.deletions != null;
  const hasMeaningfulDiffToggle = showDiffStats && (hasStats || diffRaw.trim().length > 0);
  const statsSummary = showDiffStats && hasStats
    ? `${formatNumber(stats.files ?? 0)} files · +${formatNumber(stats.additions ?? 0)} -${formatNumber(stats.deletions ?? 0)}`
    : null;
  const primarySubtitle = [statsSummary, effectiveTimestampLabel].filter(Boolean).join(' · ');
  const flowText = headBranch && baseBranch ? `${headBranch} \u2192 ${baseBranch}` : commitBranch;
  const typeSubtitle = flowText ? `${typeMeta.label.toLowerCase()} · ${flowText}` : typeMeta.label.toLowerCase();
  const shortRef = requestHash || 'unknown';
  const copyRef = requestHash ? `auth:${requestHash}` : '';
  const requester = request.requester ?? null;
  const approver = request.approver ?? null;
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

  const subheader = (hasMeaningfulDiffToggle || actions) ? (
    <>
      <div className="auth-detail__aux-left">
        {hasMeaningfulDiffToggle && (
          <button
            type="button"
            className={`auth-detail__diff-toggle${diffViewActive ? ' auth-detail__diff-toggle--active' : ''}`}
            aria-label={diffViewActive ? 'Hide changes diff' : 'Show changes diff'}
            aria-pressed={diffViewActive}
            title={diffViewActive ? 'Hide changes diff' : 'Show changes diff'}
            onClick={() => setDiffViewActive((active) => !active)}
          >
            <DiffIcon />
          </button>
        )}
      </div>
      <div className="auth-detail__action-strip">
        {actions}
      </div>
    </>
  ) : undefined;

  const overlays = (
    <DetailPaneModal
      open={metadataOpen}
      onClose={() => setMetadataOpen(false)}
      titleId="auth-metadata-title"
      title="Auth metadata"
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
        <MetadataRow label="Last executed" value={lastExecutedAt} />
        <MetadataRow label="Resolved" value={resolvedAt} />
        <MetadataRow label="Approval source" value={request.approval_source ?? null} />
        <MetadataRow label="Approval lease" value={request.approval_lease_id ?? null} />
        <MetadataRow label="Requester" value={requester?.display_name ?? request.requested_by_user_id ?? null} />
        <MetadataRow label="Approver" value={approver?.display_name ?? request.approved_by_user_id ?? null} />
        <MetadataRow label="Execution evidence" value={request.execution_evidence?.evidence_method ?? null} />
        <MetadataRow label="Dependency id" value={request.depends_on_id ?? null} />
        <MetadataRow label="Dependency status" value={request.depends_on_status ?? null} />
        <MetadataRow label="Merge SHA" value={mergeSha} />
        <MetadataRow label="Finalized" value={finalizedAt} />
        <MetadataRow label="Session" value={sessionId ?? null} />
        <MetadataRow label="Target session" value={targetSession} />
        <MetadataRow label="Target repo" value={targetRepo} />
        <MetadataRow label="Conversation" value={conversationId} />
      </dl>
    </DetailPaneModal>
  );

  useEffect(() => {
    setDiffViewActive(false);
  }, [fullId]);

  return (
    <DetailPaneShell
      className={`auth-detail__pane auth-detail-pane${history ? ' auth-detail-pane--history' : ''}`}
      headerClassName="auth-detail__header"
      headerPrimaryClassName="auth-detail__header-primary"
      subheaderClassName="auth-detail__aux-header"
      bodyClassName="auth-detail__body"
      headerRef={headerRef}
      subheader={subheader}
      overlays={overlays}
      header={(
        <>
          <div className="auth-detail__header-main">
            <DetailHeaderIdentity
              className="auth-detail__eyebrow"
              contextLabel={repoName}
              contextClassName="auth-detail__repo"
              shortId={shortRef}
              shortIdClassName="auth-detail__short-ref"
              copyValue={copyRef}
              copyLabel={`Copy ${copyRef || 'auth reference'}`}
            >
              <span className={statusClass}>{statusLabel}</span>
              {attemptLabel && <span className="attempt-tag">{attemptLabel}</span>}
              {branchMerged && <span className="branch-merged-tag">branch merged</span>}
            </DetailHeaderIdentity>
            <h2
              className="auth-detail__title"
              dangerouslySetInnerHTML={{
                __html: linkifyArtifactRefs(renderInlineMarkdown(getAuthTitle(request))),
              }}
            />
            <div className="auth-detail__subtitle">
              <span>{primarySubtitle}</span>
              <span className="auth-detail__subtitle-line">
                {typeSubtitle}
              </span>
            </div>
            {(requester || approver || request.verified_signature) && (
              <div className="auth-detail__attribution" aria-label="Auth attribution">
                {requester && (
                  <div>
                    Requested by{' '}
                    <AttributionIdentity
                      display={requester.display_name}
                      user={requester}
                      source="auth_queue"
                    />
                  </div>
                )}
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
                {request.verified_signature && (
                  <span className="auth-detail__verified-signature">Verified signature</span>
                )}
              </div>
            )}
            {hasLinks && (
              <div className="auth-detail__links">
                {sessionId && (
                  <a
                    className="auth-card__link"
                    href={`#/sessions?session=${encodeURIComponent(sessionId)}`}
                  >
                    Session
                  </a>
                )}
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
          <div className="auth-detail__header-actions" ref={actionsMenuRef}>
            <button
              type="button"
              className={`auth-detail__actions-trigger${actionsOpen ? ' auth-detail__actions-trigger--active' : ''}`}
              aria-label="Auth actions"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              title="Auth actions"
              onClick={() => setActionsOpen((open) => !open)}
            >
              <HorizontalDotsIcon />
            </button>
            {actionsOpen && (
              <div className="auth-detail__actions-menu" role="menu">
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
        </>
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

        {diffViewActive ? (
          <DiffView
            diffText={diffRaw}
            mode={diffMode}
            onModeChange={setDiffMode}
            ariaLabel="Auth request changes"
            emptyMessage="No diff available for this request."
            className="auth-detail__diff-view"
            classNames={AUTH_DIFF_VIEW_CLASS_NAMES}
          />
        ) : (
          <div className={panelsClass}>
            <div className="auth-detail__left-col">
              <div className="panel">
                <div className="panel__header">
                  <button
                    type="button"
                    className="panel__toggle"
                    onClick={() => setShowCommit((prev) => !prev)}
                  >
                    <span className={`panel__chevron${showCommit ? ' panel__chevron--open' : ''}`}>
                      {'\u25B8'}
                    </span>
                    Commit Message
                  </button>
                  {onUpdateField && mutationsAllowed && (status === 'pending' || failedLike) && !editingCommitMsg && (
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
                </div>
                {showCommit && (
                  editingCommitMsg ? (
                    <div className="panel__body spec-panel">
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
                    </div>
                  ) : commitHtml ? (
                    <div
                      className="panel__body spec-panel"
                      dangerouslySetInnerHTML={{ __html: commitHtml }}
                    />
                  ) : (
                    <div className="panel__body spec-panel spec-panel--empty">
                      No commit message provided. Merge will use git's default message.
                    </div>
                  )
                )}
              </div>
              <div className="panel">
                <button
                  type="button"
                  className="panel__toggle"
                  onClick={() => setShowSpec((prev) => !prev)}
                >
                  <span className={`panel__chevron${showSpec ? ' panel__chevron--open' : ''}`}>
                    {'\u25B8'}
                  </span>
                  Specification
                </button>
                {showSpec && (
                  specHtml ? (
                    <div
                      className="panel__body spec-panel"
                      dangerouslySetInnerHTML={{ __html: specHtml }}
                    />
                  ) : (
                    <div className="panel__body spec-panel spec-panel--empty">
                      No specification attached.
                    </div>
                  )
                )}
              </div>
            </div>
            {hasActionBundle && (
              <div className="auth-detail__right-col">
                {actionBundle}
              </div>
            )}
          </div>
        )}

        {showConsoleToggle && (
          <div className="console-output">
            <button
              type="button"
              className="console-output__toggle"
              onClick={() => setShowConsole((prev) => !prev)}
            >
              <span className={`panel__chevron${showConsole ? ' panel__chevron--open' : ''}`}>
                {'\u25B8'}
              </span>
              {showConsole ? 'Hide output' : 'Show output'}
              {isApproved && (
                <span className="console-output__live-dot" />
              )}
            </button>
            {showConsole && (
              <div className="console-output__panel">
                {hasConsoleOutput ? (
                  <pre className="console-output__pre">{consoleText}<div ref={consoleEndRef} /></pre>
                ) : (
                  <div className="console-output__waiting">
                    Waiting for output…
                  </div>
                )}
              </div>
            )}
          </div>
        )}
    </DetailPaneShell>
  );
}

function HorizontalDotsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

function DiffIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 10h5M11.5 7.5v5M10 16h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}


function AuthCardItem({
  leading,
  request,
  expanded,
  history,
  resolved,
  failureSummary,
  attemptCount,
  timestampLabel,
  branchMerged,
  onToggle,
  actionBundle,
  actions,
  executionOutput,
  onUpdateField,
  dragging,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  leading?: JSX.Element | null;
  request: AuthRequest;
  expanded: boolean;
  history?: boolean;
  resolved?: boolean;
  failureSummary?: string | null;
  attemptCount?: number | null;
  timestampLabel?: string;
  branchMerged?: boolean;
  onToggle?: (id: string) => void;
  actionBundle?: JSX.Element | null;
  actions?: JSX.Element | null;
  executionOutput?: string;
  onUpdateField?: (requestId: string, field: string, value: string) => void | Promise<void>;
  dragging?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
}): JSX.Element {
  return (
    <div className="auth-list__item">
      {leading}
      <AuthCard
        request={request}
        expanded={expanded}
        history={history}
        resolved={resolved}
        failureSummary={failureSummary}
        attemptCount={attemptCount}
        timestampLabel={timestampLabel}
        branchMerged={branchMerged}
        onToggle={onToggle}
        actionBundle={actionBundle}
        actions={actions}
        executionOutput={executionOutput}
        onUpdateField={onUpdateField}
        dragging={dragging}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
    </div>
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
  } else if (status === 'approved' || status === 'executing') {
    dotStatus = 'approved';  // Keep CSS class as 'approved' for now
  } else if (status === 'rejected' || status === 'dismissed') {
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
  mutationsAllowed = true,
}: {
  onClose?: () => void;
  mutationsAllowed?: boolean;
}): JSX.Element {
  const [hooks, setHooks] = useState<AuthHook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  // Form fields
  const [formRepo, setFormRepo] = useState('*');
  const [formType, setFormType] = useState<AuthRequestType>('merge');
  const [formCommand, setFormCommand] = useState('');
  const [formLabel, setFormLabel] = useState('');

  const loadHooks = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchAuthHooks();
      setHooks(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load hooks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadHooks(); }, [loadHooks]);

  const resetForm = () => {
    setFormRepo('*');
    setFormType('merge');
    setFormCommand('');
    setFormLabel('');
    setEditId(null);
    setShowForm(false);
  };

  const handleSave = async () => {
    if (!mutationsAllowed) {
      setError('Auth hook mutations are disabled on this Mandible preview instance.');
      return;
    }
    try {
      if (editId) {
        await updateAuthHook(editId, {
          repo_pattern: formRepo,
          auth_type: formType,
          command: formCommand,
          label: formLabel,
        });
      } else {
        await createAuthHook({
          repo_pattern: formRepo,
          auth_type: formType,
          command: formCommand,
          label: formLabel,
        });
      }
      resetForm();
      await loadHooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save hook');
    }
  };

  const handleEdit = (hook: AuthHook) => {
    if (!mutationsAllowed) return;
    setFormRepo(hook.repo_pattern);
    setFormType(hook.auth_type as AuthRequestType);
    setFormCommand(hook.command);
    setFormLabel(hook.label);
    setEditId(hook.id);
    setShowForm(true);
  };

  const handleToggle = async (hook: AuthHook) => {
    if (hook.builtin || !mutationsAllowed) return; // Built-in hooks cannot be toggled
    try {
      await updateAuthHook(hook.id, { enabled: !hook.enabled });
      await loadHooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle hook');
    }
  };

  const handleDelete = async (hook: AuthHook) => {
    if (hook.builtin || !mutationsAllowed) return;
    try {
      await deleteAuthHook(hook.id);
      await loadHooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete hook');
    }
  };

  return (
    <div className="auth-hooks-panel">
      <div className="auth-hooks-panel__header">
        <h2 className="auth-hooks-panel__title">Auth Hooks</h2>
        <div className="auth-hooks-panel__actions">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => { resetForm(); setShowForm(true); }}
            disabled={!mutationsAllowed}
          >
            + Add Hook
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

      {error && (
        <div className="auth-hooks-panel__error">{error}</div>
      )}
      {!mutationsAllowed && (
        <div className="auth-hooks-panel__error">
          Auth hook mutations are disabled on this Mandible preview instance.
        </div>
      )}

      {showForm && (
        <div className="auth-hooks-panel__form">
          <div className="auth-hooks-panel__form-row">
            <label>Label</label>
            <input
              type="text"
              placeholder="Hook description"
              value={formLabel}
              onInput={(e) => setFormLabel((e.target as HTMLInputElement).value)}
              disabled={!mutationsAllowed}
            />
          </div>
          <div className="auth-hooks-panel__form-row">
            <label>Repo pattern</label>
            <input
              type="text"
              placeholder="* for all, or repo name"
              value={formRepo}
              onInput={(e) => setFormRepo((e.target as HTMLInputElement).value)}
              disabled={!mutationsAllowed}
            />
          </div>
          <div className="auth-hooks-panel__form-row">
            <label>Auth type</label>
            <select
              value={formType}
              onChange={(e) => setFormType((e.target as HTMLSelectElement).value as AuthRequestType)}
              disabled={!mutationsAllowed}
            >
              <option value="merge">Merge</option>
              <option value="commit">Commit</option>
              <option value="force-push">Force Push</option>
              <option value="branch-delete">Branch Delete</option>
              <option value="config-change">Config Change</option>
              <option value="preset-promote">Preset Promote</option>
              <option value="data-delete">Data Delete</option>
            </select>
          </div>
          <div className="auth-hooks-panel__form-row">
            <label>Command</label>
            <textarea
              placeholder="Shell command to run after auth action"
              value={formCommand}
              rows={3}
              onInput={(e) => setFormCommand((e.target as HTMLTextAreaElement).value)}
              disabled={!mutationsAllowed}
            />
          </div>
          <div className="auth-hooks-panel__form-actions">
            <button
              type="button"
              className="btn btn--sm btn--success"
              onClick={() => void handleSave()}
              disabled={!mutationsAllowed || !formCommand.trim()}
            >
              {editId ? 'Update' : 'Create'}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={resetForm}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="auth-hooks-panel__empty">Loading hooks...</div>
      ) : hooks.length === 0 ? (
        <div className="auth-hooks-panel__empty">No hooks configured.</div>
      ) : (
        <div className="auth-hooks-panel__list">
          {hooks.map((hook) => (
            <div
              key={hook.id}
              className={`auth-hooks-panel__item${!hook.enabled ? ' auth-hooks-panel__item--disabled' : ''}${hook.builtin ? ' auth-hooks-panel__item--builtin' : ''}`}
            >
              <div className="auth-hooks-panel__item-header">
                <button
                  type="button"
                  className={`auth-hooks-panel__toggle${hook.enabled ? ' auth-hooks-panel__toggle--on' : ''}`}
                  onClick={() => void handleToggle(hook)}
                  disabled={hook.builtin || !mutationsAllowed}
                  title={hook.builtin ? 'Built-in hooks are always enabled' : !mutationsAllowed ? 'Disabled on preview instances' : (hook.enabled ? 'Disable' : 'Enable')}
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
                    className="btn btn--sm btn--ghost"
                    onClick={() => handleEdit(hook)}
                    disabled={!mutationsAllowed}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => void handleDelete(hook)}
                    disabled={!mutationsAllowed}
                  >
                    Delete
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
  { value: 'merge', label: 'Merge' },
  { value: 'commit', label: 'Commit' },
  { value: 'force-push', label: 'Force Push' },
  { value: 'branch-delete', label: 'Delete' },
  { value: 'config-change', label: 'Config' },
  { value: 'preset-promote', label: 'Promote' },
  { value: 'data-delete', label: 'Delete Data' },
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
  onDismiss,
  onUpdateField,
  sidebarHidden = false,
  daemonReady = true,
  instance = null,
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
  type AuthRequestBody = { diff_summary: string; spec_content: string; output: string };
  const [hydratedBodies, setHydratedBodies] = useState<Record<string, AuthRequestBody>>({});

  const handleSelect = useCallback((id: string) => {
    setLocalSelectedId(id);
    onSelectAuth?.(id);
  }, [onSelectAuth]);

  // Bug: bdcc1f5 — deep-link from graph node click: select and scroll to initial request
  useEffect(() => {
    if (!initialRequestId) return;
    setLocalSelectedId(initialRequestId);
    onSelectAuth?.(initialRequestId);
    setTimeout(() => {
      const el = document.querySelector(`[data-request-id="${initialRequestId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 200);
  // Only run on mount / when initialRequestId changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRequestId]);

  // Track recently resolved requests: Map<requestId, {status, resolvedAt}>
  const [recentlyResolved, setRecentlyResolved] = useState<
    Map<string, { status: string; resolvedAt: number }>
  >(() => new Map());

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
  }, [queue]);

  const activeQueue = useMemo(
    () =>
      queue.filter((r) => {
        const status = getAuthStatus(r);
        return status === 'pending' || status === 'approved' || status === 'executing' ||
          isFailedLikeStatus(status, r.exit_code ?? null);
      }),
    [queue],
  );

  const lingeringQueue = useMemo(
    () =>
      queue.filter((r) => {
        const id = getAuthId(r);
        return recentlyResolved.has(id);
      }),
    [queue, recentlyResolved],
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

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoApproveStatus, setAutoApproveStatus] = useState<AuthAutoApproveStatus | null>(null);
  const [autoApproveBusy, setAutoApproveBusy] = useState(false);
  const [showAutoApproveSetupModal, setShowAutoApproveSetupModal] = useState(false);
  const autoApproveSigningConfigured = Boolean(autoApproveStatus?.signing?.configured);
  const operationalMutationsAllowed = !instance || instance.operational_mutations === 'allow';
  const instanceMutationBlocked = Boolean(instance && !operationalMutationsAllowed);
  const instanceLabel = instance?.role ?? 'main';
  const instanceDbLabel = instance?.db_path ? compactPath(instance.db_path) : null;
  const instanceSourceLabel = instance?.source_db_path ? compactPath(instance.source_db_path) : null;
  const previewNotice = instanceMutationBlocked ? (
    <PreviewDisabledNotice
      title={`${instanceLabel} instance`}
      className="preview-disabled-notice--edge-to-edge"
    >
      <>
        Auth actions are disabled for this copied preview queue
        {instanceDbLabel ? ` (${instanceDbLabel})` : ''}
        {instanceSourceLabel ? ` from ${instanceSourceLabel}` : ''}.
      </>
    </PreviewDisabledNotice>
  ) : null;

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => {
      getAuthAutoApproveStatus()
        .then((status) => {
          if (active) setAutoApproveStatus(status);
        })
        .catch(() => undefined);
    };
    load();
    const interval = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const handleAutoApproveToggle = useCallback(async () => {
    if (!operationalMutationsAllowed) {
      showToast('Auth mutations are disabled on this Mandible preview instance.');
      return;
    }
    if (!autoApproveStatus?.enabled && !autoApproveSigningConfigured) {
      setShowAutoApproveSetupModal(true);
      return;
    }
    setAutoApproveBusy(true);
    try {
      const next = autoApproveStatus?.enabled
        ? await disableAuthAutoApprove()
        : await enableAuthAutoApprove();
      setAutoApproveStatus(next);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Auto-approve toggle failed');
    } finally {
      setAutoApproveBusy(false);
    }
  }, [autoApproveSigningConfigured, autoApproveStatus?.enabled, operationalMutationsAllowed, showToast]);

  const runAction = useCallback(
    (id: string, action: (requestId: string) => void | Promise<void>, onError?: (err: unknown) => void) => {
      // Bug: 645f8a8 — block all mutating actions while the daemon is not ready
      // (rebuilding / starting). The buttons are also disabled, but gate here too
      // so no mutation POST can fire from a keyboard/programmatic trigger.
      if (!daemonReady || !operationalMutationsAllowed) {
        return;
      }
      if (!id || inFlightRef.current.has(id)) {
        return;
      }
      setInFlightState((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      Promise.resolve(action(id))
        .catch((err) => {
          onError?.(err);
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
    },
    [setInFlightState, daemonReady, operationalMutationsAllowed],
  );

  const handleApprove = useCallback(
    (id: string) => runAction(id, onApprove, (err) => {
      // Bug: 58d93ee — surface approval errors (e.g. missing command) via toast
      const message = err instanceof Error ? err.message : 'Approval failed. Try again.';
      showToast(message);
    }),
    [runAction, onApprove, showToast],
  );

  const handleReject = useCallback(
    (id: string) => runAction(id, onReject),
    [runAction, onReject],
  );

  // Bug: ad43d86 — track retry-specific in-flight state so the Retry button
  // label ("Retrying...") only fires when a retry is in flight, not when a
  // dismiss action is in flight for the same item.
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
      setRetryingIdsState((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      runAction(id, onRetry, undefined);
      // Clean up retryingIds when inFlight clears (use a microtask to stay in sync)
      Promise.resolve().then(() => {
        // retryingIds is cleaned when inFlight clears — watch via effect below
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

  const handleDismiss = useCallback(
    (id: string) => runAction(id, onDismiss, () => showToast('Dismiss failed. Try again.')),
    [runAction, onDismiss, showToast],
  );

  const handleToggleActionVeto = useCallback(
    (requestId: string, action: AuthRequestAction, vetoed: boolean) => {
      if (!operationalMutationsAllowed) {
        showToast('Auth mutations are disabled on this Mandible preview instance.');
        return;
      }
      if (inFlightActionIdsRef.current.has(action.id)) return;
      setInFlightActionIds((prev) => {
        const next = new Set(prev);
        next.add(action.id);
        inFlightActionIdsRef.current = next;
        return next;
      });
      setAuthRequestActionVeto(requestId, action.id, vetoed)
        .then((updated) => updateActionForRequest(requestId, updated))
        .catch((err) => showToast(err instanceof Error ? err.message : 'Action veto update failed.'))
        .finally(() => {
          setInFlightActionIds((prev) => {
            const next = new Set(prev);
            next.delete(action.id);
            inFlightActionIdsRef.current = next;
            return next;
          });
        });
    },
    [operationalMutationsAllowed, showToast, updateActionForRequest],
  );

  const [dismissConfirmId, setDismissConfirmId] = useState<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  const toggleDismissConfirm = useCallback(
    (id: string) => {
      if (dismissConfirmId === id) {
        setDismissConfirmId(null);
        if (dismissTimerRef.current) {
          clearTimeout(dismissTimerRef.current);
          dismissTimerRef.current = null;
        }
        handleDismiss(id);
        return;
      }
      setDismissConfirmId(id);
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }
      dismissTimerRef.current = setTimeout(() => {
        setDismissConfirmId(null);
        dismissTimerRef.current = null;
      }, 3000);
    },
    [dismissConfirmId, handleDismiss],
  );

  // Bug: 544ce35 — dependency warning modal state: tracks the request ID
  // we're about to approve when it has an incomplete dependency.
  const [pendingApproveId, setPendingApproveId] = useState<string | null>(null);

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

  // Find the selected request from whichever list contains it
  const selectedRequestRaw = useMemo((): AuthRequest | null => {
    if (!selectedId) return null;
    return (
      queue.find((r) => getAuthId(r) === selectedId) ??
      (historyQueue ?? []).find((r) => getAuthId(r) === selectedId) ??
      null
    );
  }, [selectedId, queue, historyQueue]);

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
        setHydratedBodies((prev) => ({
          ...prev,
          [selectedId]: {
            diff_summary: typeof detail.diff_summary === 'string' ? detail.diff_summary : '',
            spec_content: typeof detail.spec_content === 'string' ? detail.spec_content : '',
            output: typeof detail.output === 'string' ? detail.output : '',
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
      setActionListForRequest(requestId, inlineActions);
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
  }, [selectedRequest, setActionListForRequest]);

  // Auto-select first item when sidebar list changes and nothing is selected.
  // Bug: 2eeadd0 — Also clear selectedId when the selected item is no longer
  // present in the sidebar (e.g. all items completed/dismissed and queue empties),
  // so the orphaned detail card does not remain visible with an empty sidebar.
  useEffect(() => {
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
      // Completed/rejected/dismissed — no actions
      return null;
    }
    // Bug: 645f8a8 — while the daemon is not ready (rebuilding / starting), all
    // mutating actions are blocked. Kept separate from actionDisabled (in-flight)
    // so it doesn't trip the "Submitting…" label when nothing is actually queued.
    const mutationsBlocked = !daemonReady || !operationalMutationsAllowed;
    const actionDisabled = inFlight.has(id);
    // Bug: 816476e — isExecuting covers both the optimistic 'approved' status and
    // the inFlight window before the API returns (where status is still 'pending'
    // but a click is in progress). Both cases should hide Approve/Reject and show
    // an in-progress label.
    const isExecuting = status === 'approved' || status === 'executing';
    const isSubmitting = actionDisabled && !isExecuting && !isFailed;
    const showForceDismiss = !isHistory && !isFailed && !isExecuting && !isSubmitting;

    if (isFailed) {
      // Bug: ad43d86 — only show "Retrying..." when a retry is specifically in
      // flight. If a dismiss is in flight, the Retry button stays labeled "Retry"
      // (just disabled) so the user sees what action is actually happening.
      const isRetrying = retryingIds.has(id);
      return (
        <div className="auth-actions">
          <button
            type="button"
            className="btn btn--success"
            onClick={() => handleRetry(id)}
            disabled={actionDisabled || mutationsBlocked}
          >
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
          <button
            type="button"
            className={`btn btn--danger${dismissConfirmId === id ? ' btn--confirm' : ''}`}
            onClick={() => toggleDismissConfirm(id)}
            disabled={actionDisabled || mutationsBlocked}
          >
            {actionDisabled && !isRetrying ? 'Dismissing...' : dismissConfirmId === id ? 'Confirm dismiss?' : 'Dismiss'}
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
            Submitting…
          </button>
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

    // Bug: 544ce35 — check dependency before approving; show warning modal if incomplete
    const handleApproveClick = () => {
      if (
        request.depends_on_id &&
        request.depends_on_status !== 'completed'
      ) {
        setPendingApproveId(id);
        return;
      }
      handleApprove(id);
    };
    return (
      <div className="auth-actions">
        <button
          type="button"
          className="btn btn--success"
          onClick={handleApproveClick}
          disabled={actionDisabled || mutationsBlocked}
        >
          Approve
        </button>
        <button
          type="button"
          className={`btn btn--danger${rejectConfirmId === id ? ' btn--confirm' : ''}`}
          onClick={() => toggleRejectConfirm(id)}
          disabled={actionDisabled || mutationsBlocked}
        >
          {rejectConfirmId === id ? 'Confirm reject?' : 'Reject'}
        </button>
        {showForceDismiss && (
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => handleDismiss(id)}
            disabled={actionDisabled || mutationsBlocked}
          >
            Force Dismiss
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="auth-sidebar-layout">
      {toastMessage && (
        <div className="auth-toast auth-toast--floating" role="status">
          {toastMessage}
        </div>
      )}
      {showAutoApproveSetupModal && (
        <div className="auth-dep-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="auth-auto-approve-setup-title">
          <div className="auth-dep-modal">
            <h3 className="auth-dep-modal__title" id="auth-auto-approve-setup-title">
              Auto-approve is not configured
            </h3>
            <p className="auth-dep-modal__body">
              Auto-approve needs delegated signing setup before it can create temporary approval leases.
            </p>
            <div className="auth-dep-modal__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setShowAutoApproveSetupModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--active"
                onClick={() => {
                  setShowAutoApproveSetupModal(false);
                  window.location.hash = '#/settings?section=auth';
                }}
              >
                Go to Settings
              </button>
            </div>
          </div>
        </div>
      )}

      <ViewSidebar
        storageKey="sidebar-width:auth"
        defaultWidth={320}
        minWidth={190}
        className="auth-sidebar"
        ariaLabel="Auth requests"
        hidden={sidebarHidden}
        header={
          <SidebarSearchFilterHeader
            value={authSearch}
            onValueChange={setAuthSearch}
            placeholder="Search auth requests..."
            searchAriaLabel="Search auth requests"
            clearAriaLabel="Clear auth search"
            inputType="text"
            onBlurWithin={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setFilterMenuOpen(false);
                }
              }}
            filterTrigger={{
              ariaLabel: 'Advanced auth filters',
              title: 'Advanced auth filters',
              open: filterMenuOpen,
              active: Boolean(activeFilterSummary),
              onToggle: () => setFilterMenuOpen((prev) => !prev),
            }}
            summarySlot={activeFilterSummary ? <span>{activeFilterSummary}</span> : undefined}
            panel={filterMenuOpen ? {
              variant: 'popover',
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
        footer={
            <div className="auth-auto-approve">
              <div className="auth-auto-approve__text">
                <span className="auth-auto-approve__label">Auto-approve</span>
                <span className="auth-auto-approve__status">
                  {instanceMutationBlocked
                    ? `Disabled on ${instanceLabel}`
                    : autoApproveStatus?.enabled ? `On for ${formatRemaining(autoApproveStatus.remaining_ms)}` : 'Off'}
                </span>
              </div>
              <button
                type="button"
                className={`auth-auto-approve__switch${autoApproveStatus?.enabled ? ' auth-auto-approve__switch--on' : ''}`}
                role="switch"
                aria-checked={Boolean(autoApproveStatus?.enabled)}
                aria-label="Toggle auth auto-approve"
                disabled={autoApproveBusy || !autoApproveStatus || instanceMutationBlocked}
                onClick={() => void handleAutoApproveToggle()}
              >
                <span className="auth-auto-approve__knob" />
              </button>
            </div>
        }
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
                              : 'No auth requests.'}
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
        className={`auth-detail${previewNotice ? ' auth-detail--with-preview-notice' : ''}`}
        style={{ position: 'relative' }}
      >
        {previewNotice}
        {!selectedRequest ? (
          <div className="auth-detail__empty">
            <p className="text-muted">Select a request to view details</p>
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
          return (
            <AuthRequestDetail
              request={request}
              history={isHistory}
              failureSummary={failureSummary}
              attemptCount={attemptCount}
              branchMerged={isHistory && !isFailed && isBranchMerged(request, branchesByRepo)}
              executionOutput={outputs[id]}
              actionBundle={
                requestActions.length > 0 ? (
                  <AuthActionBundle
                    request={request}
                    actions={requestActions}
                    inFlightActionIds={inFlightActionIds}
                    mutationsAllowed={operationalMutationsAllowed}
                    onToggleVeto={handleToggleActionVeto}
                  />
                ) : null
              }
              actions={renderDetailActions(request)}
              onUpdateField={onUpdateField}
              mutationsAllowed={operationalMutationsAllowed}
            />
          );
        })()}

        {/* Bug: 544ce35 — Dependency warning modal overlay (scoped to detail panel) */}
        {pendingApproveId && (() => {
          const pendingRequest = queue.find((r) => getAuthId(r) === pendingApproveId)
            ?? (historyQueue ?? []).find((r) => getAuthId(r) === pendingApproveId);
          if (!pendingRequest) return null;
          const depId = pendingRequest.depends_on_id;
          const depStatus = pendingRequest.depends_on_status ?? 'unknown';
          const depHash = depId ? depId.slice(0, 8) : '';
          return (
            <div className="auth-dep-modal-overlay" onClick={() => setPendingApproveId(null)}>
              <div className="auth-dep-modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="auth-dep-modal__title">Dependency not completed</h3>
                <p className="auth-dep-modal__body">
                  This request depends on <span className="auth-dep-modal__hash">{depHash}</span>{' '}
                  which is currently <span className={`auth-dep-modal__status auth-dep-modal__status--${depStatus}`}>{depStatus}</span>.
                  Approving out of order may cause merge conflicts or broken builds.
                </p>
                <div className="auth-dep-modal__actions">
                  <button
                    type="button"
                    className="btn btn--warning"
                    onClick={() => {
                      const id = pendingApproveId;
                      setPendingApproveId(null);
                      handleApprove(id);
                    }}
                  >
                    Approve anyway
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      if (depId) {
                        handleSelect(depId);
                        // Scroll to the dependency in the sidebar
                        setTimeout(() => {
                          const el = document.querySelector(`[data-request-id="${depId}"]`);
                          if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                          }
                        }, 100);
                      }
                      setPendingApproveId(null);
                    }}
                  >
                    Go to dependency
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setPendingApproveId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
