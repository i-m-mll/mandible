import { NativeSelect } from '../components/shared/NativeSelect';
import { Icon } from '../components/icons/Icon';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  createTrashEntry,
  canPerformOperation,
  getRepoBranchCommits,
  getWorkRepoAudit,
  getWorkCompare,
  openPath,
  pushRepos,
  pushRepo,
  type WorkCommit,
  type WorkCommitPage,
  type WorkCompareMode,
  type WorkCompareResult,
  type TrashCreateOutcome,
  type WorkAuditEntry,
  type WorkRepoAudit,
  type InstanceInfo,
} from '../api';
import { DiffView } from '../components/DiffView';
import { ViewSidebar } from '../components/ViewSidebar';
import { SidebarItemBadge, SidebarItemRow } from '../components/shared/SidebarItemRow';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { ContextualAction } from '../components/shared/ContextualAction';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { formatRelativeTime } from '../lib/format';
import { browserSessionFetch } from '../client-auth-token';
import { isViewSidebarHidden, parseRouteFromHash, replaceRouteHash, routeHashWithParams } from '../routing';
import { useViewActive } from '../app-shell';
import { WORK_SCAN_SKIP_WINDOW_MS } from '../../../src/contracts';

export type WorkRepo = {
  id?: string;
  name?: string;
  path?: string;
  root?: string;
  default_branch?: string;
  excluded?: boolean;
  user_modified?: boolean;
  last_scanned_at?: string | null;
  [key: string]: unknown;
};

export type WorkBranch = {
  name?: string;
  branch?: string;
  worktree?: string;
  worktree_path?: string;
  status?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  has_upstream?: boolean;
  upstream?: string | null;
  ahead_default?: number;
  behind_default?: number;
  default_branch?: string;
  last_commit?: {
    message?: string;
    date?: string;
    time?: string;
  };
  last_commit_message?: string;
  last_commit_time?: string;
  last_commit_date?: string;
  diff_stat?: string;
  [key: string]: unknown;
};

export type WorkOverviewProps = {
  repos: WorkRepo[];
  branchesByRepo: Record<string, WorkBranch[]>;
  onRescan: () => void | Promise<void>;
  onReposChanged?: (repos: WorkRepo[]) => void;
  instance?: InstanceInfo | null;
  params?: Record<string, string>;
};

// Bug: b5abaea — Push/sync state types
type PushRepoResult = {
  repoId: string;
  repoName: string;
  branches_pushed: number | string[];
  refs_pushed: number | string[];
  skipped: boolean;
  error?: string;
};

type PushState = {
  active: boolean;
  authPending: boolean;
  message?: string | null;
  sessionId?: string;
  repoCount?: number;
  completedCount?: number;
  repoProgress: Map<string, "pending" | "pushing" | "done" | "error">;
  lastResult?: { repos: PushRepoResult[]; duration_ms: number } | null;
};

const PROTECTED_BRANCHES = new Set(['main', 'develop']);

function getRepoId(repo: WorkRepo): string {
  return repo.id || repo.name || '';
}

function getRepoTitle(repo: WorkRepo, repoId: string): string {
  const root = repo.root || repo.path || '';
  const base = root ? root.split(/[\\/]/).filter(Boolean).pop() : '';
  return repo.name || base || repoId || 'Unknown repo';
}

function getRepoPath(repo: WorkRepo): string | null {
  return repo.root || repo.path || null;
}

function getBranchName(branch: WorkBranch): string {
  return branch.name || branch.branch || '\u2014';
}

function getWorktreePath(branch: WorkBranch): string | null {
  const p = branch.worktree || branch.worktree_path;
  return p || null;
}

function isDirty(branch: WorkBranch): boolean {
  if (typeof branch.dirty === 'boolean') {
    return branch.dirty;
  }
  return branch.status ? branch.status.toLowerCase() === 'dirty' : false;
}

function getBranchStatus(branch: WorkBranch): 'dirty' | 'clean' {
  return isDirty(branch) ? 'dirty' : 'clean';
}

function formatBranchStatus(status: 'dirty' | 'clean'): string {
  return status === 'dirty' ? 'Dirty' : 'Clean';
}

function countPushed(value: number | string[] | undefined): number {
  if (Array.isArray(value)) return value.length;
  return value ?? 0;
}

function isProtectedBranch(branch: WorkBranch): boolean {
  return PROTECTED_BRANCHES.has(getBranchName(branch));
}

function getLastCommitDate(branch: WorkBranch): string | undefined {
  return (
    branch.last_commit?.date ||
    branch.last_commit?.time ||
    branch.last_commit_date ||
    branch.last_commit_time ||
    undefined
  );
}

function getBranchTimestamp(branch: WorkBranch): number {
  const value = getLastCommitDate(branch);
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

type BranchSortKey = 'recency' | 'name' | 'ahead';
type RepoSortKey = 'name' | 'activity';
type SortDirection = 'asc' | 'desc';
type CommitLoadState = {
  loading: boolean;
  error: string | null;
};

type AuditLoadState = {
  loading: boolean;
  error: string | null;
};

type AuditNotice = {
  kind: 'success' | 'error';
  text: string;
};

const WORK_COMMIT_LIMIT = 50;
const WORK_RESCAN_INTERVAL_MS = 60_000;

/** When a read was issued, and under which scan generation. */
type Freshness = { requestedAt: number; generation: number };

function isFresh(freshness: Freshness | undefined, generation: number, now: number): boolean {
  return freshness !== undefined
    && freshness.generation === generation
    && now - freshness.requestedAt < WORK_SCAN_SKIP_WINDOW_MS;
}

function sortBranches(branches: WorkBranch[], sortKey: BranchSortKey): WorkBranch[] {
  // Separate pinned (protected) from non-pinned
  const pinned: WorkBranch[] = [];
  const rest: WorkBranch[] = [];
  for (const branch of branches) {
    if (isProtectedBranch(branch)) {
      pinned.push(branch);
    } else {
      rest.push(branch);
    }
  }

  // Sort pinned by name (main before develop)
  pinned.sort((a, b) => getBranchName(a).localeCompare(getBranchName(b)));

  // Sort rest by the chosen key
  rest.sort((a, b) => {
    if (sortKey === 'name') {
      return getBranchName(a).localeCompare(getBranchName(b));
    }
    if (sortKey === 'ahead') {
      const aScore = (a.ahead_default ?? a.ahead ?? 0) + (a.behind_default ?? a.behind ?? 0);
      const bScore = (b.ahead_default ?? b.ahead ?? 0) + (b.behind_default ?? b.behind ?? 0);
      if (aScore !== bScore) {
        return bScore - aScore;
      }
    }
    const recencyDelta = getBranchTimestamp(b) - getBranchTimestamp(a);
    if (recencyDelta !== 0) {
      return recencyDelta;
    }
    return getBranchName(a).localeCompare(getBranchName(b));
  });

  return [...pinned, ...rest];
}

function getRepoActivity(branches: WorkBranch[]): number {
  return branches.reduce(
    (latest, branch) => Math.max(latest, getBranchTimestamp(branch)),
    0,
  );
}

function useDebounce(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value.trim()), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

function copyToClipboard(text: string): void {
  void navigator.clipboard.writeText(text);
}

function commitKey(repoId: string, branchName: string): string {
  return `${repoId}\u0000${branchName}`;
}

function parseCompare(value?: string): { from: string | null; to: string | null } {
  if (!value) {
    return { from: null, to: null };
  }
  const [from, to] = value.split('..');
  return {
    from: from || null,
    to: to || null,
  };
}

function classificationLabel(commit: WorkCommit): string {
  if (commit.classification === 'pre-branch-point') return 'inherited';
  if (commit.classification === 'merged-elsewhere') return 'merged elsewhere';
  return 'unique';
}

function updateWorkHash(params: Record<string, string | null | undefined>): void {
  if (typeof window === 'undefined') {
    return;
  }
  if (parseRouteFromHash(window.location.hash).tab !== 'work') return;
  replaceRouteHash(routeHashWithParams(window.location.hash, 'work', params));
}

// --- Context menu component ---

type MenuAction = {
  label: string;
  onClick: () => void;
  show?: boolean;
  disabled?: boolean;
  title?: string;
};

function BranchContextMenu({
  branch,
  anchorRef,
  instance,
}: {
  branch: WorkBranch;
  anchorRef: { current: HTMLElement | null };
  instance?: InstanceInfo | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuStyle = useAnchoredMenu({
    open,
    anchorRef,
    menuRef,
    focusRef: triggerRef,
    onDismiss: () => setOpen(false),
  });

  const branchName = getBranchName(branch);
  const wtPath = getWorktreePath(branch);
  const canOpenPath = Boolean(wtPath) && canPerformOperation(
    instance,
    'POST',
    '/api/system/open-path',
    { path: wtPath },
  );

  const actions: MenuAction[] = [
    {
      label: 'Copy branch name',
      onClick: () => {
        copyToClipboard(branchName);
        setOpen(false);
      },
    },
    {
      label: 'Copy path',
      show: wtPath !== null,
      onClick: () => {
        if (wtPath) copyToClipboard(wtPath);
        setOpen(false);
      },
    },
    {
      label: 'Open in Finder',
      show: wtPath !== null,
      disabled: !canOpenPath,
      title: canOpenPath ? 'Open in Finder' : 'External actions are unavailable in this instance.',
      onClick: () => {
        if (canOpenPath && wtPath) void openPath(wtPath);
        setOpen(false);
      },
    },
  ];

  const visibleActions = actions.filter((a) => a.show !== false);

  return (
    <span className={`work-actions contextual-action-group${open ? ' contextual-action-group--persistent' : ''}`} ref={anchorRef as any}>
      <ContextualAction
        ref={triggerRef}
        className="work-actions__trigger"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        title="Actions"
        aria-label="Branch actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        &hellip;
      </ContextualAction>
      {open ? (
        <div
          ref={menuRef}
          className="work-actions__menu app-anchored-menu"
          role="menu"
          popover="manual"
          style={menuStyle}
        >
          {visibleActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="work-actions__item"
              role="menuitem"
              disabled={action.disabled}
              title={action.title}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

// --- Single branch row (extracted so useRef is called at component level, not in flatMap) ---

type BranchRowProps = {
  branch: WorkBranch;
  repoId: string;
  defaultBranch: string;
  expanded: Set<string>;
  onToggle: (repoId: string, branchName: string) => void;
  instance?: InstanceInfo | null;
};

export function BranchRow({ branch, repoId, defaultBranch: _defaultBranch, expanded, onToggle, instance }: BranchRowProps): JSX.Element {
  const anchorRef = useRef<HTMLElement>(null);
  const branchName = getBranchName(branch);
  const status = getBranchStatus(branch);
  const statusLabel = formatBranchStatus(status);
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  const aheadDefault = branch.ahead_default ?? 0;
  const behindDefault = branch.behind_default ?? 0;
  const hasUpstream =
    typeof branch.has_upstream === 'boolean'
      ? branch.has_upstream
      : Boolean(branch.upstream);
  const upstreamName = branch.upstream ?? '';
  const upstreamTitle = upstreamName ? `Upstream: ${upstreamName}` : undefined;
  const lastMessage =
    branch.last_commit?.message || branch.last_commit_message || '—';
  const lastTime = getLastCommitDate(branch);
  const expandKey = `${repoId}:${branchName}`;
  const isExpanded = expanded.has(expandKey);
  const diffStat = branch.diff_stat;
  const isPinned = isProtectedBranch(branch);

  return (
    <>
      <tr key={expandKey} className={`contextual-action-owner${isPinned ? ' work-row--pinned' : ''}`}>
        <td className="work-col-status">
          <span className={`work-status-dot work-status-dot--${status}`} title={statusLabel} aria-label={statusLabel} />
        </td>
        <td>
          {diffStat ? (
            <button
              type="button"
              className="tree-toggle"
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} changes for ${branchName}`}
              aria-expanded={isExpanded}
              onClick={() => onToggle(repoId, branchName)}
            >
              <Icon name={isExpanded ? 'disclosureTextExpanded' : 'disclosureTextCollapsed'} />
            </button>
          ) : null}
          <span className="branch-name">{branchName}</span>
          {isPinned ? (
            <span className="work-badge-default" title="Protected branch">
              default
            </span>
          ) : null}
        </td>
        <td>
          {isPinned ? (
            <span className="text-muted">{'—'}</span>
          ) : aheadDefault === 0 && behindDefault === 0 ? (
            <span className="text-muted">even</span>
          ) : (
            <span className="ahead-behind">
              <span className="ahead"><Icon name="sortAscending" />{aheadDefault}</span>
              <span className="behind"><Icon name="sortDescending" />{behindDefault}</span>
            </span>
          )}
        </td>
        <td>
          {hasUpstream ? (
            <span className="ahead-behind" title={upstreamTitle}>
              {ahead > 0 && <span className="remote-ahead-badge" title="Ahead of remote"><Icon name="remoteAhead" />{ahead}</span>}
              {behind > 0 && <span className="remote-behind-badge" title="Behind remote"><Icon name="remoteBehind" />{behind}</span>}
              {ahead === 0 && behind === 0 && <span className="text-muted">even</span>}
            </span>
          ) : (
            <span className="no-upstream">no upstream</span>
          )}
        </td>
        <td>
          <div className="cell-stack">
            <span>{lastMessage}</span>
            <span className="branch-timestamp">{formatRelativeTime(lastTime, { empty: '\u2014' })}</span>
          </div>
        </td>
        <td className="work-col-actions contextual-action-scope">
          <BranchContextMenu branch={branch} anchorRef={anchorRef} instance={instance} />
        </td>
      </tr>
      {diffStat && isExpanded ? (
        <tr key={`${expandKey}:details`} className="diff-row">
          <td colSpan={6}>
            <pre className="diff-stat">{diffStat}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const AUDIT_GROUPS: Array<{
  title: string;
  classifications: WorkAuditEntry['classification'][];
}> = [
  { title: 'Safe candidates', classifications: ['safe_candidate'] },
  { title: 'Unique commits', classifications: ['unique_commits'] },
  { title: 'Dirty worktrees', classifications: ['dirty_worktree'] },
  { title: 'Protected, default, or current', classifications: ['protected', 'current'] },
  { title: 'Unknown or ambiguous', classifications: ['unknown'] },
  { title: 'App-managed or detached', classifications: ['app_managed'] },
];

function auditEntryKey(entry: WorkAuditEntry): string {
  return `${entry.kind}:${entry.branch ?? ''}:${entry.worktree_path ?? ''}`;
}

function auditEntryLabel(entry: WorkAuditEntry): string {
  return entry.branch || entry.worktree_path || 'Detached worktree';
}

function auditClassificationLabel(classification: WorkAuditEntry['classification']): string {
  return classification.replaceAll('_', ' ');
}

function trashOutcomeText(
  entry: WorkAuditEntry,
  outcome: TrashCreateOutcome | undefined,
  ok: boolean,
  error: string | undefined,
): AuditNotice {
  const branch = entry.branch || 'the branch';
  const path = outcome?.worktree_path || entry.worktree_path;
  if (!outcome) {
    return {
      kind: 'error',
      text: `Cleanup outcome is unknown${error ? `: ${error}.` : '.'} Refresh the audit before continuing.`,
    };
  }
  if (ok && outcome?.worktree_removed) {
    const branchText = outcome.branch_removed
      ? `Branch ref ${branch} and worktree ${path || 'at the reported path'} were removed`
      : `Worktree ${path || 'at the reported path'} was removed, but branch ref ${branch} remains`;
    return {
      kind: outcome.branch_removed ? 'success' : 'error',
      text: `${branchText} in reversible Mandible custody. Do not continue work in ${path || 'that worktree path'}.`,
    };
  }
  if (ok && outcome?.branch_removed) {
    return {
      kind: 'success',
      text: `Branch ref ${branch} was removed into reversible Mandible custody. No worktree was removed.`,
    };
  }
  const facts: string[] = [];
  if (outcome?.worktree_removed) {
    facts.push(`Worktree ${path || 'at the reported path'} was already removed; do not continue work there.`);
  } else {
    facts.push('No worktree was removed.');
  }
  if (outcome?.branch_removed) facts.push(`Branch ref ${branch} was already removed.`);
  else facts.push(`Branch ref ${branch} was not removed.`);
  return {
    kind: 'error',
    text: `Cleanup did not complete${error ? `: ${error}.` : '.'} ${facts.join(' ')}`,
  };
}

function BranchAuditPanel({
  repoTitle,
  audit,
  loadState,
  unavailableReason,
  capabilityReason,
  instance,
  open,
  confirmingKey,
  actingKey,
  notice,
  onToggle,
  onRefresh,
  onConfirm,
  onCancel,
  onTrash,
}: {
  repoTitle: string;
  audit: WorkRepoAudit | null;
  loadState: AuditLoadState;
  unavailableReason: string | null;
  capabilityReason: string;
  instance?: InstanceInfo | null;
  open: boolean;
  confirmingKey: string | null;
  actingKey: string | null;
  notice: AuditNotice | null;
  onToggle: () => void;
  onRefresh: () => void;
  onConfirm: (key: string) => void;
  onCancel: () => void;
  onTrash: (entry: WorkAuditEntry) => void;
}): JSX.Element {
  const entries = Array.isArray(audit?.entries) ? audit.entries : [];
  const activeNotice = unavailableReason
    ? { kind: 'info' as const, text: unavailableReason }
    : loadState.error
      ? { kind: 'error' as const, text: `Branch audit could not be refreshed: ${loadState.error}` }
      : notice;
  return (
    <CollapsiblePanel
      className="work-audit"
      headerClassName="work-audit__header"
      toggleClassName="work-audit__toggle"
      bodyClassName="work-audit__content"
      title={(
        <>
          <span>Branch audit</span>
          {audit ? <span className="work-audit__count">{entries.length}</span> : null}
        </>
      )}
      expanded={open}
      onExpandedChange={onToggle}
      actions={(
        <button
          type="button"
          className="btn btn--xs btn--ghost"
          disabled={loadState.loading || unavailableReason !== null}
          onClick={onRefresh}
          title={unavailableReason ?? 'Run a live Git branch audit'}
        >
          {loadState.loading ? 'Auditing\u2026' : 'Run audit'}
        </button>
      )}
      persistentContent={activeNotice ? (
        <DetailPaneNotice severity={activeNotice.kind === 'error' ? 'error' : 'info'} density="compact">
          {activeNotice.text}
        </DetailPaneNotice>
      ) : null}
    >
          <p className="work-audit__intro">
            Review one local branch at a time. Eligible branches move into reversible Mandible custody;
            remote branches are never deleted here.
          </p>
          {audit?.maintenance_issue_note ? (
            <p className="work-audit__maintenance-note">
              {audit.maintenance_issue_note}
              {audit.maintenance_issue_ref ? ` (${audit.maintenance_issue_ref})` : ''}
            </p>
          ) : null}
          {audit && !audit.worktree_inventory_known ? (
            <p className="work-audit-entry__disabled" role="status">
              Worktree inventory is unknown. Preserve all entries until a refresh succeeds.
            </p>
          ) : null}
          {unavailableReason ? null : loadState.loading && !audit ? (
            <div className="empty-state">Auditing {repoTitle}\u2026</div>
          ) : entries.length === 0 ? (
            <div className="empty-state">No local branch or worktree audit entries.</div>
          ) : (
            AUDIT_GROUPS.map((group) => {
              const groupEntries = entries.filter((entry) =>
                group.classifications.includes(entry.classification));
              if (groupEntries.length === 0) return null;
              return (
                <section className="work-audit-group" key={group.title}>
                  <h5>{group.title} <span>{groupEntries.length}</span></h5>
                  <div className="work-audit-group__entries">
                    {groupEntries.map((entry) => {
                      const key = auditEntryKey(entry);
                      const domId = `work-audit-${encodeURIComponent(key)}`;
                      const label = auditEntryLabel(entry);
                      const confirming = confirmingKey === key;
                      const entryEligible = Boolean(
                        entry.kind === 'branch' &&
                        entry.classification === 'safe_candidate' &&
                        entry.trash_request &&
                        entry.trash_command,
                      );
                      const actionEnabled = entryEligible && canPerformOperation(
                        instance,
                        'POST',
                        '/api/v1/trash',
                        entry.trash_request,
                      );
                      const disabledReason = !entryEligible
                        ? entry.reason || 'This entry must be preserved.'
                        : actionEnabled
                          ? null
                          : `Trash actions are ${capabilityReason.toLowerCase()}`;
                      return (
                        <article className="work-audit-entry" key={key}>
                          <div className="work-audit-entry__heading">
                            <div>
                              <h6>{label}</h6>
                              <span className="work-audit-entry__classification">
                                {entry.preserve_by_default ? 'Preserved' : 'Eligible'} ·{' '}
                                {auditClassificationLabel(entry.classification)}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="btn btn--xs btn--danger-outline"
                              disabled={!actionEnabled || actingKey !== null}
                              aria-describedby={!actionEnabled ? `${domId}-disabled-reason` : undefined}
                              onClick={() => onConfirm(key)}
                            >
                              Review trash action
                            </button>
                          </div>
                          <p className="work-audit-entry__reason">{entry.reason}</p>
                          <dl className="work-audit-entry__facts">
                            <div><dt>Proof</dt><dd>{entry.proof.kind}</dd></div>
                            <div><dt>Detail</dt><dd>{entry.proof.merged === null ? 'Merge status unknown' : entry.proof.merged ? `Merged into ${entry.proof.default_branch || 'default'}` : `Not merged into ${entry.proof.default_branch || 'default'}`}</dd></div>
                            <div><dt>Default</dt><dd>{entry.default_branch || 'unknown'}</dd></div>
                            <div><dt>Ahead / behind</dt><dd>{entry.ahead_default ?? 'unknown'} / {entry.behind_default ?? 'unknown'}</dd></div>
                            <div><dt>Dirty</dt><dd>{entry.status_known ? (entry.dirty ? 'yes' : 'no') : 'unknown'}</dd></div>
                            <div><dt>Project</dt><dd>{entry.ambiguous_project ? 'ambiguous' : entry.canonical_project ? entry.canonical_project_id || 'canonical' : 'unknown'}</dd></div>
                            <div><dt>Path</dt><dd><code>{entry.worktree_path || 'No worktree'}</code></dd></div>
                          </dl>
                          {entry.blockers.length > 0 ? (
                            <div className="work-audit-entry__blockers">
                              <strong>Blockers:</strong> {entry.blockers.join(', ')}
                            </div>
                          ) : null}
                          <div className="work-audit-entry__command">
                            <strong>Command:</strong> <code>{entry.trash_command || 'No cleanup command authorized'}</code>
                          </div>
                          {!actionEnabled ? (
                            <p id={`${domId}-disabled-reason`} className="work-audit-entry__disabled">
                              Action disabled: {disabledReason}
                            </p>
                          ) : null}
                          {confirming ? (
                            <div
                              className="work-audit-confirm"
                              role="dialog"
                              aria-modal="true"
                              aria-labelledby={`${domId}-confirm-title`}
                            >
                              <strong id={`${domId}-confirm-title`}>Move {entry.branch} into reversible custody?</strong>
                              <p>
                                Branch <code>{entry.branch}</code>
                                {entry.worktree_path ? <> and worktree <code>{entry.worktree_path}</code></> : ' has no worktree'}.
                                {' '}Mandible will preserve a recoverable snapshot before removing anything.
                              </p>
                              <div className="work-audit-confirm__actions">
                                <button
                                  type="button"
                                  className="btn btn--xs btn--danger"
                                  autoFocus
                                  disabled={actingKey !== null}
                                  onClick={() => onTrash(entry)}
                                >
                                  {actingKey === key ? 'Moving to trash\u2026' : `Confirm trash ${entry.branch}`}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--xs btn--ghost"
                                  disabled={actingKey !== null}
                                  onClick={onCancel}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
    </CollapsiblePanel>
  );
}

export function WorkOverviewView({
  repos: initialRepos,
  branchesByRepo,
  onRescan,
  instance,
  params = {},
}: WorkOverviewProps): JSX.Element {
  const sidebarHidden = isViewSidebarHidden({ tab: 'work', params });
  // The shared operation check stays closed until instance metadata is known.
  const capabilityReason = !instance
    ? 'Waiting for instance capabilities.'
    : instance?.role === 'preview'
      ? 'Unavailable in this copied preview.'
      : 'Unavailable in this instance.';
  const canRunScan = canPerformOperation(instance, 'POST', '/api/work/scan');
  const canPushAll = canPerformOperation(
    instance,
    'POST',
    '/api/work/push',
    { scope: 'all_ahead' },
  );
  const [repos, setRepos] = useState<WorkRepo[]>(initialRepos);
  const [repoLoadState, setRepoLoadState] = useState<"pending" | "ready" | "error">(initialRepos.length > 0 ? "ready" : "pending");
  const routeIdentity = JSON.stringify([params.repo, params.branch, params.commit, params.compare, params.mode]);
  const [appliedRoute, setAppliedRoute] = useState(routeIdentity);
  const routeChanged = appliedRoute !== routeIdentity;
  const [localRepoId, setSelectedRepoId] = useState<string | null>(params.repo ?? null);
  const selectedRepoId = routeChanged ? params.repo ?? null : localRepoId;
  const [localBranches, setSelectedBranches] = useState<Record<string, string>>(
    params.repo && params.branch ? { [params.repo]: params.branch } : {},
  );
  const selectedBranches = routeChanged && params.repo && params.branch
    ? { ...localBranches, [params.repo]: params.branch } : localBranches;
  const [localCommits, setSelectedCommits] = useState<Record<string, string>>({});
  const selectedCommits = routeChanged && params.repo && params.branch && params.commit
    ? { ...localCommits, [commitKey(params.repo, params.branch)]: params.commit } : localCommits;
  const [commitPages, setCommitPages] = useState<Record<string, WorkCommitPage>>({});
  const [commitLoadState, setCommitLoadState] = useState<Record<string, CommitLoadState>>({});
  const initialCompare = parseCompare(params.compare);
  const [localCompareFrom, setCompareFrom] = useState<string | null>(initialCompare.from);
  const [localCompareTo, setCompareTo] = useState<string | null>(initialCompare.to);
  const [localCompareMode, setCompareMode] = useState<WorkCompareMode>(
    params.mode === 'range' ? 'range' : 'merge-base',
  );
  const compareFrom = routeChanged ? initialCompare.from : localCompareFrom;
  const compareTo = routeChanged ? initialCompare.to : localCompareTo;
  const compareMode = routeChanged ? (params.mode === 'range' ? 'range' : 'merge-base') : localCompareMode;
  const [localCompareResult, setCompareResult] = useState<WorkCompareResult | null>(null);
  const [resolvedCompareKey, setResolvedCompareKey] = useState<string | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [audits, setAudits] = useState<Record<string, WorkRepoAudit>>({});
  const [auditLoadStates, setAuditLoadStates] = useState<Record<string, AuditLoadState>>({});
  const [auditOpenByRepo, setAuditOpenByRepo] = useState<Record<string, boolean>>({});
  const [auditConfirmingKey, setAuditConfirmingKey] = useState<string | null>(null);
  const [auditActingKey, setAuditActingKey] = useState<string | null>(null);
  const [auditNotices, setAuditNotices] = useState<Record<string, AuditNotice | null>>({});
  const auditRequestSequence = useRef<Record<string, number>>({});
  const auditFreshness = useRef<Record<string, Freshness>>({});
  const commitRequestSequence = useRef<Record<string, number>>({});
  const commitFreshness = useRef<Record<string, Freshness>>({});
  const viewActive = useViewActive();
  // Each work:scan:completed advances the generation; data read under an older one is stale.
  const [scanGeneration, setScanGeneration] = useState(0);
  const scanGenerationRef = useRef(scanGeneration);
  scanGenerationRef.current = scanGeneration;
  const onRescanRef = useRef(onRescan);
  onRescanRef.current = onRescan;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Outer-level filters
  const [repoFilterInput, setRepoFilterInput] = useState('');
  const [globalBranchFilterInput, setGlobalBranchFilterInput] = useState('');
  const repoFilter = useDebounce(repoFilterInput, 300).toLowerCase();
  const globalBranchFilter = useDebounce(globalBranchFilterInput, 300).toLowerCase();
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [repoSortKey, setRepoSortKey] = useState<RepoSortKey>('activity');
  const [repoSortDirection, setRepoSortDirection] = useState<SortDirection>('desc');

  // Per-project filters and sorts
  const [perRepoFilters, setPerRepoFilters] = useState<Record<string, string>>({});
  const [perRepoSorts, setPerRepoSorts] = useState<Record<string, BranchSortKey>>({});

  // Repo management state
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null);
  const [addingRepo, setAddingRepo] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editName, setEditName] = useState<Record<string, string>>({});

  // Bug: b5abaea — Push/sync state
  const [pushState, setPushState] = useState<PushState>({ active: false, authPending: false, repoProgress: new Map() });

  const canAddProject = canPerformOperation(
    instance,
    'POST',
    '/api/work/repos/add',
    { root: addPath },
  );

  // Sync repos when initialRepos changes (external updates)
  useEffect(() => {
    if (initialRepos.length === 0 && repos.length > 0) {
      void fetchRepos(showExcluded);
      return;
    }
    setRepos(initialRepos);
    if (initialRepos.length > 0) setRepoLoadState("ready");
  }, [initialRepos]);

  useEffect(() => {
    const nextCompare = parseCompare(params.compare);
    setAppliedRoute(routeIdentity);
    setSelectedRepoId(params.repo ?? null);
    if (params.repo && params.branch) {
      setSelectedBranches((prev) => ({ ...prev, [params.repo as string]: params.branch as string }));
    }
    if (params.repo && params.branch && params.commit) {
      setSelectedCommits((prev) => ({
        ...prev,
        [commitKey(params.repo as string, params.branch as string)]: params.commit as string,
      }));
    }
    setCompareFrom(nextCompare.from);
    setCompareTo(nextCompare.to);
    setCompareMode(params.mode === 'range' ? 'range' : 'merge-base');
  }, [routeIdentity]);

  // Fetch repos with/without excluded when showExcluded changes
  const fetchRepos = async (withExcluded: boolean) => {
    try {
      const url = withExcluded ? '/api/work/repos?include_excluded=true' : '/api/work/repos';
      const res = await browserSessionFetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { code?: string };
        setRepoLoadState(body.code === 'repo_discovery_pending' ? 'pending' : 'error');
        return;
      }
      const data = await res.json() as WorkRepo[];
      if (!Array.isArray(data)) throw new Error('Invalid project response');
      setRepos(data);
      setRepoLoadState('ready');
    } catch {
      setRepoLoadState('error');
    }
  };

  useEffect(() => {
    void fetchRepos(showExcluded);
  }, [showExcluded]);

  useEffect(() => {
    const advance = () => setScanGeneration((generation) => generation + 1);
    window.addEventListener('work:scan:completed', advance);
    return () => window.removeEventListener('work:scan:completed', advance);
  }, []);

  const reposGeneration = useRef(0);
  useEffect(() => {
    if (!viewActive || reposGeneration.current === scanGeneration) return;
    reposGeneration.current = scanGeneration;
    void fetchRepos(showExcluded);
  }, [viewActive, scanGeneration, showExcluded]);

  useEffect(() => {
    if (!viewActive || !canRunScan) return undefined;
    const interval = window.setInterval(() => { void onRescanRef.current(); }, WORK_RESCAN_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [viewActive, canRunScan]);

  // Bug: b5abaea — Subscribe to push SSE events forwarded via window CustomEvents
  useEffect(() => {
    const handler = (e: Event) => {
      const { type, data } = (e as CustomEvent).detail as { type: string; data: Record<string, unknown> };
      switch (type) {
        case 'push:started':
          setPushState(s => ({
            ...s,
            active: true,
            authPending: false,
            sessionId: data.session_id as string | undefined,
            repoCount: data.repo_count as number | undefined,
            completedCount: 0,
            repoProgress: new Map(),
            lastResult: null,
          }));
          break;
        case 'push:repo:progress':
          setPushState(s => {
            const m = new Map(s.repoProgress);
            m.set(data.repo_id as string, 'pushing');
            return { ...s, repoProgress: m };
          });
          break;
        case 'push:repo:complete':
          setPushState(s => {
            const m = new Map(s.repoProgress);
            m.set(data.repoId as string, data.error ? 'error' : 'done');
            return { ...s, completedCount: (s.completedCount ?? 0) + 1, repoProgress: m };
          });
          break;
        case 'push:complete':
          setPushState(s => ({
            ...s,
            active: false,
            authPending: false,
            lastResult: data as unknown as PushState['lastResult'],
          }));
          break;
        case 'push:error':
          setPushState(s => ({ ...s, active: false, authPending: false }));
          break;
        case 'push:auth:pending':
          setPushState(s => ({ ...s, authPending: true }));
          break;
        case 'push:auth:complete':
          setPushState(s => ({ ...s, authPending: false }));
          break;
      }
    };
    window.addEventListener('work:push', handler);
    return () => window.removeEventListener('work:push', handler);
  }, []);

  const allRepoRows = useMemo(() => {
    return repos
      .map((repo) => {
        const repoId = getRepoId(repo);
        const repoTitle = getRepoTitle(repo, repoId);
        return { repo, repoId, repoTitle };
      })
      .map(({ repo, repoId, repoTitle }) => {
        const branches = branchesByRepo[repoId] || [];
        const localFilter = (perRepoFilters[repoId] ?? '').trim().toLowerCase();
        const sortKey = perRepoSorts[repoId] ?? 'recency';

        const filtered = branches.filter((branch) => {
          const name = getBranchName(branch).toLowerCase();
          if (globalBranchFilter && !name.includes(globalBranchFilter)) return false;
          if (localFilter && !name.includes(localFilter)) return false;
          return true;
        });
        const sorted = sortBranches(filtered, sortKey);
        return {
          repo,
          repoId,
          repoTitle,
          branches: sorted,
          sortKey,
          activity: getRepoActivity(branches),
          totalBranches: branches.length,
        };
      })
      .sort((a, b) => {
        const direction = repoSortDirection === 'asc' ? 1 : -1;
        if (repoSortKey === 'name') {
          return direction * a.repoTitle.localeCompare(b.repoTitle);
        }
        const delta = a.activity - b.activity;
        if (delta !== 0) {
          return direction * delta;
        }
        return a.repoTitle.localeCompare(b.repoTitle);
      });
  }, [
    repos,
    branchesByRepo,
    globalBranchFilter,
    perRepoFilters,
    perRepoSorts,
    repoSortDirection,
    repoSortKey,
  ]);
  const repoRows = useMemo(() => allRepoRows.filter(({ repoTitle }) => !repoFilter || repoTitle.toLowerCase().includes(repoFilter)), [allRepoRows, repoFilter]);
  const explicitRepo = Boolean(params.repo && selectedRepoId === params.repo);

  useEffect(() => {
    if (explicitRepo || routeChanged) return;
    setSelectedRepoId((current) => {
      if (repoRows.length === 0) return repoLoadState === "ready" ? null : current;
      if (current && repoRows.some(row => row.repoId === current)) return current;
      return repoRows[0].repoId;
    });
  }, [repoRows, selectedRepoId, repoLoadState, explicitRepo, routeChanged]);

  const selectedRepo = (explicitRepo ? allRepoRows : repoRows).find((row) => row.repoId === selectedRepoId)
    ?? (explicitRepo ? null : repoRows[0]) ?? null;
  const explicitBranch = Boolean(explicitRepo && params.branch && selectedBranches[selectedRepoId!] === params.branch);
  const selectedBranchName = selectedRepo
    ? selectedBranches[selectedRepo.repoId] ?? getBranchName(selectedRepo.branches[0] ?? {})
    : '';
  const selectedBranch = selectedRepo
    ? (explicitBranch ? branchesByRepo[selectedRepo.repoId] ?? [] : selectedRepo.branches).find((branch) => getBranchName(branch) === selectedBranchName)
      ?? (explicitBranch ? null : selectedRepo.branches[0]) ?? null
    : null;
  const compareKey = JSON.stringify([selectedRepo?.repoId, compareFrom, compareTo, compareMode]);
  const compareResult = resolvedCompareKey === compareKey ? localCompareResult : null;

  const loadAudit = async (repoId: string, options: { refresh?: boolean } = {}) => {
    const sequence = (auditRequestSequence.current[repoId] ?? 0) + 1;
    auditRequestSequence.current[repoId] = sequence;
    if (!canPerformOperation(
      instance,
      'GET',
      `/api/work/repos/${encodeURIComponent(repoId)}/audit`,
    )) {
      setAuditLoadStates((prev) => ({ ...prev, [repoId]: { loading: false, error: null } }));
      return;
    }
    auditFreshness.current[repoId] = { requestedAt: Date.now(), generation: scanGenerationRef.current };
    setAuditLoadStates((prev) => ({ ...prev, [repoId]: { loading: true, error: null } }));
    try {
      const audit = await getWorkRepoAudit(repoId, options);
      if (auditRequestSequence.current[repoId] !== sequence) return;
      setAudits((prev) => ({ ...prev, [repoId]: audit }));
      setAuditLoadStates((prev) => ({ ...prev, [repoId]: { loading: false, error: null } }));
    } catch (error) {
      if (auditRequestSequence.current[repoId] !== sequence) return;
      delete auditFreshness.current[repoId];
      setAuditLoadStates((prev) => ({
        ...prev,
        [repoId]: {
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const canAuditSelectedRepo = selectedRepoId !== null && canPerformOperation(
    instance,
    'GET',
    `/api/work/repos/${encodeURIComponent(selectedRepoId)}/audit`,
  );
  useEffect(() => {
    if (!viewActive || !selectedRepoId) return;
    if (isFresh(auditFreshness.current[selectedRepoId], scanGeneration, Date.now())) return;
    void loadAudit(selectedRepoId);
  }, [viewActive, selectedRepoId, canAuditSelectedRepo, scanGeneration]);

  const handleTrashAuditEntry = async (repoId: string, entry: WorkAuditEntry) => {
    if (!entry.trash_request || !canPerformOperation(
      instance,
      'POST',
      '/api/v1/trash',
      entry.trash_request,
    )) return;
    const key = auditEntryKey(entry);
    setAuditActingKey(key);
    setAuditNotices((prev) => ({ ...prev, [repoId]: null }));
    try {
      const result = await createTrashEntry(entry.trash_request);
      const outcome = result.ok ? result.body.outcome : result.body.detail?.outcome;
      setAuditNotices((prev) => ({
        ...prev,
        [repoId]: trashOutcomeText(entry, outcome, result.ok, result.body.error),
      }));
      if (outcome) {
        if (result.ok) setAuditConfirmingKey(null);
        if (canRunScan) {
          try {
            await Promise.resolve(onRescan());
          } catch (error) {
            setAuditLoadStates((prev) => ({
              ...prev,
              [repoId]: {
                loading: false,
                error: `Branch data refresh failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            }));
            return;
          }
        }
        await loadAudit(repoId, { refresh: true });
      }
    } catch (error) {
      setAuditNotices((prev) => ({
        ...prev,
        [repoId]: trashOutcomeText(
          entry,
          undefined,
          false,
          error instanceof Error ? error.message : String(error),
        ),
      }));
    } finally {
      setAuditActingKey(null);
    }
  };

  useEffect(() => {
    if (!selectedRepo || explicitBranch || routeChanged) {
      return;
    }
    const current = selectedBranches[selectedRepo.repoId];
    if (current && selectedRepo.branches.some((branch) => getBranchName(branch) === current)) {
      return;
    }
    const fallback = getBranchName(selectedRepo.branches[0] ?? {});
    if (!fallback || fallback === '\u2014') {
      return;
    }
    setSelectedBranches((prev) => ({ ...prev, [selectedRepo.repoId]: fallback }));
    updateWorkHash({ repo: selectedRepo.repoId, branch: fallback });
  }, [selectedRepo, selectedBranches, explicitBranch, routeChanged]);

  const commitsRepoId = selectedRepo?.repoId ?? null;
  const commitsBranchName = selectedBranch ? getBranchName(selectedBranch) : null;
  const canReadSelectedCommits = commitsRepoId !== null && commitsBranchName !== null && canPerformOperation(
    instance,
    'GET',
    `/api/work/repos/${encodeURIComponent(commitsRepoId)}/branches/${encodeURIComponent(commitsBranchName)}/commits`,
  );
  useEffect(() => {
    if (!viewActive || !commitsRepoId || !commitsBranchName) {
      return;
    }
    const repoId = commitsRepoId;
    const branchName = commitsBranchName;
    const key = commitKey(repoId, branchName);
    if (!canReadSelectedCommits) {
      setCommitLoadState((prev) => ({ ...prev, [key]: { loading: false, error: null } }));
      return;
    }
    if (isFresh(commitFreshness.current[key], scanGeneration, Date.now())) return;
    const sequence = (commitRequestSequence.current[key] ?? 0) + 1;
    commitRequestSequence.current[key] = sequence;
    commitFreshness.current[key] = { requestedAt: Date.now(), generation: scanGeneration };
    setCommitLoadState((prev) => ({ ...prev, [key]: { loading: true, error: null } }));
    getRepoBranchCommits(repoId, branchName, { limit: WORK_COMMIT_LIMIT, offset: 0 })
      .then((page) => {
        if (commitRequestSequence.current[key] !== sequence) return;
        setCommitPages((prev) => ({ ...prev, [key]: page }));
        setCommitLoadState((prev) => ({ ...prev, [key]: { loading: false, error: null } }));
        setSelectedCommits((prev) => {
          const route = paramsRef.current;
          if (route.repo === repoId && route.branch === branchName && route.commit) return prev;
          const current = prev[key];
          if (current && page.commits.some((commit) => commit.hash === current)) {
            return prev;
          }
          const first = page.commits[0]?.hash;
          return first ? { ...prev, [key]: first } : prev;
        });
      })
      .catch((error) => {
        if (commitRequestSequence.current[key] !== sequence) return;
        delete commitFreshness.current[key];
        const message = error instanceof Error ? error.message : String(error);
        setCommitLoadState((prev) => ({ ...prev, [key]: { loading: false, error: message } }));
      });
  }, [viewActive, commitsRepoId, commitsBranchName, canReadSelectedCommits, scanGeneration]);

  const canCompareSelectedRepo = commitsRepoId !== null && canPerformOperation(
    instance,
    'GET',
    `/api/work/repos/${encodeURIComponent(commitsRepoId)}/compare`,
  );
  useEffect(() => {
    if (!selectedRepo || !compareFrom || !compareTo) {
      setCompareResult(null);
      setCompareError(null);
      setCompareLoading(false);
      return;
    }
    if (!canCompareSelectedRepo) {
      setCompareResult(null);
      setCompareError(null);
      setCompareLoading(false);
      return;
    }
    let cancelled = false;
    setCompareLoading(true);
    setCompareError(null);
    getWorkCompare(selectedRepo.repoId, { from: compareFrom, to: compareTo, mode: compareMode })
      .then((result) => {
        if (cancelled) return;
        setResolvedCompareKey(compareKey);
        setCompareResult(result);
        setCompareLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setCompareResult(null);
        setCompareLoading(false);
        setCompareError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepo?.repoId, compareFrom, compareTo, compareMode, canCompareSelectedRepo]);

  const repoTitleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { repoTitle } of repoRows) {
      counts.set(repoTitle, (counts.get(repoTitle) ?? 0) + 1);
    }
    return counts;
  }, [repoRows]);

  const handleUpdateRepo = async (id: string, patch: { name?: string; excluded?: boolean }) => {
    if (!canPerformOperation(
      instance,
      'PUT',
      `/api/work/repos/${encodeURIComponent(id)}`,
      patch,
    )) return;
    try {
      const res = await browserSessionFetch(`/api/work/repos/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = await res.json() as WorkRepo;
        setRepos((prev) => prev.map((r) => getRepoId(r) === id ? updated : r));
      }
    } catch {
      // ignore
    }
  };

  const handleRemoveRepo = async (id: string) => {
    if (!canPerformOperation(
      instance,
      'DELETE',
      `/api/work/repos/${encodeURIComponent(id)}`,
    )) return;
    try {
      const res = await browserSessionFetch(`/api/work/repos/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setRepos((prev) => prev.filter((r) => getRepoId(r) !== id));
        setConfirmRemove(null);
      }
    } catch {
      // ignore
    }
  };

  const handleAddRepo = async () => {
    if (!canAddProject) return;
    setAddError(null);
    try {
      const res = await browserSessionFetch('/api/work/repos/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: addPath }),
      });
      if (res.ok) {
        const newRepo = await res.json() as WorkRepo;
        setRepos((prev) => [...prev, newRepo]);
        setAddingRepo(false);
        setAddPath('');
      } else {
        const body = await res.json() as { error?: string };
        setAddError(body.error ?? `Error ${res.status}`);
      }
    } catch (e) {
      setAddError(String(e));
    }
  };

  const handlePushRepo = async (repoId: string, repoTitle: string) => {
    if (!canPerformOperation(
      instance,
      'POST',
      `/api/work/repos/${encodeURIComponent(repoId)}/push`,
      { scope: 'current' },
    )) return;
    setPushState((prev) => {
      const nextProgress = new Map(prev.repoProgress);
      nextProgress.set(repoId, 'pushing');
      return { ...prev, message: `Pushing ${repoTitle}...`, repoProgress: nextProgress };
    });
    try {
      const result = await pushRepo(repoId, 'current') as PushRepoResult;
      const branchCount = countPushed(result.branches_pushed);
      const refCount = countPushed(result.refs_pushed);
      const nextStatus = result.error ? 'error' : 'done';
      const message = result.error
        ? `Push failed for ${repoTitle}: ${result.error}`
        : result.skipped
          ? `Nothing to push for ${repoTitle}.`
          : refCount > 0
            ? `Pushed ${repoTitle}: ${branchCount} branch${branchCount === 1 ? '' : 'es'}, ${refCount} ref${refCount === 1 ? '' : 's'}.`
            : `Pushed ${repoTitle}.`;
      setPushState((prev) => {
        const nextProgress = new Map(prev.repoProgress);
        nextProgress.set(repoId, nextStatus);
        return { ...prev, message, repoProgress: nextProgress };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPushState((prev) => {
        const nextProgress = new Map(prev.repoProgress);
        nextProgress.set(repoId, 'error');
        return { ...prev, message: `Push failed for ${repoTitle}: ${message}`, repoProgress: nextProgress };
      });
    }
  };

  const hasActiveFilters = Boolean(globalBranchFilter || repoFilter);
  return (
    <div className="view work-view">
      {repoLoadState === 'error' ? (
        <DetailPaneNotice severity="error" source="work:projects" title="Projects could not be refreshed"
          actions={<button type="button" onClick={() => { void fetchRepos(showExcluded); }}>Retry</button>}
        >Could not load projects.</DetailPaneNotice>
      ) : null}
      {pushState.authPending && (
        <div className="work-auth-status" role="status" aria-live="polite">
          <span aria-hidden="true">!</span>
          <span>Please authenticate via your security key or check your SSH agent...</span>
        </div>
      )}
      {pushState.message && (
        <div className="work-push-message" role="status" aria-live="polite">
          {pushState.message}
        </div>
      )}
      <div className={`work-shell${sidebarHidden ? ' work-shell--sidebar-hidden' : ''}`}>
        <ViewSidebar
          hidden={sidebarHidden}
          storageKey="sidebar-width:work"
          defaultWidth={340}
          minWidth={280}
          ariaLabel="Projects"
          className="work-sidebar"
          bodyClassName="work-repo-list"
          header={<SidebarSearchFilterHeader
            value={repoFilterInput}
            onValueChange={setRepoFilterInput}
            placeholder="Search projects..."
            searchAriaLabel="Search projects"
            clearAriaLabel="Clear project search"
            filterTrigger={{
              ariaLabel: 'Advanced filters',
              title: 'Advanced filters',
              open: advancedFiltersOpen,
              onToggle: () => setAdvancedFiltersOpen((open) => !open),
            }}
            panel={advancedFiltersOpen ? {
              variant: 'inline',
              children: (
                <>
              <label className="work-filter-panel__field">
                <span>Branch filter</span>
                <input
                  type="search"
                  className="work-search"
                  placeholder="Any branch..."
                  value={globalBranchFilterInput}
                  onInput={(event) => setGlobalBranchFilterInput(event.currentTarget.value)}
                />
              </label>
              <label className="work-filter-panel__check">
                <input
                  type="checkbox"
                  checked={showExcluded}
                  onChange={(e) => setShowExcluded(e.currentTarget.checked)}
                />
                Show excluded
              </label>
              <div className="work-filter-panel__sort">
                <label>
                  <span>Sort</span>
                  <NativeSelect
                    className="work-sort"
                    value={repoSortKey}
                    onChange={(event) => setRepoSortKey(event.currentTarget.value as RepoSortKey)}
                  >
                    <option value="activity">Last activity</option>
                    <option value="name">A-Z</option>
                  </NativeSelect>
                </label>
                <button
                  type="button"
                  className="work-filter-panel__direction"
                  onClick={() => setRepoSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')}
                  title="Reverse sort direction"
                >
                  <Icon name={repoSortDirection === 'asc' ? 'sortAscending' : 'sortDescending'} />
                </button>
              </div>
                </>
              ),
            } : undefined}
          />}
          footer={(
            <>
              {addingRepo ? (
                <div className="repo-add-form">
                  <input
                    type="text"
                    className="repo-add-form__input"
                    placeholder="Absolute path to Git project..."
                    aria-label="Project path"
                    value={addPath}
                    onInput={(e) => setAddPath(e.currentTarget.value)}
                  />
                  <div className="repo-add-form__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={!canAddProject}
                      title={!canAddProject ? capabilityReason : undefined}
                      onClick={() => void handleAddRepo()}
                    >
                      Add project
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => { setAddingRepo(false); setAddPath(''); setAddError(null); }}
                    >
                      Cancel
                    </button>
                  </div>
                  {addError ? (
                    <DetailPaneNotice severity="error" density="compact" title="Could not add project">{addError}</DetailPaneNotice>
                  ) : null}
                </div>
              ) : null}
              <div className="work-sidebar__footer">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={!canAddProject}
                  title={!canAddProject ? capabilityReason : undefined}
                  onClick={() => { setAddingRepo((v) => !v); setAddError(null); }}
                >
                  <Icon name="add" /> Add project
                </button>
                <button
                  type="button"
                  className={`btn btn--ghost btn--sm${(pushState.active || pushState.authPending) ? ' btn--disabled' : ''}`}
                  disabled={pushState.active || pushState.authPending || !canPushAll}
                  onClick={() => {
                    if (canPushAll) void pushRepos('all_ahead').catch(() => {});
                  }}
                  title={!canPushAll ? capabilityReason : 'Push all ahead branches + notes for all projects'}
                >
                  {pushState.authPending
                    ? 'Authenticating...'
                    : pushState.active
                      ? `Pushing... (${pushState.completedCount ?? 0}/${pushState.repoCount ?? '?'})`
                      : <><Icon name="pushAll" /> Push All</>}
                </button>
                {instance && (!canAddProject || !canPushAll) ? (
                  <span className="work-sidebar__capability-note" role="status">
                    Some project actions are {capabilityReason.toLowerCase()}
                  </span>
                ) : null}
              </div>
            </>
          )}
        >
          <div role="list">
            {repoRows.length === 0 ? (
              repoLoadState === 'ready' ? <div className="empty-state">
                {hasActiveFilters
                  ? 'No projects match these filters.'
                  : 'No projects found. Register a session or add a project.'}
              </div> : null
            ) : (
              repoRows.map(({ repo, repoId, repoTitle, branches, activity, totalBranches }) => {
                const repoPath = getRepoPath(repo);
                const isExcluded = Boolean(repo.excluded);
                const selected = selectedRepo?.repoId === repoId;
                const activityLabel = activity
                  ? formatRelativeTime(new Date(activity).toISOString(), { empty: '\u2014' })
                  : '\u2014';
                const branchLabel = `${totalBranches} ${totalBranches === 1 ? 'branch' : 'branches'}`;
                const selectionDescription = [repoPath, branchLabel, `Last activity ${activityLabel}`]
                  .filter(Boolean)
                  .join('. ');
                return (
                  <div key={repoId} role="listitem">
                    <SidebarItemRow
                      label={repoTitle}
                      selectionLabel={`Select project ${repoTitle}`}
                      selectionDescription={selectionDescription}
                      selected={selected}
                      ariaCurrent={selected ? 'true' : undefined}
                      className={isExcluded ? 'work-project-row--excluded' : undefined}
                      onSelect={() => {
                        const branchName = selectedBranches[repoId] ?? getBranchName(branches[0] ?? {});
                        setSelectedRepoId(repoId);
                        updateWorkHash({
                          repo: repoId,
                          branch: branchName && branchName !== '\u2014' ? branchName : null,
                          commit: null,
                          compare: null,
                        });
                      }}
                      badges={(
                        <>
                          {isExcluded ? (
                            <SidebarItemBadge title="Excluded from scans">excluded</SidebarItemBadge>
                          ) : null}
                          <SidebarItemBadge title={branchLabel} ariaLabel={branchLabel}>
                            {totalBranches}
                          </SidebarItemBadge>
                          <SidebarItemBadge title={`Last activity ${activityLabel}`} ariaLabel={`Last activity ${activityLabel}`}>
                            {activityLabel}
                          </SidebarItemBadge>
                        </>
                      )}
                    />
                  </div>
                );
              })
            )}
          </div>
        </ViewSidebar>
        <section className="work-detail" data-app-surface="main" aria-label="Repository details">
          {selectedRepo === null ? (
            <div className="empty-state">{explicitRepo ? `Project unavailable: ${selectedRepoId}` : repoLoadState === "ready" ? "No projects in this view." : "Select a project when it becomes available."}</div>
          ) : (() => {
            const { repo, repoId, repoTitle, branches, sortKey } = selectedRepo;
            const repoPath = getRepoPath(repo);
            const showPath = repoPath && (repoTitleCounts.get(repoTitle) ?? 0) > 1;
            const defaultBranch =
              repo.default_branch ||
              branches.find((b) => b.default_branch && b.default_branch !== '—')
                ?.default_branch ||
              'main';
            const isExcluded = Boolean(repo.excluded);
            const isSettingsOpen = settingsOpenFor === repoId;
            const currentEditName = editName[repoId] ?? repo.name ?? repoTitle;
            const repoOperationPath = `/api/work/repos/${encodeURIComponent(repoId)}`;
            const canUpdateMetadata = (patch: { name?: string; excluded?: boolean }) =>
              canPerformOperation(instance, 'PUT', repoOperationPath, patch);
            const canRemoveProject = canPerformOperation(instance, 'DELETE', repoOperationPath);
            const canPushProject = canPerformOperation(
              instance,
              'POST',
              `${repoOperationPath}/push`,
              { scope: 'current' },
            );
            const canRunAudit = canPerformOperation(instance, 'GET', `${repoOperationPath}/audit`);
            const canCompare = canPerformOperation(instance, 'GET', `${repoOperationPath}/compare`);

            return (
              <DetailPaneShell
                key={repoId}
                as="div"
                variant="compact"
                headerPlacement="frame"
                className={`work-detail-panel${isExcluded ? ' repo-card--excluded' : ''}`}
                bodyClassName="work-detail__body"
                header={(
                  <DetailPaneHeader
                    variant="compact"
                    title={repoTitle}
                    titleTooltip={repoTitle}
                    menuLabel="Repository settings"
                    menu={(
                      <button
                        type="button"
                        className={`repo-card__gear${isSettingsOpen ? ' repo-card__gear--active' : ''}`}
                        title="Repo settings"
                        aria-label="Repo settings"
                        onClick={() => {
                          setSettingsOpenFor((prev) => prev === repoId ? null : repoId);
                        }}
                      >
                        <Icon name="workSettings" />
                        </button>
                    )}
                    metadata={(
                      <div className="repo-card__header-actions">
                        {showPath ? <span className="text-muted">{repoPath}</span> : null}
                        {isExcluded && (
                          <span className="work-badge-excluded" title="Excluded from scans">excluded</span>
                        )}
                        {pushState.repoProgress.get(repoId) === 'pushing' && (
                          <span className="work-push-spinner" aria-label="Pushing" />
                        )}
                        {pushState.repoProgress.get(repoId) === 'done' && (
                          <span className="work-push-done" title="Push complete"><Icon name="pushCompleted" label="Push complete" /></span>
                        )}
                        {pushState.repoProgress.get(repoId) === 'error' && (
                          <span className="work-push-error" title="Push failed"><Icon name="pushFailed" label="Push failed" /></span>
                        )}
                        <button
                          type="button"
                          className="work-repo-push-btn"
                    disabled={pushState.active || pushState.repoProgress.get(repoId) === 'pushing' || !canPushProject}
                          onClick={() => void handlePushRepo(repoId, repoTitle)}
                          title={!canPushProject ? capabilityReason : 'Push this repo'}
                        >
                          <span className="work-repo-push-btn__label">
                            {pushState.repoProgress.get(repoId) === 'pushing' ? 'Pushing...' : <><Icon name="push" /> Push</>}
                          </span>
                        </button>
                        {isExcluded && (
                          <button
                            type="button"
                            className="btn btn--xs"
                            disabled={!canUpdateMetadata({ excluded: false })}
                            onClick={() => {
                              void handleUpdateRepo(repoId, { excluded: false });
                            }}
                            title="Include this repo in scans"
                          >
                            Include
                          </button>
                        )}
                      </div>
                    )}
                  />
                )}
                overlays={isSettingsOpen ? (
                  <div className="work-settings-overlay" role="dialog" aria-modal="true" aria-labelledby="work-repo-settings-title">
                    <div className="work-settings-modal">
                      <div className="work-settings-modal__header">
                        <h4 id="work-repo-settings-title">Repo settings</h4>
                        <button
                          type="button"
                          className="work-settings-modal__close"
                          aria-label="Close repo settings"
                          onClick={() => setSettingsOpenFor(null)}
                        >
                          <Icon name="dismiss" />
                          </button>
                      </div>
                      <div className="repo-settings-strip">
                        <div className="repo-settings-strip__row">
                          <label className="repo-settings-strip__label">Name</label>
                          <input
                            type="text"
                            className="repo-settings-strip__input"
                            aria-label="Name"
                            value={currentEditName}
                            onInput={(e) =>
                              setEditName((prev) => ({ ...prev, [repoId]: e.currentTarget.value }))
                            }
                          />
                          <button
                            type="button"
                            className="btn btn--xs"
                            disabled={!canUpdateMetadata({ name: currentEditName })}
                            onClick={() => void handleUpdateRepo(repoId, { name: currentEditName }).then(() =>
                              setEditName((prev) => { const next = { ...prev }; delete next[repoId]; return next; })
                            )}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            disabled={!canUpdateMetadata({ name: '' })}
                            onClick={() => void handleUpdateRepo(repoId, { name: '' }).then(() =>
                              setEditName((prev) => { const next = { ...prev }; delete next[repoId]; return next; })
                            )}
                            title="Reset to derived name"
                          >
                            Reset
                          </button>
                        </div>
                        <div className="repo-settings-strip__row">
                          <label className="repo-settings-strip__label">
                            <input
                              type="checkbox"
                              checked={isExcluded}
                              disabled={!canUpdateMetadata({ excluded: !isExcluded })}
                              onChange={(e) => void handleUpdateRepo(repoId, { excluded: e.currentTarget.checked })}
                              style={{ marginRight: '4px' }}
                            />
                            Exclude from scans
                          </label>
                        </div>
                        <div className="repo-settings-strip__row">
                          {confirmRemove === repoId ? (
                            <>
                              <span className="text-muted" style={{ fontSize: '0.85em' }}>Remove this repo from Mandible?</span>
                              <button
                                type="button"
                                className="btn btn--xs btn--danger"
                                disabled={!canRemoveProject}
                                title={!canRemoveProject ? capabilityReason : undefined}
                                onClick={() => void handleRemoveRepo(repoId)}
                              >
                                Confirm remove
                              </button>
                              <button
                                type="button"
                                className="btn btn--xs btn--ghost"
                                onClick={() => setConfirmRemove(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--xs btn--danger-outline"
                              disabled={!canRemoveProject}
                              title={!canRemoveProject ? capabilityReason : undefined}
                              onClick={() => setConfirmRemove(repoId)}
                            >
                              Remove repo
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : undefined}
              >
                  <BranchAuditPanel
                    repoTitle={repoTitle}
                    audit={canRunAudit ? audits[repoId] ?? null : null}
                    loadState={auditLoadStates[repoId] ?? { loading: false, error: null }}
                    unavailableReason={canRunAudit ? null : `Live branch audit is ${capabilityReason.toLowerCase()}`}
                    capabilityReason={capabilityReason}
                    instance={instance}
                    open={auditOpenByRepo[repoId] !== false}
                    confirmingKey={auditConfirmingKey}
                    actingKey={auditActingKey}
                    notice={auditNotices[repoId] ?? null}
                    onToggle={() => setAuditOpenByRepo((prev) => ({
                      ...prev,
                      [repoId]: prev[repoId] === false,
                    }))}
                    onRefresh={() => void loadAudit(repoId, { refresh: true })}
                    onConfirm={setAuditConfirmingKey}
                    onCancel={() => setAuditConfirmingKey(null)}
                    onTrash={(entry) => void handleTrashAuditEntry(repoId, entry)}
                  />
                  <div className="work-detail__controls">
                    <input
                      type="search"
                      className="repo-card__filter"
                      placeholder="Filter branches..."
                      value={perRepoFilters[repoId] ?? ''}
                      onInput={(event) =>
                        setPerRepoFilters((prev) => ({
                          ...prev,
                          [repoId]: event.currentTarget.value,
                        }))
                      }
                    />
                    <NativeSelect
                      className="repo-card__sort"
                      value={sortKey}
                      onChange={(event) =>
                        setPerRepoSorts((prev) => ({
                          ...prev,
                          [repoId]: event.currentTarget.value as BranchSortKey,
                        }))
                      }
                    >
                      <option value="recency">Recent activity</option>
                      <option value="name">Branch name</option>
                      <option value="ahead">Ahead/behind</option>
                    </NativeSelect>
                  </div>
                  {(() => {
                    const activeBranch = selectedBranch;
                    const branchName = activeBranch ? getBranchName(activeBranch) : '';
                    const commitsKey = branchName ? commitKey(repoId, branchName) : '';
                    const commitPage = commitsKey ? commitPages[commitsKey] : undefined;
                    const loadState = commitsKey ? commitLoadState[commitsKey] : undefined;
                    const selectedCommitHash = commitsKey ? selectedCommits[commitsKey] : undefined;
                    const selectedCommit =
                      commitPage?.commits.find((commit) => commit.hash === selectedCommitHash) ??
                      (explicitBranch && params.commit && selectedCommitHash === params.commit ? null : commitPage?.commits[0]) ??
                      null;
                                  const compareValue = compareFrom ? `${compareFrom}..${compareTo ?? ''}` : null;
                                  const canReadCommits = Boolean(branchName) && canPerformOperation(
                                      instance,
                                      'GET',
                                      `${repoOperationPath}/branches/${encodeURIComponent(branchName)}/commits`,
                                    );

                                    const writeCompare = (from: string | null, to: string | null, mode: WorkCompareMode = compareMode) => {
                                      if (!canCompare && (from !== null || to !== null)) return;
                      setCompareFrom(from);
                      setCompareTo(to);
                      setCompareMode(mode);
                      updateWorkHash({
                        repo: repoId,
                        branch: branchName || null,
                        compare: from ? `${from}..${to ?? ''}` : null,
                        mode: from ? mode : null,
                      });
                    };

                    const selectBranch = (nextBranchName: string) => {
                      setSelectedBranches((prev) => ({ ...prev, [repoId]: nextBranchName }));
                      updateWorkHash({ repo: repoId, branch: nextBranchName, commit: null });
                    };

                    const selectCommit = (commit: WorkCommit) => {
                      setSelectedCommits((prev) => ({
                        ...prev,
                        [commitKey(repoId, branchName)]: commit.hash,
                      }));
                      updateWorkHash({ repo: repoId, branch: branchName, commit: commit.hash });
                    };

                    const addCommitToCompare = (commit: WorkCommit) => {
                      if (!compareFrom || (compareFrom && compareTo)) {
                        writeCompare(commit.hash, null);
                        return;
                      }
                      if (compareFrom !== commit.hash) {
                        writeCompare(compareFrom, commit.hash);
                      }
                    };

                    return (
                      <div className="work-project-browser">
                        <aside className="work-branch-browser" aria-label="Branches">
                          {branches.length === 0 ? (
                            <div className="empty-state">
                              {hasActiveFilters || perRepoFilters[repoId]
                                ? 'No branches match this filter.'
                                : 'No branches reported yet.'}
                            </div>
                          ) : (
                            branches.map((branch) => {
                              const name = getBranchName(branch);
                              const selected = name === branchName;
                              const status = getBranchStatus(branch);
                              return (
                                <button
                                  key={`${repoId}:branch:${name}`}
                                  type="button"
                                  className={`work-branch-button${selected ? ' work-branch-button--active' : ''}`}
                                  onClick={() => selectBranch(name)}
                                >
                                  <span className={`work-status-dot work-status-dot--${status}`} aria-hidden="true" />
                                  <span className="work-branch-button__main">
                                    <span className="work-branch-button__name">{name}</span>
                                    <span className="work-branch-button__meta">
                                      {isProtectedBranch(branch) ? 'protected' : `+${branch.ahead_default ?? 0} / -${branch.behind_default ?? 0}`}
                                      {isDirty(branch) ? ' dirty' : ''}
                                    </span>
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </aside>
                        <section className="work-commit-browser" aria-label="Commits">
                          {activeBranch ? (
                            <>
                              <div className="work-commit-toolbar">
                                <div>
                                  <h4>{branchName}</h4>
                                  <span className="text-muted">
                                    {!canReadCommits
                                      ? capabilityReason
                                      : commitPage
                                        ? `${commitPage.total} commits`
                                      : loadState?.loading
                                        ? 'Loading commits'
                                        : 'No commit history loaded'}
                                  </span>
                                </div>
                                <div className="work-commit-toolbar__actions">
                                  <button
                                    type="button"
                                    className="btn btn--xs"
                                    disabled={!canCompare}
                                    title={!canCompare ? capabilityReason : undefined}
                                    onClick={() => writeCompare(defaultBranch as string, branchName, 'merge-base')}
                                  >
                                    Branch point
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--xs btn--ghost"
                                    disabled={!canCompare}
                                    title={!canCompare ? capabilityReason : undefined}
                                    onClick={() => writeCompare(defaultBranch as string, branchName, 'range')}
                                  >
                                    vs {defaultBranch}
                                  </button>
                                </div>
                              </div>
                              <div className="work-compare-tray" aria-label="Compare tray">
                                <div className="work-compare-tray__endpoints">
                                  <span>{compareFrom ? compareFrom.slice(0, 12) : 'Select first commit'}</span>
                                  <span aria-hidden="true">..</span>
                                  <span>{compareTo ? compareTo.slice(0, 12) : 'Select second commit'}</span>
                                </div>
                                <div className="work-compare-tray__actions">
                                  <NativeSelect
                                    className="work-compare-tray__mode"
                                    value={compareMode}
                                    disabled={!canCompare}
                                    title={!canCompare ? capabilityReason : undefined}
                                    onChange={(event) => writeCompare(compareFrom, compareTo, event.currentTarget.value as WorkCompareMode)}
                                  >
                                    <option value="merge-base">Merge base</option>
                                    <option value="range">Range</option>
                                  </NativeSelect>
                                  <button
                                    type="button"
                                    className="btn btn--xs btn--ghost"
                                    disabled={!canCompare || !compareFrom || !compareTo}
                                    title={!canCompare ? capabilityReason : undefined}
                                    onClick={() => writeCompare(compareTo, compareFrom)}
                                  >
                                    Swap
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--xs btn--ghost"
                                    disabled={!compareValue}
                                    onClick={() => writeCompare(null, null)}
                                  >
                                    Clear
                                  </button>
                                </div>
                              </div>
                              {!canReadCommits ? (
                                <div className="empty-state" role="status">
                                  Commit history is {capabilityReason.toLowerCase()}
                                </div>
                              ) : loadState?.error ? (
                                <div className="empty-state">{loadState.error}</div>
                              ) : loadState?.loading && !commitPage ? (
                                <div className="empty-state">Loading commits...</div>
                              ) : (
                                <div className="work-commit-layout">
                                  <div className="work-commit-list" role="list" aria-label={`${branchName} commits`}>
                                    {(commitPage?.commits ?? []).map((commit) => {
                                      const selected = selectedCommit?.hash === commit.hash;
                                      return (
                                        <button
                                          key={commit.hash}
                                          type="button"
                                          className={`work-commit-row work-commit-row--${commit.classification}${selected ? ' work-commit-row--active' : ''}`}
                                          onClick={() => selectCommit(commit)}
                                        >
                                          <span className="work-commit-row__marker" aria-hidden="true" />
                                          <span className="work-commit-row__main">
                                            <span className="work-commit-row__message">{commit.message || commit.short_hash}</span>
                                            <span className="work-commit-row__meta">
                                              {commit.short_hash} · {commit.author} · {formatRelativeTime(commit.date, { empty: '\u2014' })}
                                            </span>
                                          </span>
                                          <span className="work-commit-row__class">{classificationLabel(commit)}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <div className="work-commit-detail">
                                    {selectedCommit ? (
                                      <>
                                        <div className="work-commit-detail__header">
                                          <div>
                                            <h4>{selectedCommit.message || selectedCommit.short_hash}</h4>
                                            <span className="text-muted">
                                              {selectedCommit.hash} · {selectedCommit.author} · {selectedCommit.date}
                                            </span>
                                          </div>
                                          <div className="work-commit-detail__actions">
                                            <button
                                              type="button"
                                              className="btn btn--xs"
                                              disabled={!canCompare}
                                              title={!canCompare ? capabilityReason : undefined}
                                              onClick={() => addCommitToCompare(selectedCommit)}
                                            >
                                              Add to compare
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn--xs btn--ghost"
                                              disabled={!canCompare || selectedCommit.parents.length === 0}
                                              title={!canCompare ? capabilityReason : undefined}
                                              onClick={() => {
                                                const parent = selectedCommit.parents[0];
                                                if (parent) writeCompare(parent, selectedCommit.hash, 'range');
                                              }}
                                            >
                                              Diff parent
                                            </button>
                                          </div>
                                        </div>
                                        <dl className="work-commit-detail__facts">
                                          <div>
                                            <dt>Class</dt>
                                            <dd>{classificationLabel(selectedCommit)}</dd>
                                          </div>
                                          <div>
                                            <dt>Parents</dt>
                                            <dd>{selectedCommit.parents.length || 0}</dd>
                                          </div>
                                        </dl>
                                      </>
                                    ) : (
                                      <div className="empty-state">Select a commit.</div>
                                    )}
                                  </div>
                                </div>
                              )}
                              <section className="work-compare-output" aria-label="Compare result">
                                <div className="work-compare-output__header">
                                  <h4>Compare</h4>
                                  {canCompare && compareResult ? <span className="text-muted">{compareResult.range}</span> : null}
                                </div>
                                {!canCompare && compareFrom && compareTo ? (
                                  <div className="empty-state" role="status">
                                    Compare results are {capabilityReason.toLowerCase()}
                                  </div>
                                ) : compareLoading ? (
                                  <div className="empty-state">Loading diff...</div>
                                ) : compareError ? (
                                  <div className="empty-state">{compareError}</div>
                                ) : compareResult ? (
                                  <>
                                    {compareResult.stat ? <pre className="work-compare-stat">{compareResult.stat}</pre> : null}
                                    <DiffView
                                      diffText={compareResult.raw}
                                      ariaLabel="Projects compare diff"
                                      emptyMessage="No diff for this comparison."
                                      initialMode="split"
                                    />
                                  </>
                                ) : (
                                  <div className="empty-state">Select two commits or a branch compare action.</div>
                                )}
                              </section>
                            </>
                          ) : (
                            <div className="empty-state">{explicitBranch ? `Branch unavailable: ${params.branch}` : 'Select a branch to browse commits.'}</div>
                          )}
                        </section>
                      </div>
                    );
                  })()}
              </DetailPaneShell>
            );
          })()}
        </section>
      </div>
    </div>
  );
}
