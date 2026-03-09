// Inbox tab — sidebar+detail panel layout with chip filters and unified item list.
// Bug: 4fa87d9 — inbox sidebar redesign

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { useSidebarResize } from '../hooks/useSidebarResize';

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
 * Render inline markdown — strips the outer <p>…</p> wrapper for single-line
 * input so text flows inline in compact contexts (sidebar item titles).
 * Bug: 387ae46 — markdown rendering in inbox sidebar titles
 */
function renderInlineMarkdown(src: string): string {
  if (!src) return '';
  const result = marked.parse(src, { async: false });
  const html = typeof result === 'string' ? result : '';
  const stripped = html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
  return sanitizeInlineHtml(stripped);
}

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
  status: 'completed' | 'rejected' | 'expired' | 'dismissed';
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

export interface InboxData {
  continuations: InboxContinuation[];
  auth_results: InboxAuthResult[];
  open_issues: InboxIssue[];
  total: number;
}

export interface InboxViewProps {
  data: InboxData | null;
  loading: boolean;
  selectedItemId?: string | null;
  onSelectItem?: (id: string | null) => void;
  onAckContinuation: (sessionId: string) => Promise<void>;
  onAckAuthResult: (requestId: string) => Promise<void>;
  onAckAll: () => Promise<void>;
  onRefresh: () => void;
}

// ── Types for unified item list ──

type ItemType = 'continuation' | 'auth_result' | 'issue';

interface UnifiedItem {
  id: string;
  type: ItemType;
  title: string;
  repo: string | null;
  branch: string | null;
  time: number | null;
  raw: InboxContinuation | InboxAuthResult | InboxIssue;
}

// ── Helpers ──

function formatRelativeTime(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const parsed = typeof value === 'number' ? value : Date.parse(value as string);
  if (Number.isNaN(parsed)) return String(value);
  const delta = Date.now() - parsed;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 1) return `${days}d ago`;
  if (days === 1) return 'yesterday';
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

function itemBorderColor(item: UnifiedItem): string {
  if (item.type === 'continuation') return '#60a5fa';
  if (item.type === 'issue') return '#a78bfa';
  const ar = item.raw as InboxAuthResult;
  if (ar.status === 'completed') return '#34d399';
  if (ar.status === 'rejected' || ar.status === 'expired') return '#f87171';
  if (ar.status === 'dismissed') return '#9ca3af';
  return '#9ca3af';
}

function itemTypeBadge(item: UnifiedItem): string {
  if (item.type === 'continuation') return 'Continuation';
  if (item.type === 'issue') return 'Issue';
  const ar = item.raw as InboxAuthResult;
  return ar.status.charAt(0).toUpperCase() + ar.status.slice(1);
}

function itemTypeBadgeColor(item: UnifiedItem): string {
  return itemBorderColor(item);
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
      title: ar.title || ar.head_branch || 'Auth Request',
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
}: {
  item: InboxContinuation;
  onAck: (id: string) => Promise<void>;
}): JSX.Element {
  return (
    <div className="inbox-detail__content">
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{ color: '#60a5fa', background: '#60a5fa22' }}
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
}: {
  item: InboxAuthResult;
  onAck: (id: string) => Promise<void>;
}): JSX.Element {
  const statusColor =
    item.status === 'completed'
      ? '#34d399'
      : item.status === 'rejected' || item.status === 'expired'
        ? '#f87171'
        : '#9ca3af';

  return (
    <div className="inbox-detail__content">
      <div className="inbox-detail__header">
        <span
          className="inbox-detail__type-badge"
          style={{ color: statusColor, background: `${statusColor}22` }}
        >
          {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
        </span>
        <h2 className="inbox-detail__title">{item.title || 'Auth Request'}</h2>
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
          View in Auth
        </a>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void onAck(item.id)}
        >
          Acknowledge
        </button>
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
          style={{ color: '#a78bfa', background: '#a78bfa22' }}
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
            <code className="inbox-detail__meta-value">{item.id.slice(0, 7)}</code>
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
          View in Issues →
        </a>
      </div>
    </div>
  );
}

// ── Main view ──

export function InboxView({
  data,
  loading,
  selectedItemId,
  onSelectItem,
  onAckContinuation,
  onAckAuthResult,
  onAckAll,
  onRefresh,
}: InboxViewProps): JSX.Element {
  const { width: sidebarWidth, handleMouseDown } = useSidebarResize({
    defaultWidth: 400,
    minWidth: 190,
    storageKey: 'sidebar-width:inbox',
  });

  const [chips, setChips] = useState<FilterChip[]>([]);

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

  // Auto-select first item when data loads if nothing is selected
  useEffect(() => {
    if (!selectedItemId && filteredItems.length > 0 && onSelectItem) {
      onSelectItem(filteredItems[0].id);
    }
  }, [filteredItems.length > 0, selectedItemId]);

  const handleAddChip = (chip: FilterChip) => setChips((prev) => [...prev, chip]);
  const handleRemoveChip = (chip: FilterChip) =>
    setChips((prev) => prev.filter((c) => !(c.type === chip.type && c.value === chip.value)));

  const handleAckAll = async () => {
    await onAckAll();
  };

  if (loading && !data) {
    return (
      <div className="inbox-sidebar-layout">
        <div className="inbox-sidebar" style={{ ...(sidebarWidth !== null ? { width: `${sidebarWidth}px` } : {}), flexShrink: 0 }}>
          <div className="inbox-sidebar__header">
            <span className="text-muted" style={{ fontSize: '13px', padding: '14px' }}>
              Loading…
            </span>
          </div>
        </div>
        <div className="sidebar-drag-handle" onMouseDown={handleMouseDown} />
        <div className="inbox-detail">
          <div className="inbox-detail__empty">
            <span className="text-muted">Loading inbox…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="inbox-sidebar-layout">
      {/* LEFT SIDEBAR */}
      <div className="inbox-sidebar" style={{ width: `${sidebarWidth}px`, flexShrink: 0 }}>
        {/* Filter chips + autocomplete */}
        <div className="inbox-sidebar__chip-row">
          <ChipInput
            chips={chips}
            suggestions={suggestions}
            onAdd={handleAddChip}
            onRemove={handleRemoveChip}
          />
        </div>

        {/* Sort/actions bar */}
        <div className="inbox-sidebar__actions-bar">
          <span className="inbox-sidebar__sort-label">Sort: Date ▾</span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ fontSize: '11px', padding: '3px 10px' }}
              onClick={() => void handleAckAll()}
              disabled={(data?.continuations.length ?? 0) + (data?.auth_results.length ?? 0) === 0}
            >
              Ack All
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ fontSize: '11px', padding: '3px 10px' }}
              onClick={onRefresh}
            >
              ↻
            </button>
          </div>
        </div>

        {/* Item list */}
        <div className="inbox-sidebar__list">
          {filteredItems.length === 0 ? (
            <div className="inbox-sidebar__empty">
              {allItems.length === 0 ? 'Inbox is clear.' : 'No items match the current filters.'}
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
        </div>
      </div>

      {/* Drag handle */}
      <div className="sidebar-drag-handle" onMouseDown={handleMouseDown} />

      {/* RIGHT DETAIL PANEL */}
      <div className="inbox-detail">
        {!selectedItem ? (
          <div className="inbox-detail__empty">
            <span className="text-muted" style={{ fontSize: '14px' }}>
              Select an item to view details
            </span>
          </div>
        ) : selectedItem.type === 'continuation' ? (
          <ContinuationDetail
            item={selectedItem.raw as InboxContinuation}
            onAck={onAckContinuation}
          />
        ) : selectedItem.type === 'auth_result' ? (
          <AuthResultDetail
            item={selectedItem.raw as InboxAuthResult}
            onAck={onAckAuthResult}
          />
        ) : (
          <IssueDetail item={selectedItem.raw as InboxIssue} />
        )}
      </div>
    </div>
  );
}
