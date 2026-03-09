import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';

export type AuthRequest = {
  id?: string;
  request_id?: string;
  session_id?: string | null;
  title?: string;
  summary?: string;
  repo?: string;
  base?: string;
  head?: string;
  base_branch?: string;
  head_branch?: string;
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
  created_at?: string | number;
  last_executed_at?: string | number | null;
  resolved_at?: number | string | null;
  [key: string]: unknown;
};

export type AuthQueueViewProps = {
  queue: AuthRequest[];
  historyQueue?: AuthRequest[];
  outputs: Record<string, string>;
  /** Known branch names per repo — used to detect stale entries whose branch was merged & deleted. */
  branchesByRepo?: Record<string, string[]>;
  selectedAuthId?: string | null;
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

function getStats(request: AuthRequest): { files: number | null; additions: number | null; deletions: number | null } {
  const files = request.stats?.files ?? request.files_changed ?? null;
  const additions = request.stats?.additions ?? request.additions ?? null;
  const deletions = request.stats?.deletions ?? request.deletions ?? null;
  return { files, additions, deletions };
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

/** Extract Bug: references from commit message. Returns issue ID prefixes. */
function extractBugRefs(message: string): string[] {
  if (!message) return [];
  const refs: string[] = [];
  const regex = /^Bug:\s+(\S+)/gm;
  let match;
  while ((match = regex.exec(message)) !== null) {
    refs.push(match[1]);
  }
  return refs;
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

function formatRelativeTime(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

function getStatusLabel(request: AuthRequest): string {
  const status = getAuthStatus(request);
  if (status === 'approved' || status === 'executing') return 'Executing';
  if (status === 'completed') {
    if (request.exit_code != null && request.exit_code !== 0) return 'Failed';
    return 'Completed';
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function getStatusClass(request: AuthRequest): string {
  const status = getAuthStatus(request);
  if (status === 'completed' && request.exit_code != null && request.exit_code !== 0) {
    return 'status-pill status-pill--failed';
  }
  return `status-pill status-pill--${status.toLowerCase()}`;
}

function truncateSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
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

function renderMarkdown(src: string): string {
  const result = marked.parse(src, { async: false });
  return typeof result === 'string' ? result : '';
}

/**
 * Render inline markdown — strips the outer <p>…</p> wrapper for single-line
 * input so text flows inline in compact contexts (sidebar titles, card headers).
 * Bug: a44fd6a — markdown rendering in auth sidebar and card titles
 */
function renderInlineMarkdown(src: string): string {
  if (!src) return '';
  const result = marked.parse(src, { async: false });
  const html = typeof result === 'string' ? result : '';
  return html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
}

type DiffFileSection = { filename: string; hunks: string };

/** Parse unified diff into per-file sections, stripping noise lines. */
function parseDiffSections(raw: string): DiffFileSection[] {
  const sections: DiffFileSection[] = [];
  // Split on "diff --git" boundaries, keeping the delimiter
  const parts = raw.split(/^(?=diff --git )/m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Extract filename from "diff --git a/path b/path"
    const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\/(.+)/m);
    const filename = headerMatch ? headerMatch[2] : 'unknown';
    // Strip noise lines, keep @@ hunk headers and content lines (+/-/space)
    const lines = trimmed.split('\n').filter((line) => {
      if (line.startsWith('diff --git ')) return false;
      if (line.startsWith('index ')) return false;
      if (line.startsWith('--- ')) return false;
      if (line.startsWith('+++ ')) return false;
      if (line.startsWith('new file mode')) return false;
      if (line.startsWith('deleted file mode')) return false;
      if (line.startsWith('old mode')) return false;
      if (line.startsWith('new mode')) return false;
      if (line.startsWith('similarity index')) return false;
      if (line.startsWith('rename from')) return false;
      if (line.startsWith('rename to')) return false;
      return true;
    });
    sections.push({ filename, hunks: lines.join('\n') });
  }
  return sections;
}

/** Render hunks string (already stripped of noise) as syntax-highlighted HTML. */
function renderHunksHtml(raw: string): string {
  const lines = raw.split('\n');
  const escaped = lines.map((line) => {
    const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (line.startsWith('@@')) {
      return `<span class="diff-hunk">${esc}</span>`;
    }
    if (line.startsWith('+')) {
      return `<span class="diff-add">${esc}</span>`;
    }
    if (line.startsWith('-')) {
      return `<span class="diff-del">${esc}</span>`;
    }
    return esc;
  });
  return `<pre class="diff-content">${escaped.join('\n')}</pre>`;
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

  const submissionLabel = createdAtMs != null ? formatRelativeTime(createdAtMs) : 'unknown';
  const lastAttemptLabel = showLastAttempt && lastExecutedAtMs != null
    ? `last attempt: ${formatRelativeTime(lastExecutedAtMs)}`
    : null;
  return lastAttemptLabel
    ? `${submissionLabel} · ${lastAttemptLabel}`
    : submissionLabel;
}

function getResolvedTimestampLabel(request: AuthRequest): string {
  const resolvedAtMs = getResolvedAtMs(request);
  return `resolved ${formatRelativeTime(resolvedAtMs)}`;
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
  actions,
  executionOutput,
  dragging,
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onUpdateField,
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
  actions?: JSX.Element | null;
  executionOutput?: string;
  dragging?: boolean;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  onUpdateField?: (requestId: string, field: string, value: string) => void | Promise<void>;
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
  const commitHtml = useMemo(() => commitBody ? renderMarkdown(commitBody) : '', [commitBody]);
  const specHtml = useMemo(() => specContent ? renderMarkdown(specContent) : '', [specContent]);
  const diffSections = useMemo(() => parseDiffSections(diffRaw), [diffRaw]);
  const diffHtml = useMemo(() => {
    if (selectedFile === -1) {
      return renderHunksHtml(diffSections.map((s) => s.hunks).join('\n'));
    }
    return renderHunksHtml(diffSections[selectedFile]?.hunks || '');
  }, [diffSections, selectedFile]);

  // Determine console output: prefer streaming outputs, fall back to request.output
  const rawConsoleOutput = executionOutput ||
    (typeof request.output === 'string' ? request.output : '');
  const consoleText = useMemo(() => stripAnsi(rawConsoleOutput), [rawConsoleOutput]);
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

  // Bug: 816476e — show YubiKey warning and auto-open output for approved/executing state
  const isApproved = status === 'approved' || status === 'executing';
  const showYubikeyWarning = expanded && isApproved;

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
  const hasTags = Boolean(commitBranch || attemptLabel || branchMerged || (headBranch && baseBranch));

  // Session & issue links
  const sessionId = request.session_id;
  const bugRefs = useMemo(() => extractBugRefs(commitMsg), [commitMsg]);
  const canIssueLink = Boolean(repoId) && !looksLikeBranchName(repoId);
  const hasLinks = Boolean(sessionId) || (bugRefs.length > 0 && canIssueLink);

  // Bug: 816476e — auto-open console output when status transitions to approved
  // so live output is visible without requiring a manual click.
  useEffect(() => {
    if (isApproved) {
      setShowConsole(true);
    }
  }, [isApproved]);

  // Auto-scroll console to bottom when output updates
  useEffect(() => {
    if (showConsole && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [showConsole, consoleText]);

  const effectiveTimestampLabel = timestampLabel ?? getSubmissionTimestampLabel(request);

  const hasStats = stats.files != null || stats.additions != null || stats.deletions != null;
  const statsLine = (
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
  );

  const summaryContent = (
    <div className="auth-card__summary">
      <div className="auth-card__row auth-card__row--primary">
        <span className={statusClass}>{statusLabel}</span>
        {/* Bug: a44fd6a — render auth request title as inline markdown */}
        <span
          className="auth-card__title"
          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(getAuthTitle(request)) }}
        />
        {repoName && (
          <span className="auth-card__repo">{repoName}</span>
        )}
      </div>
      <div className="auth-card__row auth-card__row--stats">
        {statsLine}
        <span className="auth-card__divider">|</span>
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
          {branchMerged && (
            <span className="branch-merged-tag">Branch merged — safe to dismiss</span>
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
          {bugRefs.length > 0 && canIssueLink && (
            bugRefs.map((ref) => (
              <a
                key={ref}
                className="auth-card__link auth-card__link--issue"
                href={`#/issues?repo=${encodeURIComponent(repoId)}&issue=${encodeURIComponent(ref)}`}
                onClick={(e) => e.stopPropagation()}
              >
                Issue {ref.slice(0, 8)}
              </a>
            ))
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
                  {status === 'expired' ? 'Expired' : 'Failed'}
                </span>
                {request.exit_code != null && request.exit_code !== 0 && (
                  <span className="auth-failure__code">Exit {request.exit_code}</span>
                )}
              </div>
              <p className="auth-failure__summary">
                {failureSummary ||
                  (status === 'expired' ? 'Expired without a response.' : 'No output captured.')}
              </p>
            </div>
          )}

          {/* Bug: 816476e — YubiKey warning banner when execution is queued/running */}
          {showYubikeyWarning && (
            <div className="auth-yubikey-warning">
              <span className="auth-yubikey-warning__spinner" aria-hidden="true" />
              <span className="auth-yubikey-warning__text">
                Executing — touch your YubiKey when it lights up
              </span>
            </div>
          )}

          <div className="auth-card__panels">
            <div className="auth-card__left-col">
              <div className="panel">
                <button
                  type="button"
                  className="panel__toggle"
                  onClick={() => setShowCommit((prev) => !prev)}
                >
                  <span className={`panel__chevron${showCommit ? ' panel__chevron--open' : ''}`}>
                    {'\u25B8'}
                  </span>
                  Commit Message
                  {/* Bug: 2c826ca — editable commit message for pending/failed requests */}
                  {onUpdateField && (status === 'pending' || failedLike) && !editingCommitMsg && (
                    <span
                      className="panel__edit-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditCommitValue(commitMsg);
                        setEditingCommitMsg(true);
                      }}
                    >
                      edit
                    </span>
                  )}
                </button>
                {showCommit && (
                  editingCommitMsg ? (
                    <div className="panel__body spec-panel">
                      <textarea
                        className="panel__edit-textarea"
                        value={editCommitValue}
                        onInput={(e) => setEditCommitValue((e.target as HTMLTextAreaElement).value)}
                        rows={8}
                      />
                      <div className="panel__edit-actions">
                        <button
                          type="button"
                          className="panel__edit-save"
                          onClick={() => {
                            const id = getAuthId(request);
                            if (id && onUpdateField) {
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
                Changes
              </button>
              {showDiff && (
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
              )}
            </div>
          </div>

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
      onClick={() => onSelect(id)}
    >
      <span className={`auth-sidebar-item__dot auth-sidebar-item__dot--${dotStatus}`} />
      <span className="auth-sidebar-item__body">
        {/* Bug: a44fd6a — render auth sidebar title as inline markdown */}
        <span
          className="auth-sidebar-item__title"
          dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(getAuthTitle(request)) }}
        />
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

type AuthFilterMode = 'active' | 'all' | 'historical';

export function AuthQueueView({
  queue,
  historyQueue,
  outputs,
  branchesByRepo,
  selectedAuthId: externalSelectedId,
  onSelectAuth,
  onApprove,
  onReject,
  onRetry,
  onDismiss,
  onUpdateField,
}: AuthQueueViewProps): JSX.Element {
  // Sidebar filter: Active (default) | All | Historical
  const [filterMode, setFilterMode] = useState<AuthFilterMode>('active');

  // Repo filter: null = show all repos
  const [repoFilter, setRepoFilter] = useState<string | null>(null);

  // Local selection state — mirrors app state via onSelectAuth
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const selectedId = externalSelectedId !== undefined ? externalSelectedId : localSelectedId;

  const handleSelect = useCallback((id: string) => {
    setLocalSelectedId(id);
    onSelectAuth?.(id);
  }, [onSelectAuth]);

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

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const runAction = useCallback(
    (id: string, action: (requestId: string) => void | Promise<void>, onError?: (err: unknown) => void) => {
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
    [setInFlightState],
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

  // Derive unique repo names from all sidebar items (before repo filtering)
  const uniqueRepos = useMemo((): string[] => {
    const repos = new Set<string>();
    for (const r of sidebarItems) {
      const repo = r.repo && r.repo.trim() ? r.repo.trim() : null;
      if (repo) repos.add(repo);
    }
    return Array.from(repos).sort();
  }, [sidebarItems]);

  // Reset repoFilter if it no longer exists in the current list
  useEffect(() => {
    if (repoFilter && !uniqueRepos.includes(repoFilter)) {
      setRepoFilter(null);
    }
  }, [uniqueRepos, repoFilter]);

  // Apply repo filter on top of the mode-filtered list
  const filteredSidebarItems = useMemo((): AuthRequest[] => {
    if (!repoFilter) return sidebarItems;
    return sidebarItems.filter((r) => {
      const repo = r.repo && r.repo.trim() ? r.repo.trim() : null;
      return repo === repoFilter;
    });
  }, [sidebarItems, repoFilter]);

  // Find the selected request from whichever list contains it
  const selectedRequest = useMemo((): AuthRequest | null => {
    if (!selectedId) return null;
    return (
      queue.find((r) => getAuthId(r) === selectedId) ??
      (historyQueue ?? []).find((r) => getAuthId(r) === selectedId) ??
      null
    );
  }, [selectedId, queue, historyQueue]);

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
  }, [filterMode, repoFilter, filteredSidebarItems]);

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
            disabled={actionDisabled}
          >
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
          <button
            type="button"
            className={`btn btn--danger${dismissConfirmId === id ? ' btn--confirm' : ''}`}
            onClick={() => toggleDismissConfirm(id)}
            disabled={actionDisabled}
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
    // and let the YubiKey warning banner in the card body carry status.
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

    return (
      <div className="auth-actions">
        <button
          type="button"
          className="btn btn--success"
          onClick={() => handleApprove(id)}
          disabled={actionDisabled}
        >
          Approve
        </button>
        <button
          type="button"
          className={`btn btn--danger${rejectConfirmId === id ? ' btn--confirm' : ''}`}
          onClick={() => toggleRejectConfirm(id)}
          disabled={actionDisabled}
        >
          {rejectConfirmId === id ? 'Confirm reject?' : 'Reject'}
        </button>
        {showForceDismiss && (
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => handleDismiss(id)}
            disabled={actionDisabled}
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

      {/* LEFT sidebar */}
      <div className="auth-sidebar">
        <div className="auth-sidebar__header">
          <div className="auth-sidebar__filters">
            <button
              type="button"
              className={`auth-sidebar__filter-btn${filterMode === 'active' ? ' auth-sidebar__filter-btn--active' : ''}`}
              onClick={() => setFilterMode('active')}
            >
              Active
            </button>
            <button
              type="button"
              className={`auth-sidebar__filter-btn${filterMode === 'all' ? ' auth-sidebar__filter-btn--active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`auth-sidebar__filter-btn${filterMode === 'historical' ? ' auth-sidebar__filter-btn--active' : ''}`}
              onClick={() => setFilterMode('historical')}
            >
              Historical
            </button>
          </div>
          {filterMode === 'active' && (
            <div className="auth-sidebar__sort">
              <select
                value={sortMode}
                onChange={(event) => handleSortChange(event.currentTarget.value as SortMode)}
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="status">Status</option>
              </select>
            </div>
          )}
        </div>

        {uniqueRepos.length > 1 && (
          <div className="auth-sidebar__repo-filter">
            <button
              type="button"
              className={`auth-sidebar__repo-btn${repoFilter === null ? ' auth-sidebar__repo-btn--active' : ''}`}
              onClick={() => setRepoFilter(null)}
            >
              All repos
            </button>
            {uniqueRepos.map((repo) => (
              <button
                key={repo}
                type="button"
                className={`auth-sidebar__repo-btn${repoFilter === repo ? ' auth-sidebar__repo-btn--active' : ''}`}
                onClick={() => setRepoFilter(repoFilter === repo ? null : repo)}
              >
                {repo}
              </button>
            ))}
          </div>
        )}

        <div className="auth-sidebar__list">
          {filteredSidebarItems.length === 0 ? (
            <div className="auth-sidebar__empty">
              {repoFilter
                ? `No requests for ${repoFilter}.`
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
        </div>
      </div>

      {/* RIGHT detail panel */}
      <div className="auth-detail">
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
          return (
            <AuthCard
              request={request}
              expanded
              history={isHistory}
              failureSummary={failureSummary}
              attemptCount={attemptCount}
              branchMerged={isHistory && !isFailed && isBranchMerged(request, branchesByRepo)}
              executionOutput={outputs[id]}
              actions={renderDetailActions(request)}
              onUpdateField={onUpdateField}
            />
          );
        })()}
      </div>
    </div>
  );
}
