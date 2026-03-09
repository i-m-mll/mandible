import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { openPath, patchSession } from '../api.js';

// Bug: a44fd6a — render task/intent fields as inline markdown
marked.setOptions({ async: false, gfm: true, breaks: false });

/**
 * Strip dangerous tags and attributes from HTML produced by marked.
 * Keeps safe inline tags (strong, em, code, a, del, s, sup, sub, span).
 * Bug: 387ae46 — sanitize marked output before dangerouslySetInnerHTML
 */
function sanitizeInlineHtml(html: string): string {
  let out = html.replace(
    /<(script|iframe|object|embed|form|style|svg|math)[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  out = out.replace(/<(script|iframe|object|embed|form|style|svg|math)[^>]*\/>/gi, '');
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  out = out.replace(/\s+(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '');
  return out;
}

/**
 * Render inline markdown — strips the outer <p>…</p> wrapper that marked adds
 * for single-line input so the text flows inline in table cells without extra
 * block spacing.
 */
function renderInlineMarkdown(src: string): string {
  if (!src) return '';
  const html = marked.parse(src, { async: false }) as string;
  const stripped = html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
  return sanitizeInlineHtml(stripped);
}

export type IssueLink = {
  issue_id: string;
  repo_id: string;
  created_at: number;
  status?: string;
};

export type ProjectLink = {
  repo_id: string;
  repo_name: string;
};

export type SessionRecord = {
  id?: string;
  session_id?: string;
  status?: string;
  state?: string;
  app?: string;
  agent?: string;
  task?: string;
  intent?: string;
  branch?: string;
  worktree?: string;
  worktree_path?: string;
  cwd?: string;
  created_at?: string;
  started_at?: string;
  start_time?: string;
  ended_at?: string;
  end_time?: string;
  updated_at?: string;
  // Bug: e01653d — real user activity time from JSONL transcript mtime
  last_active?: string | null;
  parent_id?: string;
  parentId?: string;
  children?: SessionRecord[];
  pinned?: number;
  nav_metadata_status?: string;
  nav_metadata_attempts?: number;
  nav_metadata_last_error?: string;
  issues?: IssueLink[];
  projects?: ProjectLink[];
  [key: string]: unknown;
};

export type SessionsViewProps = {
  sessions: SessionRecord[];
  newSessionIds: Record<string, number>;
  onNavigate: (sessionId: string) => void;
  onKill: (sessionId: string) => void;
  onPinToggle?: (sessionId: string, pinned: boolean) => void;
  highlightSessionId?: string;
};

const TEN_MINUTES = 10 * 60 * 1000;
/** Default reap threshold (minutes) — sessions idle longer are highlighted. */
const REAP_THRESHOLD_MINUTES = 30;
const COL_COUNT = 8;

function getSessionId(session: SessionRecord): string {
  return (
    session.id ||
    session.session_id ||
    String(session.id ?? session.session_id ?? '')
  );
}

function getSessionParentId(session: SessionRecord): string | null {
  return (session.parent_id || session.parentId || null) as string | null;
}

function getSessionStatus(session: SessionRecord): string {
  return session.status || session.state || 'unknown';
}

function getSessionTask(session: SessionRecord): string {
  return session.task || session.intent || '\u2014';
}

function getSessionBranch(session: SessionRecord): string {
  return session.branch || '\u2014';
}

function getSessionCwd(session: SessionRecord): string {
  return (session.cwd || session.worktree || session.worktree_path || '') as string;
}

function getSessionApp(session: SessionRecord): string {
  return session.app || session.agent || 'Agent';
}

function getNavMetadataStatus(session: SessionRecord): string {
  return session.nav_metadata_status || 'not_applicable';
}

function parseTimestamp(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Format duration as hours + minutes only (e.g., "30h 15m", "< 1m") */
function formatDuration(start: number | null, end: number | null = null): string {
  if (!start) {
    return '\u2014';
  }
  const now = end ?? Date.now();
  const delta = Math.max(now - start, 0);
  const totalMinutes = Math.floor(delta / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;

  if (totalMinutes < 1) {
    return '< 1m';
  }
  if (totalHours > 0) {
    return `${totalHours}h ${m}m`;
  }
  return `${m}m`;
}

function shouldHideSession(session: SessionRecord): boolean {
  const status = getSessionStatus(session).toLowerCase();
  if (status !== 'dead' && status !== 'reaped') {
    return false;
  }
  const endTimestamp =
    parseTimestamp(session.ended_at) ||
    parseTimestamp(session.end_time) ||
    parseTimestamp(session.updated_at);
  if (!endTimestamp) {
    return false;
  }
  return Date.now() - endTimestamp > TEN_MINUTES;
}

function isDeadSession(session: SessionRecord): boolean {
  const status = getSessionStatus(session).toLowerCase();
  return status === 'dead' || status === 'ended' || status === 'closed' || status === 'reaped';
}

function isReapedSession(session: SessionRecord): boolean {
  const status = getSessionStatus(session).toLowerCase();
  return status === 'reaped';
}

/** Returns minutes since last activity, or null if not applicable.
 *  Bug: e01653d — prefer last_active (JSONL mtime) over updated_at,
 *  because updated_at is bumped by any DB write (nav metadata, etc.)
 *  and does not reflect actual user interaction. */
function getInactiveMinutes(session: SessionRecord): number | null {
  const status = getSessionStatus(session).toLowerCase();
  if (status !== 'active' && status !== 'idle') {
    return null;
  }
  // Prefer last_active (set from JSONL transcript mtime by ingestion watcher),
  // fall back to updated_at only if last_active is absent.
  const lastActive = parseTimestamp(session.last_active as string | undefined);
  const updatedAt = parseTimestamp(session.updated_at);
  const reference = lastActive ?? updatedAt;
  if (!reference) {
    return null;
  }
  return Math.floor((Date.now() - reference) / 60_000);
}

/** Format inactive duration as a human-readable short string. */
function formatInactive(minutes: number | null): string {
  if (minutes === null) {
    return '\u2014';
  }
  if (minutes < 1) {
    return '<1m';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes('active')) {
    return 'status-dot status-dot--green';
  }
  if (normalized.includes('idle')) {
    return 'status-dot status-dot--yellow';
  }
  if (normalized.includes('reaped')) {
    return 'status-dot status-dot--reaped';
  }
  if (normalized.includes('dead') || normalized.includes('closed') || normalized.includes('ended')) {
    return 'status-dot status-dot--red';
  }
  return 'status-dot';
}

function appBadge(app: string): string {
  const normalized = app.toLowerCase();
  if (normalized.includes('claude')) {
    return 'app-badge app-badge--claude';
  }
  if (normalized.includes('codex')) {
    return 'app-badge app-badge--codex';
  }
  return 'app-badge';
}

function buildTree(sessions: SessionRecord[]): {
  roots: SessionRecord[];
  childrenMap: Map<string, SessionRecord[]>;
} {
  const byId = new Map<string, SessionRecord>();
  sessions.forEach((session) => {
    const id = getSessionId(session);
    if (id) {
      byId.set(id, session);
    }
  });
  const childrenMap = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  sessions.forEach((session) => {
    const parentId = getSessionParentId(session);
    if (parentId && byId.has(parentId)) {
      const bucket = childrenMap.get(parentId) || [];
      bucket.push(session);
      childrenMap.set(parentId, bucket);
    } else {
      roots.push(session);
    }
  });
  return { roots, childrenMap };
}

function countDescendants(
  sessionId: string,
  childrenMap: Map<string, SessionRecord[]>,
): number {
  const children = childrenMap.get(sessionId) || [];
  let count = children.length;
  for (const child of children) {
    const childId = getSessionId(child);
    if (childId) {
      count += countDescendants(childId, childrenMap);
    }
  }
  return count;
}

function isTreeDead(
  session: SessionRecord,
  childrenMap: Map<string, SessionRecord[]>,
): boolean {
  if (!isDeadSession(session)) {
    return false;
  }
  const sessionId = getSessionId(session);
  const children = sessionId ? childrenMap.get(sessionId) || [] : [];
  return children.every((child) => isTreeDead(child, childrenMap));
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {
    // Fallback: no-op if clipboard fails
  });
}

type RowInfo = {
  session: SessionRecord;
  depth: number;
  isLastChild: boolean;
};

/** Context menu (three-dot) dropdown component */
function ContextMenu({
  items,
}: {
  items: Array<{
    label: string;
    onClick: () => void;
    danger?: boolean;
    confirm?: string;
  }>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="session-ctx-menu" ref={ref}>
      <button
        type="button"
        className={`session-ctx-menu__trigger${open ? ' session-ctx-menu__trigger--active' : ''}`}
        onClick={() => {
          setOpen((prev) => !prev);
          setConfirming(null);
        }}
        aria-label="Actions"
      >
        {'\u22EF'}
      </button>
      {open && (
        <div className="session-ctx-menu__dropdown">
          {items.map((item) => {
            const isConfirming = confirming === item.label;
            return (
              <button
                key={item.label}
                type="button"
                className={`session-ctx-menu__item${item.danger ? ' session-ctx-menu__item--danger' : ''}${isConfirming ? ' session-ctx-menu__item--confirm' : ''}`}
                onClick={() => {
                  if (item.confirm && !isConfirming) {
                    setConfirming(item.label);
                    return;
                  }
                  item.onClick();
                  setOpen(false);
                  setConfirming(null);
                }}
              >
                {isConfirming ? item.confirm : item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Returns true if `name` looks like a branch or worktree dir name rather than a real repo name.
 * Bug: a2b777a — project column shows branch pills, issue chips navigate to wrong repo */
function looksLikeWorktreeOrBranchName(name: string): boolean {
  if (!name) return false;
  if (name === 'main' || name === 'master' || name === 'develop') return true;
  // Slash-separated or double-underscore branch prefixes (e.g. feature/foo, feature__foo)
  return /^(feature|fix|bugfix|hotfix|chore|release)(\/|__)/.test(name);
}

/** Issue pills with open/closed filtering */
function IssuePills({
  issues,
}: {
  issues: IssueLink[];
}): JSX.Element | null {
  const [showClosed, setShowClosed] = useState(false);

  if (!issues || issues.length === 0) {
    return null;
  }

  // Defensively detect open vs closed — if status field is absent, treat as open
  const openIssues = issues.filter((i) => {
    const st = (i.status || 'open').toLowerCase();
    return st === 'open';
  });
  const closedIssues = issues.filter((i) => {
    const st = (i.status || 'open').toLowerCase();
    return st !== 'open';
  });

  const displayed = showClosed ? issues : openIssues;
  const closedCount = closedIssues.length;

  return (
    <div className="linked-chips">
      {displayed.map((link) => (
        // Bug: 387ae46 — include repo param so IssuesView can select directly
        // without the slow async cross-repo find path.
        // Guard: if repo_id is absent, fall back to cross-repo find path
        // (avoids #/issues?repo=undefined&issue=<id> in the URL).
        <a
          key={`${link.repo_id}-${link.issue_id}`}
          className="linked-issue-chip"
          href={link.repo_id
            ? `#/issues?repo=${encodeURIComponent(link.repo_id)}&issue=${encodeURIComponent(link.issue_id)}`
            : `#/issues?issue=${encodeURIComponent(link.issue_id)}`}
        >
          {link.issue_id.slice(0, 8)}
        </a>
      ))}
      {closedCount > 0 && !showClosed && (
        <button
          type="button"
          className="session-closed-toggle"
          onClick={() => setShowClosed(true)}
        >
          +{closedCount} closed
        </button>
      )}
      {closedCount > 0 && showClosed && (
        <button
          type="button"
          className="session-closed-toggle"
          onClick={() => setShowClosed(false)}
        >
          hide closed
        </button>
      )}
    </div>
  );
}

export function SessionsView({
  sessions,
  newSessionIds,
  onNavigate,
  onKill,
  onPinToggle,
  highlightSessionId,
}: SessionsViewProps): JSX.Element {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [endedOpen, setEndedOpen] = useState(false);
  const [, setTick] = useState(0);
  const { roots, childrenMap } = useMemo(() => buildTree(sessions), [sessions]);

  // Re-render every 30s so live session durations stay current
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Scroll to and highlight a session when navigated to via deep-link
  useEffect(() => {
    if (highlightSessionId) {
      const el = document.querySelector(`[data-session-id="${highlightSessionId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('session-row--highlight');
        const timer = setTimeout(() => el.classList.remove('session-row--highlight'), 3000);
        return () => clearTimeout(timer);
      }
    }
  }, [highlightSessionId]);

  // Separate active vs ended root-level trees, sort pinned to top
  // Bug: 568eca7 — pinned sessions float to the top of the active list
  const { activeRoots, endedRoots } = useMemo(() => {
    const active: SessionRecord[] = [];
    const ended: SessionRecord[] = [];
    for (const root of roots) {
      if (isTreeDead(root, childrenMap)) {
        ended.push(root);
      } else {
        active.push(root);
      }
    }
    // Sort pinned sessions to the top, preserving relative order within each group
    active.sort((a, b) => (b.pinned || 0) - (a.pinned || 0));
    return { activeRoots: active, endedRoots: ended };
  }, [roots, childrenMap]);

  const toggleExpand = (sessionId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const collectRows = (
    session: SessionRecord,
    depth: number,
    isLastChild: boolean,
  ): RowInfo[] => {
    if (shouldHideSession(session)) {
      return [];
    }
    const sessionId = getSessionId(session);
    const children = sessionId ? childrenMap.get(sessionId) || [] : [];
    const visibleChildren = children.filter((c) => !shouldHideSession(c));
    const isExpanded = sessionId ? expandedIds.has(sessionId) : false;

    const result: RowInfo[] = [{ session, depth, isLastChild }];

    if (isExpanded) {
      visibleChildren.forEach((child, idx) => {
        const isLast = idx === visibleChildren.length - 1;
        result.push(...collectRows(child, depth + 1, isLast));
      });
    }

    return result;
  };

  const renderRow = ({ session, depth, isLastChild }: RowInfo): JSX.Element => {
    const sessionId = getSessionId(session);
    const children = sessionId ? childrenMap.get(sessionId) || [] : [];
    const visibleChildren = children.filter((c) => !shouldHideSession(c));
    const hasChildren = visibleChildren.length > 0;
    const isExpanded = sessionId ? expandedIds.has(sessionId) : false;
    const status = getSessionStatus(session);
    const startTimestamp =
      parseTimestamp(session.created_at) ||
      parseTimestamp(session.started_at) ||
      parseTimestamp(session.start_time);
    const endTimestamp =
      parseTimestamp(session.ended_at) || parseTimestamp(session.end_time);
    const isDead = isDeadSession(session);
    const reaped = isReapedSession(session);
    const inactiveMinutes = getInactiveMinutes(session);
    const pastReapThreshold = inactiveMinutes !== null && inactiveMinutes >= REAP_THRESHOLD_MINUTES;
    const navMetadataStatus = getNavMetadataStatus(session).toLowerCase();
    const navMetadataAttempts = Number(session.nav_metadata_attempts || 0);
    const navMetadataError = String(session.nav_metadata_last_error || '');
    const showMetadataWarning = navMetadataStatus === 'degraded' || navMetadataStatus === 'failed';
    const newTimestamp = sessionId ? newSessionIds[sessionId] : undefined;
    const isNew = newTimestamp ? Date.now() - newTimestamp < 10000 : false;
    const isPinned = Boolean(session.pinned);

    const isChild = depth > 0;
    const descendantCount = sessionId ? countDescendants(sessionId, childrenMap) : 0;
    const isParent = !isChild;
    const cwd = getSessionCwd(session);
    const branch = getSessionBranch(session);
    const rawProjects = (session.projects || []) as ProjectLink[];
    const issues = (session.issues || []) as IssueLink[];

    // Backend normalizes repo names; UI only fills empty values, deduplicates, and filters
    // out entries whose repo_id or repo_name looks like a branch/worktree dir name.
    // Bug: a2b777a — project column was showing branch-name pills when agent-commit sent
    // repo_id=feature__audit-fixes (worktree dir name) instead of the canonical repo id.
    const projects = rawProjects
      .map((p) => ({
        ...p,
        repo_name: p.repo_name || p.repo_id.split('/').pop() || p.repo_id,
      }))
      .map((p) => ({
        ...p,
        repo_name: p.repo_name.replace(/^\.+/, '') || p.repo_name,
      }))
      .filter((p, idx, arr) => arr.findIndex((x) => x.repo_name === p.repo_name) === idx)
      .filter((p) => !looksLikeWorktreeOrBranchName(p.repo_name) && !looksLikeWorktreeOrBranchName(p.repo_id));

    const rowClasses = [
      'session-row',
      isDead ? 'row-dead' : '',
      reaped ? 'row-reaped' : '',
      pastReapThreshold ? 'row-reap-warning' : '',
      isNew ? 'row-new' : '',
      isPinned ? 'row-pinned' : '',
      isChild ? 'session-row--child' : '',
      isChild && isLastChild ? 'session-row--last-child' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const depthStyle = isChild ? { '--depth': String(depth) } as Record<string, string> : undefined;

    // Build context menu items for the actions column
    const actionItems: Array<{
      label: string;
      onClick: () => void;
      danger?: boolean;
      confirm?: string;
    }> = [
      // Bug: 568eca7 — pin/unpin toggle
      {
        label: isPinned ? 'Unpin' : 'Pin',
        onClick: () => {
          if (!sessionId) return;
          const newPinned = isPinned ? 0 : 1;
          if (onPinToggle) {
            onPinToggle(sessionId, !isPinned);
          }
          patchSession(sessionId, { pinned: newPinned }).catch(() => {
            // Revert on failure
            if (onPinToggle) {
              onPinToggle(sessionId, isPinned);
            }
          });
        },
      },
      {
        label: 'Go to',
        onClick: () => sessionId && onNavigate(sessionId),
      },
      {
        label: 'Copy CWD',
        onClick: () => cwd && copyToClipboard(cwd),
      },
      {
        label: 'Open in Finder',
        onClick: () => cwd && openPath(cwd),
      },
      {
        label: 'Copy branch',
        onClick: () => branch !== '\u2014' && copyToClipboard(branch),
      },
      {
        label: 'Kill',
        onClick: () => sessionId && onKill(sessionId),
        danger: true,
        confirm: 'Confirm kill?',
      },
    ];

    return (
      <tr
        key={sessionId || Math.random()}
        className={rowClasses}
        data-depth={depth}
        data-session-id={sessionId}
        style={depthStyle}
      >
        {/* Status */}
        <td>
          <div className="cell-flex">
            <button
              type="button"
              className={`tree-toggle ${hasChildren ? '' : 'tree-toggle--empty'}`}
              onClick={() => sessionId && toggleExpand(sessionId)}
              aria-label={hasChildren ? 'Toggle subagents' : undefined}
            >
              {hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : ''}
            </button>
            <span className={statusClass(status)} />
            {isPinned && <span className="pin-badge" title="Pinned" />}
          </div>
        </td>
        {/* App */}
        <td>
          <div className="cell-flex">
            <span className={appBadge(getSessionApp(session))}>
              {getSessionApp(session).slice(0, 2).toUpperCase()}
            </span>
          </div>
        </td>
        {/* Project + branch */}
        <td>
          <div className="cell-stack">
            {projects.length > 0 ? (
              <div className="session-project-pills">
                {projects.map((p) => (
                  <span key={p.repo_id} className="session-project-pill">
                    {p.repo_name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-muted">{'\u2014'}</span>
            )}
            {branch !== '\u2014' && !looksLikeWorktreeOrBranchName(branch) && (
              <span className="session-branch-detail">{branch}</span>
            )}
          </div>
        </td>
        {/* Children */}
        <td className="session-col-children">
          {isParent && descendantCount > 0 ? descendantCount : ''}
        </td>
        {/* Duration */}
        <td>
          <span className="session-duration">{formatDuration(startTimestamp, endTimestamp)}</span>
        </td>
        {/* Inactive */}
        <td>
          <span className={`session-inactive${pastReapThreshold ? ' session-inactive--warning' : ''}`}>
            {reaped ? (
              <span className="session-reaped-badge">reaped</span>
            ) : (
              formatInactive(inactiveMinutes)
            )}
          </span>
        </td>
        {/* Task (issues) */}
        <td>
          <div className="cell-stack">
            {(() => {
              const task = getSessionTask(session);
              const hasIssues = issues && issues.length > 0;
              // Only show task text if it's meaningful (not just an m-dash)
              const showTask = task !== '\u2014';
              if (showTask) {
                return (
                  <span
                    // Bug: a44fd6a — render task/intent as inline markdown
                    dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(task) }}
                  />
                );
              }
              if (!hasIssues) {
                return <span className="text-muted">{'\u2014'}</span>;
              }
              return null;
            })()}
            {showMetadataWarning && (
              <span className="text-warning" title={navMetadataError || undefined}>
                metadata {navMetadataStatus} ({navMetadataAttempts} attempts)
              </span>
            )}
            <IssuePills issues={issues} />
          </div>
        </td>
        {/* Actions (context menu) */}
        <td>
          <ContextMenu items={actionItems} />
        </td>
      </tr>
    );
  };

  const activeRows = activeRoots.flatMap((session) => collectRows(session, 0, false));
  const endedRows = endedRoots.flatMap((session) => collectRows(session, 0, false));

  const chevronClass = `ended-section__chevron${endedOpen ? ' ended-section__chevron--open' : ''}`;

  return (
    <div className="view sessions-view">
      <div className="view-header">
        <h2>Agent Monitor</h2>
      </div>
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>App</th>
              <th>Project</th>
              <th className="session-col-children">Children</th>
              <th>Duration</th>
              <th>Inactive</th>
              <th>Task</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {activeRows.length === 0 && endedRows.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} className="empty-state">
                  No sessions yet.
                </td>
              </tr>
            ) : activeRows.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} className="empty-state">
                  No active sessions.
                </td>
              </tr>
            ) : (
              activeRows.map(renderRow)
            )}
          </tbody>
        </table>

        {endedRows.length > 0 && (
          <div className="ended-section">
            <button
              type="button"
              className="ended-section__header"
              onClick={() => setEndedOpen((prev) => !prev)}
            >
              <span className={chevronClass}>{'\u25B8'}</span>
              Ended ({endedRoots.length})
            </button>
            {endedOpen && (
              <table>
                <tbody>
                  {endedRows.map(renderRow)}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
