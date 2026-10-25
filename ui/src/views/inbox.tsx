// Inbox tab — sidebar+detail panel layout with chip filters and unified item list.
// Bug: 4fa87d9 — inbox sidebar redesign

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ViewSidebar } from '../components/ViewSidebar';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { AppOperationalNoticeOutlet } from '../app-shell';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { IssuePill } from '../components/shared/IssuePill';
import { canPerformOperation, spawnIssueAgent, type InstanceInfo } from '../api';
import { formatRelativeTime } from '../lib/format';
import { renderInlineMarkdown } from '../lib/markdown';
import { appColors } from '../theme';

const INBOX_TONES = {
  continuation: {
    fg: appColors.inboxContinuation,
    bg: appColors.inboxContinuationBg,
  },
  handoff: {
    fg: appColors.inboxHandoff,
    bg: appColors.inboxHandoffBg,
  },
  issue: {
    fg: appColors.inboxIssue,
    bg: appColors.inboxIssueBg,
  },
  authCompleted: {
    fg: appColors.authResultCompleted,
    bg: appColors.authResultCompletedBg,
  },
  authProblem: {
    fg: appColors.authResultProblem,
    bg: appColors.authResultProblemBg,
  },
  authNeutral: {
    fg: appColors.authResultNeutral,
    bg: appColors.authResultNeutralBg,
  },
  // Issue 71a287e — a leaked credential is the highest-severity inbox item.
  credentialLeak: {
    fg: appColors.authResultProblem,
    bg: appColors.authResultProblemBg,
  },
  reminder: {
    fg: appColors.inboxHandoff,
    bg: appColors.inboxHandoffBg,
  },
} as const;

export interface InboxContinuation {
  session_id: string;
  continuation: string;
  branch: string | null;
  ended_at: string | null;
  repo?: string | null;
}

export interface InboxAuthResult {
  id: string;
  title: string;
  status: 'completed' | 'failed' | 'rejected' | 'withdrawn' | 'superseded' | 'expired' | 'dismissed' | 'needs_rebase';
  exit_code: number | null;
  error: string | null;
  head_branch: string | null;
  resolved_at: number | null;
  repo?: string | null;
  base_branch?: string | null;
}

export interface InboxIssue {
  id: string;
  title: string;
  labels: string[];
  repo_id?: string;
  repo_name?: string;
}

// Issue 71a287e — pending webhook events. Credential-leak alerts ride this
// existing queue rather than introducing a parallel alert subsystem.
export interface InboxWebhookEvent {
  id: string;
  source: string;
  event_type: string;
  title: string | null;
  priority: string;
  target_branch: string | null;
  target_issue: string | null;
  created_at: number;
  data?: CredentialLeakEventData | Record<string, unknown> | null;
}

export interface InboxManagedReminderOccurrence {
  id: string;
  task_id: string;
  revision_id: string;
  message: string;
  project_id: string;
  project_key: string;
  predicate: Record<string, unknown> & { kind: string };
  payload_digest: string;
  created_by_user_id: string;
  fired_by_user_id: string;
  triggering_evidence: Record<string, unknown> & { kind?: string };
  created_at: number;
}

export interface CredentialLeakEventData {
  credential_id?: string;
  credential_label?: string | null;
  user_slug?: string | null;
  session_scoped?: boolean;
  auto_revoked?: boolean;
  conversation_id?: string | null;
  conversation_title?: string | null;
  session_id?: string | null;
  provider?: string | null;
  block_position?: number | null;
  remediation?: { mint?: string; revoke?: string } | null;
}

export const CREDENTIAL_LEAK_EVENT_TYPE = 'credential_leak';

export interface InboxData {
  continuations: InboxContinuation[];
  auth_results: InboxAuthResult[];
  open_issues: InboxIssue[];
  // Bug: 8a281b3 — work units needing attention and work-unit continuations
  work_units?: import('../api').WorkUnitWithLiveness[];
  work_unit_continuations?: import('../api').WorkUnitWithLiveness[];
  // Issue 71a287e — pending webhook events (credential-leak alerts and others)
  pending_webhooks?: InboxWebhookEvent[];
  managed_reminder_occurrences?: InboxManagedReminderOccurrence[];
  total: number;
}

export interface InboxViewProps {
  data: InboxData | null;
  loading: boolean;
  selectedItemId?: string | null;
  sidebarHidden?: boolean;
  onSelectItem?: (id: string | null) => void;
  onAckContinuation: (sessionId: string) => Promise<void>;
  onAckAuthResult: (requestId: string) => Promise<void>;
  onAckManagedReminderOccurrence: (occurrenceId: string) => Promise<void>;
  onAckAll: () => Promise<void>;
  onRefresh: () => void;
  instance?: InstanceInfo | null;
  error?: string | null;
}

// ── Types for unified item list ──

// Bug: cbbb3d9 — added 'work_unit_continuation' type for work-unit handoff notes
// Issue 71a287e — added 'credential_leak' for leaked-credential alerts
type ItemType = 'continuation' | 'auth_result' | 'issue' | 'work_unit_continuation' | 'credential_leak' | 'managed_reminder_occurrence';

interface UnifiedItem {
  id: string;
  type: ItemType;
  title: string;
  repo: string | null;
  branch: string | null;
  time: number | null;
  raw: InboxContinuation | InboxAuthResult | InboxIssue | import('../api').WorkUnitWithLiveness | InboxWebhookEvent | InboxManagedReminderOccurrence;
}

// ── Helpers ──

function itemBorderColor(item: UnifiedItem): string {
  if (item.type === 'continuation') return INBOX_TONES.continuation.fg;
  if (item.type === 'work_unit_continuation') return INBOX_TONES.handoff.fg;
  if (item.type === 'issue') return INBOX_TONES.issue.fg;
  if (item.type === 'credential_leak') return INBOX_TONES.credentialLeak.fg;
  if (item.type === 'managed_reminder_occurrence') return INBOX_TONES.reminder.fg;
  const ar = item.raw as InboxAuthResult;
  if (ar.status === 'completed') return INBOX_TONES.authCompleted.fg;
  if (ar.status === 'failed' || ar.status === 'rejected' || ar.status === 'expired' || ar.status === 'needs_rebase') return INBOX_TONES.authProblem.fg;
  if (ar.status === 'dismissed' || ar.status === 'withdrawn' || ar.status === 'superseded') return INBOX_TONES.authNeutral.fg;
  return INBOX_TONES.authNeutral.fg;
}

function itemTypeBadge(item: UnifiedItem): string {
  if (item.type === 'continuation') return 'Continuation';
  if (item.type === 'work_unit_continuation') return 'Handoff';
  if (item.type === 'issue') return 'Issue';
  if (item.type === 'credential_leak') return 'Credential Leak';
  if (item.type === 'managed_reminder_occurrence') return 'Reminder';
  const ar = item.raw as InboxAuthResult;
  return ar.status.charAt(0).toUpperCase() + ar.status.slice(1);
}

function itemTypeBadgeColor(item: UnifiedItem): string {
  return itemBorderColor(item);
}

function authResultTone(status: string): { fg: string; bg: string } {
  if (status === 'completed') return INBOX_TONES.authCompleted;
  if (status === 'failed' || status === 'rejected' || status === 'expired' || status === 'needs_rebase') {
    return INBOX_TONES.authProblem;
  }
  return INBOX_TONES.authNeutral;
}

function buildUnifiedItems(data: InboxData): UnifiedItem[] {
  const items: UnifiedItem[] = [];

  for (const c of data.continuations) {
    const t = c.ended_at ? Date.parse(c.ended_at) : null;
    items.push({
      id: `continuation:${c.session_id}`,
      type: 'continuation',
      title: c.continuation.slice(0, 80).replace(/\n/g, ' '),
      repo: c.repo ?? null,
      branch: c.branch ?? null,
      time: t,
      raw: c,
    });
  }

  for (const ar of data.auth_results) {
    items.push({
      id: `auth_result:${ar.id}`,
      type: 'auth_result',
      title: ar.title || ar.head_branch || 'Approval Request',
      repo: ar.repo ?? null,
      branch: ar.head_branch ?? null,
      time: ar.resolved_at,
      raw: ar,
    });
  }

  for (const issue of data.open_issues) {
    items.push({
      id: `issue:${issue.repo_id ?? ''}:${issue.id}`,
      type: 'issue',
      title: issue.title,
      repo: issue.repo_name ?? issue.repo_id ?? null,
      branch: null,
      time: null,
      raw: issue,
    });
  }

  // Bug: cbbb3d9 — include work-unit continuations in unified list
  for (const wu of (data.work_unit_continuations ?? [])) {
    const title = wu.continuation
      ? wu.continuation.slice(0, 80).replace(/\n/g, ' ')
      : `Work unit: ${wu.issue_id.slice(0, 8)}`;
    items.push({
      id: `wu_continuation:${wu.id}`,
      type: 'work_unit_continuation',
      title,
      repo: null,
      branch: wu.branch ?? null,
      time: wu.continuation_at,
      raw: wu,
    });
  }

  // Issue 71a287e — credential-leak alerts from the pending webhook queue
  for (const event of (data.pending_webhooks ?? [])) {
    if (event.event_type !== CREDENTIAL_LEAK_EVENT_TYPE) continue;
    const leak = (event.data ?? {}) as CredentialLeakEventData;
    items.push({
      id: `credential_leak:${event.id}`,
      type: 'credential_leak',
      title: event.title
        || `Leaked credential: ${leak.credential_label ?? leak.credential_id ?? 'unknown'}`,
      repo: null,
      branch: event.target_branch,
      time: event.created_at,
      raw: event,
    });
  }

  for (const occurrence of (data.managed_reminder_occurrences ?? [])) {
    items.push({
      id: `managed_reminder_occurrence:${occurrence.id}`,
      type: 'managed_reminder_occurrence',
      title: occurrence.message,
      repo: occurrence.project_key,
      branch: null,
      time: occurrence.created_at,
      raw: occurrence,
    });
  }

  // Sort by time desc (nulls last)
  items.sort((a, b) => {
    if (a.time === null && b.time === null) return 0;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return b.time - a.time;
  });

  return items;
}

// ── Chip filter components ──

interface FilterChip {
  type: 'repo' | 'branch';
  value: string;
}

function ChipInput({
  chips,
  suggestions,
  onAdd,
  onRemove,
}: {
  chips: FilterChip[];
  suggestions: { repos: string[]; branches: string[] };
  onAdd: (chip: FilterChip) => void;
  onRemove: (chip: FilterChip) => void;
}): JSX.Element {
  const [inputValue, setInputValue] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredSuggestions = useMemo(() => {
    const q = inputValue.toLowerCase().trim();
    if (!q) return { repos: suggestions.repos.slice(0, 8), branches: [] };
    const repos = suggestions.repos.filter((r) => r.toLowerCase().includes(q));
    const branches = suggestions.branches.filter((b) => b.toLowerCase().includes(q));
    return { repos: repos.slice(0, 5), branches: branches.slice(0, 5) };
  }, [inputValue, suggestions]);

  const hasMatches =
    filteredSuggestions.repos.length > 0 || filteredSuggestions.branches.length > 0;

  const alreadyAdded = (type: 'repo' | 'branch', value: string) =>
    chips.some((c) => c.type === type && c.value === value);

  const handleSelect = (type: 'repo' | 'branch', value: string) => {
    if (!alreadyAdded(type, value)) {
      onAdd({ type, value });
    }
    setInputValue('');
    setShowDropdown(false);
    inputRef.current?.focus();
  };

  return (
    <div className="inbox-chip-input">
      <div className="inbox-chip-input__chips">
        {chips.map((chip) => (
          <span
            key={`${chip.type}:${chip.value}`}
            className={`inbox-chip inbox-chip--${chip.type}`}
          >
            <span className="inbox-chip__label">{chip.value}</span>
            <button
              type="button"
              className="inbox-chip__remove"
              onClick={() => onRemove(chip)}
              aria-label={`Remove filter ${chip.value}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="inbox-chip-input__input"
          aria-label="Filter inbox by repo or branch"
          placeholder={chips.length === 0 ? 'Filter by repo or branch…' : ''}
          value={inputValue}
          onInput={(e) => {
            setInputValue((e.target as HTMLInputElement).value);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setInputValue('');
              setShowDropdown(false);
            }
            if (e.key === 'Backspace' && inputValue === '' && chips.length > 0) {
              onRemove(chips[chips.length - 1]);
            }
          }}
        />
      </div>
      {showDropdown && hasMatches && (
        <div className="inbox-chip-input__dropdown">
          {filteredSuggestions.repos.length > 0 && (
            <>
              <div className="inbox-chip-input__group-label">Repos</div>
              {filteredSuggestions.repos.map((repo) => (
                <button
                  key={repo}
                  type="button"
                  className={`inbox-chip-input__option${alreadyAdded('repo', repo) ? ' inbox-chip-input__option--added' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect('repo', repo);
                  }}
                >
                  {repo}
                </button>
              ))}
            </>
          )}
          {filteredSuggestions.branches.length > 0 && (
            <>
              <div className="inbox-chip-input__group-label">Branches</div>
              {filteredSuggestions.branches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  className={`inbox-chip-input__option${alreadyAdded('branch', branch) ? ' inbox-chip-input__option--added' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect('branch', branch);
                  }}
                >
                  {branch}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sidebar item row ──

function InboxSidebarItem({
  item,
  selected,
  onSelect,
}: {
  item: UnifiedItem;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const borderColor = itemBorderColor(item);
  const badge = itemTypeBadge(item);
  const badgeColor = itemTypeBadgeColor(item);

  return (
    <button
      type="button"
      className={`inbox-sidebar-item${selected ? ' inbox-sidebar-item--selected' : ''}`}
      style={{ borderLeftColor: borderColor }}
      onClick={() => onSelect(item.id)}
    >
      <div className="inbox-sidebar-item__row1">
        <span
          className="inbox-sidebar-item__badge"
          style={{ color: badgeColor, background: `${badgeColor}22` }}
        >
          {badge}
        </span>
        {item.time !== null && (
          <span className="inbox-sidebar-item__time">
            {formatRelativeTime(item.time)}
          </span>
        )}
      </div>
      <div
        className="inbox-sidebar-item__title"
        // Bug: 387ae46 — render titles as inline markdown (sanitized)
        dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(item.title) }}
      />
      <div className="inbox-sidebar-item__meta">
        {item.repo && (
          <span className="inbox-sidebar-item__repo">{item.repo}</span>
        )}
        {item.branch && (
          <span className="inbox-sidebar-item__branch">{item.branch}</span>
        )}
      </div>
    </button>
  );
}

// ── Detail panel sub-components ──

function ContinuationDetail({
  item,
  onAck,
  mutationsAllowed,
}: {
  item: InboxContinuation;
  onAck: (id: string) => Promise<void>;
  mutationsAllowed: boolean;
}): JSX.Element {
  return (
    <div className="inbox-detail__content">
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{ color: INBOX_TONES.continuation.fg, background: INBOX_TONES.continuation.bg }}
        >
          Continuation
        </span>
        <h2 className="inbox-detail__title">Session Handoff</h2>
      </div>
      <div className="inbox-detail__meta">
        {item.branch && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Branch</span>
            <code className="inbox-detail__meta-value">{item.branch}</code>
          </div>
        )}
        {item.repo && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Repo</span>
            <span className="inbox-detail__meta-value">{item.repo}</span>
          </div>
        )}
        {item.ended_at && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Ended</span>
            <span className="inbox-detail__meta-value">
              {formatRelativeTime(item.ended_at)}
            </span>
          </div>
        )}
      </div>
      <pre className="inbox-detail__pre">{item.continuation}</pre>
      <div className="inbox-detail__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void onAck(item.session_id)}
          disabled={!mutationsAllowed}
        >
          Acknowledge
        </button>
      </div>
    </div>
  );
}

function AuthResultDetail({
  item,
  onAck,
  mutationsAllowed,
}: {
  item: InboxAuthResult;
  onAck: (id: string) => Promise<void>;
  mutationsAllowed: boolean;
}): JSX.Element {
  const statusTone = authResultTone(item.status);
  const statusLabel = item.status === 'needs_rebase'
    ? 'Needs rebase'
    : item.status.charAt(0).toUpperCase() + item.status.slice(1);

  return (
    <div className="inbox-detail__content">
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{ color: statusTone.fg, background: statusTone.bg }}
        >
          {statusLabel}
        </span>
        <h2 className="inbox-detail__title">{item.title || 'Approval Request'}</h2>
      </div>
      <div className="inbox-detail__meta">
        {item.repo && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Repo</span>
            <span className="inbox-detail__meta-value">{item.repo}</span>
          </div>
        )}
        {item.head_branch && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Branch</span>
            <code className="inbox-detail__meta-value">{item.head_branch}</code>
          </div>
        )}
        {item.base_branch && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Base</span>
            <code className="inbox-detail__meta-value">{item.base_branch}</code>
          </div>
        )}
        {item.resolved_at !== null && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Resolved</span>
            <span className="inbox-detail__meta-value">
              {formatRelativeTime(item.resolved_at)}
            </span>
          </div>
        )}
        {item.exit_code !== null && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Exit code</span>
            <code className="inbox-detail__meta-value">{item.exit_code}</code>
          </div>
        )}
      </div>
      {item.error && (
        <div className="inbox-detail__error">
          <span className="inbox-detail__meta-label">Error</span>
          <pre className="inbox-detail__pre inbox-detail__pre--sm">{item.error}</pre>
        </div>
      )}
      <div className="inbox-detail__actions">
        <a
          href="#/auth"
          style={{ fontSize: '13px', color: 'var(--accent-blue)', textDecoration: 'underline' }}
        >
          View in Approvals
        </a>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void onAck(item.id)}
          disabled={!mutationsAllowed}
        >
          Acknowledge
        </button>
      </div>
    </div>
  );
}

// Bug: cbbb3d9 — work-unit continuation detail with Resume button
function WorkUnitContinuationDetail({
  item,
  instance,
}: {
  item: import('../api').WorkUnitWithLiveness;
  instance?: InstanceInfo | null;
}): JSX.Element {
  const [spawning, setSpawning] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const spawnPath = `/api/issues/${encodeURIComponent(item.repo_id)}/${encodeURIComponent(item.issue_id)}/spawn`;
  const spawnAllowed = canPerformOperation(instance, 'POST', spawnPath, {});

  const handleResume = async () => {
    if (!spawnAllowed || spawning) return;
    setSpawning(true);
    try {
      const result = await spawnIssueAgent(item.repo_id, item.issue_id, item);
      window.location.hash = `#/console?conversation=${encodeURIComponent(result.conversation_id)}`;
    } catch (error) {
      setResumeError(error instanceof Error ? error.message : String(error));
    } finally {
      setSpawning(false);
    }
  };

  return (
    <div className="inbox-detail__content">
      {resumeError && <p role="alert">{resumeError}</p>}
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{ color: INBOX_TONES.handoff.fg, background: INBOX_TONES.handoff.bg }}
        >
          Handoff
        </span>
        <h2 className="inbox-detail__title">Work Unit Continuation</h2>
      </div>
      <div className="inbox-detail__meta">
        {item.branch && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Branch</span>
            <code className="inbox-detail__meta-value">{item.branch}</code>
          </div>
        )}
        {item.issue_id && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Issue</span>
            <IssuePill issueRef={item.issue_id} context={item.repo_id} />
          </div>
        )}
        {item.continuation_at && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Handed off</span>
            <span className="inbox-detail__meta-value">
              {formatRelativeTime(item.continuation_at)}
            </span>
          </div>
        )}
      </div>
      {item.continuation && (
        <pre className="inbox-detail__pre">{item.continuation}</pre>
      )}
      <div className="inbox-detail__actions">
        <button
          type="button"
          className="btn btn--active"
          onClick={() => void handleResume()}
          disabled={!spawnAllowed || spawning}
          title={spawnAllowed ? undefined : 'Starting an agent is unavailable in this instance'}
        >
          {spawning ? 'Spawning...' : 'Resume'}
        </button>
        {item.issue_id && item.repo_id && (
          <a
            href={`#/issues?repo=${encodeURIComponent(item.repo_id)}&issue=${encodeURIComponent(item.issue_id)}`}
            className="btn btn--ghost"
          >
            View Issue
          </a>
        )}
      </div>
    </div>
  );
}

// Issue 71a287e — leaked-credential alert. Shows which credential leaked, where
// it leaked, and the exact remediation commands. No token material is ever
// carried in the event payload, so there is nothing sensitive to render here.
function CredentialLeakDetail({ item }: { item: InboxWebhookEvent }): JSX.Element {
  const leak = (item.data ?? {}) as CredentialLeakEventData;
  const mintCommand = leak.remediation?.mint
    ?? `mandible user token mint ${leak.user_slug ?? '<user>'} --store`;
  const revokeCommand = leak.remediation?.revoke
    ?? `mandible user token revoke ${leak.credential_id ?? '<credential-id>'}`;
  const where = leak.conversation_title
    || leak.session_id
    || leak.conversation_id
    || 'an indexed conversation';

  return (
    <div className="inbox-detail__content">
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{
            color: INBOX_TONES.credentialLeak.fg,
            background: INBOX_TONES.credentialLeak.bg,
          }}
        >
          Credential Leak
        </span>
        <h2 className="inbox-detail__title">
          {leak.credential_label ?? leak.credential_id ?? 'Leaked credential'}
        </h2>
      </div>
      <div className="inbox-detail__meta">
        {leak.user_slug && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Owner</span>
            <span className="inbox-detail__meta-value">{leak.user_slug}</span>
          </div>
        )}
        {leak.credential_id && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Credential</span>
            <code className="inbox-detail__meta-value">{leak.credential_id}</code>
          </div>
        )}
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Leaked in</span>
          <span className="inbox-detail__meta-value">{where}</span>
        </div>
        {leak.provider && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Provider</span>
            <span className="inbox-detail__meta-value">{leak.provider}</span>
          </div>
        )}
        {leak.block_position !== null && leak.block_position !== undefined && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Block</span>
            <code className="inbox-detail__meta-value">#{leak.block_position}</code>
          </div>
        )}
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Status</span>
          <span className="inbox-detail__meta-value">
            {leak.auto_revoked
              ? 'Session-scoped token — automatically revoked'
              : 'Long-lived PAT — NOT auto-revoked, rotate manually'}
          </span>
        </div>
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Detected</span>
          <span className="inbox-detail__meta-value">
            {formatRelativeTime(item.created_at)}
          </span>
        </div>
      </div>
      <pre className="inbox-detail__pre">
        {`Remediate — mint a replacement, then revoke the leaked credential:\n\n  ${mintCommand}\n  ${revokeCommand}`}
      </pre>
      <div className="inbox-detail__actions">
        {leak.conversation_id && (
          <a
            href={`#/conversations?id=${encodeURIComponent(leak.conversation_id)}`}
            className="btn btn--ghost"
          >
            View conversation &rarr;
          </a>
        )}
      </div>
    </div>
  );
}

function IssueDetail({ item }: { item: InboxIssue }): JSX.Element {
  const href = item.repo_id
    ? `#/issues?repo=${encodeURIComponent(item.repo_id)}&issue=${encodeURIComponent(item.id)}`
    : '#/issues';
  return (
    <div className="inbox-detail__content">
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{ color: INBOX_TONES.issue.fg, background: INBOX_TONES.issue.bg }}
        >
          Issue
        </span>
        <h2 className="inbox-detail__title">{item.title}</h2>
      </div>
      <div className="inbox-detail__meta">
        {(item.repo_name || item.repo_id) && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Repo</span>
            <span className="inbox-detail__meta-value">
              {item.repo_name || item.repo_id}
            </span>
          </div>
        )}
        {item.id && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">ID</span>
            <IssuePill issueRef={item.id} context={item.repo_id} />
          </div>
        )}
      </div>
      {item.labels.length > 0 && (
        <div className="inbox-detail__labels">
          {item.labels.map((lbl) => (
            <span key={lbl} className="inbox-detail__label-pill">
              {lbl}
            </span>
          ))}
        </div>
      )}
      <div className="inbox-detail__actions">
        <a href={href} className="btn btn--ghost">
          View in Issues &rarr;
        </a>
      </div>
    </div>
  );
}

function ManagedReminderOccurrenceDetail({
  item,
  onAck,
  mutationsAllowed,
}: {
  item: InboxManagedReminderOccurrence;
  onAck: (id: string) => Promise<void>;
  mutationsAllowed: boolean;
}): JSX.Element {
  const evidence = item.triggering_evidence;
  const predicate = item.predicate;
  return (
    <div className="inbox-detail__content">
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{ color: INBOX_TONES.reminder.fg, background: INBOX_TONES.reminder.bg }}
        >
          Reminder
        </span>
        <h2 className="inbox-detail__title">{item.message}</h2>
      </div>
      <div className="inbox-detail__meta">
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Project</span>
          <span className="inbox-detail__meta-value">{item.project_key}</span>
        </div>
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Triggered by</span>
          <span className="inbox-detail__meta-value">{evidence.kind ?? predicate.kind}</span>
        </div>
        {typeof evidence.observed_count === 'number' && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Observed count</span>
            <span className="inbox-detail__meta-value">{evidence.observed_count}</span>
          </div>
        )}
        {typeof evidence.issue_id === 'string' && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Issue</span>
            <code className="inbox-detail__meta-value">{evidence.issue_id}</code>
          </div>
        )}
        {typeof evidence.at === 'string' && (
          <div className="inbox-detail__meta-row">
            <span className="inbox-detail__meta-label">Scheduled for</span>
            <span className="inbox-detail__meta-value">{evidence.at}</span>
          </div>
        )}
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Fired</span>
          <span className="inbox-detail__meta-value">{formatRelativeTime(item.created_at)}</span>
        </div>
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Created by</span>
          <code className="inbox-detail__meta-value">{item.created_by_user_id}</code>
        </div>
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Fired by</span>
          <code className="inbox-detail__meta-value">{item.fired_by_user_id}</code>
        </div>
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Reminder</span>
          <code className="inbox-detail__meta-value">{item.task_id}</code>
        </div>
        <div className="inbox-detail__meta-row">
          <span className="inbox-detail__meta-label">Revision evidence</span>
          <code className="inbox-detail__meta-value">{item.payload_digest.slice(0, 16)}</code>
        </div>
      </div>
      <div className="inbox-detail__actions">
        <a
          href={`#/tasks?task=${encodeURIComponent(`mandible-reminder:${item.task_id}`)}`}
          className="btn btn--ghost"
        >
          View in Tasks &rarr;
        </a>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void onAck(item.id)}
          disabled={!mutationsAllowed}
        >
          Acknowledge
        </button>
      </div>
    </div>
  );
}

// ── Main view ──

export function InboxView({
  data,
  loading,
  selectedItemId,
  sidebarHidden = false,
  onSelectItem,
  onAckContinuation,
  onAckAuthResult,
  onAckManagedReminderOccurrence,
  onAckAll,
  onRefresh,
  instance = null,
  error = null,
}: InboxViewProps): JSX.Element {
  const [chips, setChips] = useState<FilterChip[]>([]);
  const [actionsOpen, setActionsOpen] = useState(false);

  // Build full unified item list from data
  const allItems = useMemo(() => (data ? buildUnifiedItems(data) : []), [data]);

  // Collect all unique repos and branches for autocomplete suggestions
  const suggestions = useMemo(() => {
    const repos = new Set<string>();
    const branches = new Set<string>();
    for (const item of allItems) {
      if (item.repo) repos.add(item.repo);
      if (item.branch) branches.add(item.branch);
    }
    return { repos: Array.from(repos).sort(), branches: Array.from(branches).sort() };
  }, [allItems]);

  // Apply chip filters: show items matching ANY selected repo AND ANY selected branch
  const filteredItems = useMemo(() => {
    const repoChips = chips.filter((c) => c.type === 'repo').map((c) => c.value);
    const branchChips = chips.filter((c) => c.type === 'branch').map((c) => c.value);
    return allItems.filter((item) => {
      const repoMatch = repoChips.length === 0 || (item.repo !== null && repoChips.includes(item.repo));
      const branchMatch = branchChips.length === 0 || (item.branch !== null && branchChips.includes(item.branch));
      return repoMatch && branchMatch;
    });
  }, [allItems, chips]);

  // Find selected item from the full unfiltered list (so detail stays visible after filter)
  const selectedItem = useMemo(
    () => allItems.find((i) => i.id === selectedItemId) ?? null,
    [allItems, selectedItemId],
  );

  // Keep the detail pane on the last valid item. If that item disappears,
  // advance deterministically to the first currently visible item.
  useEffect(() => {
    if (!onSelectItem) return;
    if (selectedItem) return;
    const nextId = filteredItems[0]?.id ?? null;
    if (nextId !== (selectedItemId ?? null)) onSelectItem(nextId);
  }, [filteredItems, onSelectItem, selectedItem, selectedItemId]);

  const handleAddChip = (chip: FilterChip) => setChips((prev) => [...prev, chip]);
  const handleRemoveChip = (chip: FilterChip) =>
    setChips((prev) => prev.filter((c) => !(c.type === chip.type && c.value === chip.value)));

  const handleAckAll = async () => {
    if (!canPerformOperation(instance, 'POST', '/api/inbox/ack-all')) return;
    await onAckAll();
    setActionsOpen(false);
  };

  const acknowledge = (
    type: 'continuation' | 'auth_result' | 'managed_reminder_occurrence',
    id: string,
    action: (itemId: string) => Promise<void>,
  ) => canPerformOperation(instance, 'POST', `/api/inbox/${type}/${encodeURIComponent(id)}/ack`, {})
    ? action(id)
    : Promise.resolve();

  const acknowledgeableCount = (data?.continuations.length ?? 0)
    + (data?.auth_results.length ?? 0)
    + (data?.managed_reminder_occurrences?.length ?? 0);

  if (loading && !data) {
    return (
      <div className="inbox-detail" style={{ height: 'calc(100vh - 80px)', margin: '-28px -32px -48px' }}>
        <AppOperationalNoticeOutlet registerAsMain />
        <div className="inbox-detail__empty">
          <span className="text-muted">Loading inbox…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`inbox-sidebar-layout${sidebarHidden ? ' inbox-sidebar-layout--sidebar-hidden' : ''}`}>
      <ViewSidebar
        {...VIEW_SIDEBAR_GEOMETRY.inbox}
        className="inbox-sidebar"
        ariaLabel="Inbox"
        hidden={sidebarHidden}
        header={
          <SidebarSearchFilterHeader
            value=""
            onValueChange={() => undefined}
            placeholder="Filter inbox by repo or branch…"
            searchAriaLabel="Filter inbox by repo or branch"
            clearAriaLabel="Clear inbox filter search"
            searchSlot={
              <ChipInput
                chips={chips}
                suggestions={suggestions}
                onAdd={handleAddChip}
                onRemove={handleRemoveChip}
              />
            }
            filterTrigger={{
              ariaLabel: 'Inbox menu',
              title: 'Inbox menu',
              kind: 'menu',
              open: actionsOpen,
              onToggle: () => setActionsOpen((open) => !open),
            }}
            panel={actionsOpen ? {
              id: 'inbox-actions-menu',
              role: 'menu',
              ariaLabel: 'Inbox menu',
              onDismiss: () => setActionsOpen(false),
              children: (
                <>
                  <div className="sidebar-search-filter__section" role="none">
                    <span className="sidebar-search-filter__label">Sort</span>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked="true"
                      className="inbox-sidebar__sort-value"
                      disabled
                    >
                      Date
                    </button>
                  </div>
                  <div className="sidebar-search-filter__section inbox-sidebar__menu-actions" role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void handleAckAll()}
                      disabled={!canPerformOperation(instance, 'POST', '/api/inbox/ack-all') || acknowledgeableCount === 0}
                      title={canPerformOperation(instance, 'POST', '/api/inbox/ack-all')
                        ? 'Acknowledge all inbox items'
                        : 'This action is unavailable in this instance'}
                    >
                      Acknowledge All
                    </button>
                  </div>
                </>
              ),
            } : undefined}
          />
        }
        bodyClassName="inbox-sidebar__list"
      >
              {filteredItems.length === 0 ? (
                <div className="inbox-sidebar__empty">
                  {allItems.length > 0
                    ? 'No items match the current filters.'
                    : data
                      ? error
                        ? 'Could not confirm the inbox is clear.'
                        : 'Inbox is clear.'
                      : error
                        ? 'Inbox could not be loaded.'
                        : 'Inbox has not loaded yet.'}
                </div>
              ) : (
                filteredItems.map((item) => (
                  <InboxSidebarItem
                    key={item.id}
                    item={item}
                    selected={selectedItemId === item.id}
                    onSelect={(id) => onSelectItem?.(id)}
                  />
                ))
              )}
      </ViewSidebar>

      {error ? (
        <DetailPaneNotice
          severity="error"
          density="compact"
          source="inbox-load"
          title={data ? 'Inbox refresh failed' : 'Inbox could not be loaded'}
          actions={<button type="button" onClick={onRefresh} disabled={loading}>Retry</button>}
        >
          {data ? `The last loaded inbox is still shown. ${error}` : error}
        </DetailPaneNotice>
      ) : null}

      {/* RIGHT DETAIL PANEL */}
      <div className="inbox-detail">
        <AppOperationalNoticeOutlet registerAsMain />
        {!selectedItem ? (
          <div className="inbox-detail__empty">
            <span className="text-muted" style={{ fontSize: '14px' }}>
              {data
                ? error ? 'Could not confirm the inbox is clear.' : 'No items in this view'
                : error ? 'Inbox data is unavailable.' : 'Inbox has not loaded yet.'}
            </span>
          </div>
        ) : selectedItem.type === 'continuation' ? (
          <ContinuationDetail
            item={selectedItem.raw as InboxContinuation}
            onAck={(id) => acknowledge('continuation', id, onAckContinuation)}
            mutationsAllowed={canPerformOperation(
              instance,
              'POST',
              `/api/inbox/continuation/${encodeURIComponent((selectedItem.raw as InboxContinuation).session_id)}/ack`,
              {},
            )}
          />
        ) : selectedItem.type === 'auth_result' ? (
          <AuthResultDetail
            item={selectedItem.raw as InboxAuthResult}
            onAck={(id) => acknowledge('auth_result', id, onAckAuthResult)}
            mutationsAllowed={canPerformOperation(
              instance,
              'POST',
              `/api/inbox/auth_result/${encodeURIComponent((selectedItem.raw as InboxAuthResult).id)}/ack`,
              {},
            )}
          />
        ) : selectedItem.type === 'work_unit_continuation' ? (
          <WorkUnitContinuationDetail
            item={selectedItem.raw as import('../api').WorkUnitWithLiveness}
            instance={instance}
          />
        ) : selectedItem.type === 'credential_leak' ? (
          <CredentialLeakDetail item={selectedItem.raw as InboxWebhookEvent} />
        ) : selectedItem.type === 'managed_reminder_occurrence' ? (
          <ManagedReminderOccurrenceDetail
            item={selectedItem.raw as InboxManagedReminderOccurrence}
            onAck={(id) => acknowledge('managed_reminder_occurrence', id, onAckManagedReminderOccurrence)}
            mutationsAllowed={canPerformOperation(
              instance,
              'POST',
              `/api/inbox/managed_reminder_occurrence/${encodeURIComponent((selectedItem.raw as InboxManagedReminderOccurrence).id)}/ack`,
              {},
            )}
          />
        ) : (
          <IssueDetail item={selectedItem.raw as InboxIssue} />
        )}
      </div>
    </div>
  );
}
