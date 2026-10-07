// Issue 037fa85 — Session Overview view: per-session page with page-level
// agent session auto-binding.
//
// The view is generic first: it renders for any session id (from the picker or
// a #/overview?session=<id> deep link). When the page consumed a tab-local
// agent_session fragment at boot, the resolver decides the binding with
// explicit zero/one/many semantics — exactly one match auto-binds, anything
// else is shown honestly with the session picker as fallback. The binding is
// display/navigation-only: it is never attached to a mutation request.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AppOperationalNoticeOutlet, useRegisterInitialRouteLoad } from '../app-shell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import {
  getProviderScopedOverview,
  getSessionOverview,
  getSessions,
  invalidateApiGetCache,
  resolveAgentSession,
  type Conversation,
  type ConversationControlSnapshot,
  type ConversationSpawnReceipt,
  type ProviderScopedLinkedIssue,
  type ProviderScopedOverview,
  type SessionOverview,
  type SessionOverviewChild,
  type SessionOverviewConversation,
  type SessionOverviewLinkedIssue,
  type SessionOverviewWorkUnit,
  type SessionResolveMatch,
} from '../api';
import { conversationControlPresentation } from '../chat/conversationControl';
import { chatControlFailureNotice } from '../chat/ChatFailureNotice';
import { shortRouteId } from '../routing';
import { resourceRefHref } from '../resource-refs';
import type { SessionRecord } from '../types/session';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';

type BindingState =
  | { kind: 'none' }
  | { kind: 'resolving' }
  | { kind: 'bound'; match: SessionResolveMatch }
  | { kind: 'zero' }
  // Issue 037fa85 (follow-up) — exactly one match with a transcript but no
  // Mandible session row: render the provider-scoped overview, not the picker.
  | { kind: 'provider-scoped'; match: SessionResolveMatch }
  // Review C4 — truncated marks a capped prefix scan: even a single returned
  // match must not be presented (or auto-bound) as unique.
  | { kind: 'many'; matches: SessionResolveMatch[]; truncated?: boolean };

export type ManagedConversationOverview = {
  conversation: Pick<Conversation, 'id' | 'title' | 'source' | 'cwd' | 'branch' | 'model' | 'started_at'>;
  control: ConversationControlSnapshot | null;
  spawn: ConversationSpawnReceipt | null;
};

function ManagedConversationFacts({ conversation, control, spawn }: ManagedConversationOverview): JSX.Element {
  const matchingControl = control?.conversation_id === conversation.id ? control : null;
  const failure = spawn?.error?.message ?? (
    matchingControl?.turn.kind === 'failed' ? chatControlFailureNotice(matchingControl.turn.error).detail
      : matchingControl?.controller.kind === 'failed' ? chatControlFailureNotice(matchingControl.controller.error).detail
        : null
  );
  const status = spawn?.state === 'failed' ? 'Failed'
    : spawn && (spawn.state === 'reserved' || spawn.state === 'starting') && (!matchingControl || matchingControl.turn.kind === 'none') ? spawn.state
    : matchingControl ? conversationControlPresentation(matchingControl).status
      : spawn?.state ?? null;
  return (
    <section className="session-overview__section" aria-label="Conversation">
      <dl className="session-overview__facts">
        <div className="session-overview__facts-wide"><dt>Conversation</dt><dd>{conversation.title}</dd></div>
        <div><dt>Provider</dt><dd>{conversation.source}</dd></div>
        {status ? <div><dt>Status</dt><dd>{status}</dd></div> : null}
        {conversation.model ? <div><dt>Model</dt><dd>{conversation.model}</dd></div> : null}
        {conversation.branch ? <div><dt>Branch</dt><dd>{conversation.branch}</dd></div> : null}
        {conversation.cwd ? <div className="session-overview__facts-wide"><dt>Cwd</dt><dd className="session-overview__path">{conversation.cwd}</dd></div> : null}
        <div><dt>Started</dt><dd>{formatTimestamp(conversation.started_at)}</dd></div>
        {failure ? <div className="session-overview__facts-wide" role="alert"><dt>Failure</dt><dd>{failure}</dd></div> : null}
      </dl>
    </section>
  );
}

export type SessionOverviewViewProps = {
  initialSessionId: string | null;
  agentBinding: string | null;
  embedded?: boolean;
  managedConversation?: ManagedConversationOverview;
};

export async function warmInitialData(params: Record<string, string>): Promise<void> {
  const sessionId = params.session?.trim();
  if (sessionId) {
    await getSessionOverview(sessionId);
    return;
  }
  await getSessions<SessionRecord>();
}

function formatTimestamp(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shortUuid(value: string): string {
  return value.length > 13 ? `${value.slice(0, 13)}…` : value;
}

function distinctSessionRef(value: string, peers: string[]): string {
  if (value.length <= 13) return value;
  let length = 8;
  while (
    length < value.length
    && peers.some((peer) => peer !== value && peer.startsWith(value.slice(0, length)))
  ) {
    length += 1;
  }
  return length < value.length ? `${value.slice(0, length)}…` : value;
}

function sessionText(session: Record<string, unknown>, key: string): string | null {
  const value = session[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Update the #/overview session param in place so refreshes keep the
 * selection. Issue f59b5bd — the shareable URL carries the 8-char short form;
 * the overview endpoints resolve prefixes with honest ambiguity handling.
 */
function writeSessionParamToHash(sessionId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const hash = window.location.hash || '#/overview';
    const [pathPart, queryPart] = hash.replace(/^#/, '').split('?');
    if (pathPart.replace(/^\//, '') !== 'overview') return;
    const params = new URLSearchParams(queryPart ?? '');
    if (sessionId) params.set('session', shortRouteId(sessionId));
    else params.delete('session');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#${pathPart}${query ? `?${query}` : ''}`,
    );
  } catch {
    // Navigation convenience only.
  }
}

function IssueRow({ issue }: { issue: SessionOverviewLinkedIssue }): JSX.Element {
  const shortId = issue.short_id || issue.issue_id.slice(0, 7);
  const resourceRef = `issue:${shortId}`;
  return (
    <tr>
      <td>
        <a data-resource-ref={resourceRef} href={resourceRefHref(resourceRef)}>{shortId}</a>
      </td>
      <td className="session-overview__cell-grow">{issue.title}</td>
      <td>
        <span className={`session-overview-badge session-overview-badge--${issue.status}`}>
          {issue.status}
        </span>
      </td>
      <td>{issue.link_type}</td>
      <td>{formatTimestamp(issue.last_seen_at ?? issue.created_at)}</td>
    </tr>
  );
}

function WorkUnitRow({ unit }: { unit: SessionOverviewWorkUnit }): JSX.Element {
  return (
    <tr>
      <td>{unit.issue_id.slice(0, 7)}</td>
      <td>{unit.repo_id}</td>
      <td className="session-overview__cell-grow">{unit.branch ?? '—'}</td>
      <td>
        <span className={`session-overview-badge session-overview-badge--${unit.state}`}>
          {unit.state}
        </span>
      </td>
      <td>{unit.kind}</td>
      <td>{formatTimestamp(unit.created_at)}</td>
    </tr>
  );
}

function ChildRow({ child }: { child: SessionOverviewChild }): JSX.Element {
  return (
    <tr>
      <td>
        <a href={`#/overview?session=${encodeURIComponent(shortRouteId(child.id))}`}>{shortUuid(child.id)}</a>
      </td>
      <td>{child.app}</td>
      <td>
        <span className={`session-overview-badge session-overview-badge--${child.status}`}>
          {child.status}
        </span>
      </td>
      <td className="session-overview__cell-grow">{child.task ?? child.branch ?? '—'}</td>
      <td>{child.depth}</td>
      <td>{formatTimestamp(child.last_active ?? child.created_at)}</td>
    </tr>
  );
}

function ConversationRow({ conversation }: { conversation: SessionOverviewConversation }): JSX.Element {
  return (
    <tr>
      <td className="session-overview__cell-grow">
        <a href={`#/console?conversation=${encodeURIComponent(conversation.id)}`}>
          {conversation.title || shortUuid(conversation.id)}
        </a>
      </td>
      <td>{conversation.source}</td>
      <td>{conversation.block_count}</td>
      <td>{formatTimestamp(conversation.started_at)}</td>
      <td>{conversation.ended_at ? formatTimestamp(conversation.ended_at) : 'open'}</td>
    </tr>
  );
}

function SectionTable({
  label,
  columns,
  count,
  emptyText,
  unavailableReason,
  children,
}: {
  label: string;
  columns: string[];
  count: number;
  emptyText: string;
  unavailableReason?: string | null;
  children?: ComponentChildren;
}): JSX.Element {
  const [expanded, setExpanded] = useState(true);
  return (
    <CollapsiblePanel
      className="session-overview__section"
      title={label}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {unavailableReason ? (
        <p className="session-overview__unavailable">Unavailable: {unavailableReason}</p>
      ) : count === 0 ? (
        <p className="text-muted">{emptyText}</p>
      ) : (
        <div className="session-overview__table-wrap">
          <table className="session-overview__table">
            <thead>
              <tr>
                {columns.map((column) => <th key={column}>{column}</th>)}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </CollapsiblePanel>
  );
}

function sessionDisplayName(session: Record<string, unknown> | null): string {
  if (!session) return 'Session Overview';
  const task = sessionText(session, 'task');
  if (task) return task;
  const cwd = sessionText(session, 'cwd');
  if (cwd) return cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) || 'Session';
  const app = sessionText(session, 'app');
  return app ? `${app.charAt(0).toUpperCase()}${app.slice(1)} session` : 'Session';
}

function ProviderIssueRow({ issue }: { issue: ProviderScopedLinkedIssue }): JSX.Element {
  const shortId = issue.short_id || issue.issue_id.slice(0, 7);
  const resourceRef = `issue:${shortId}`;
  return (
    <tr>
      <td>
        <a data-resource-ref={resourceRef} href={resourceRefHref(resourceRef)}>{shortId}</a>
      </td>
      <td className="session-overview__cell-grow">{issue.title}</td>
      <td>
        <span className={`session-overview-badge session-overview-badge--${issue.status}`}>
          {issue.status}
        </span>
      </td>
      <td>{issue.work_unit_ids.length}</td>
    </tr>
  );
}

function SessionPicker({
  onSelect,
  onErrorChange,
}: {
  onSelect: (sessionId: string) => void;
  onErrorChange: (error: string | null) => void;
}): JSX.Element {
  const registerInitialRouteLoad = useRegisterInitialRouteLoad();
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const initialLoad = getSessions<SessionRecord>()
      .then((rows) => {
        if (!cancelled) {
          setSessions(rows);
          onErrorChange(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load sessions';
          setError(message);
          onErrorChange(message);
        }
      });
    registerInitialRouteLoad(initialLoad);
    return () => {
      cancelled = true;
      onErrorChange(null);
    };
  }, [onErrorChange, registerInitialRouteLoad]);

  if (error) return <p className="text-muted">Sessions unavailable.</p>;
  if (sessions === null) return <p className="text-muted">Loading sessions…</p>;
  if (sessions.length === 0) return <p className="text-muted">No sessions registered.</p>;

  return (
    <ul className="session-overview__picker" aria-label="Session picker">
      {sessions.map((session) => {
        const id = session.id ?? session.session_id ?? '';
        if (!id) return null;
        return (
          <li key={id}>
            <button type="button" onClick={() => onSelect(id)}>
              <span className="session-overview__picker-id">{shortUuid(id)}</span>
              <span className="session-overview__picker-app">{session.app ?? '?'}</span>
              <span className={`session-overview-badge session-overview-badge--${session.status ?? 'unknown'}`}>
                {session.status ?? '?'}
              </span>
              <span className="session-overview__picker-task">
                {session.task ?? session.branch ?? session.cwd ?? ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SessionOverviewView({
  initialSessionId,
  agentBinding,
  embedded = false,
  managedConversation,
}: SessionOverviewViewProps): JSX.Element {
  const registerInitialRouteLoad = useRegisterInitialRouteLoad();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSessionId);
  const [binding, setBinding] = useState<BindingState>({ kind: 'none' });
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [overview, setOverview] = useState<SessionOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [providerOverview, setProviderOverview] = useState<ProviderScopedOverview | null>(null);
  const [providerOverviewError, setProviderOverviewError] = useState<string | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const scrollOwnerRef = useRef<HTMLDivElement>(null);
  const resolvedBindingRef = useRef<string | null>(null);

  // Deep-link/param changes (e.g. clicking a child session row) win over the
  // in-memory selection.
  useEffect(() => {
    if (initialSessionId && initialSessionId !== selectedSessionId) {
      setSelectedSessionId(initialSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  const managedBindingRefresh = managedConversation ? refreshToken : 0;
  const bindingProvider = managedConversation?.conversation.source;

  // Resolve the page-local agent binding only when no explicit session
  // selection exists. Provider-neutral, and the binding may be a full id or a
  // short prefix. Zero/one/many are surfaced honestly — only exactly one
  // bindable match auto-selects.
  useEffect(() => {
    if (initialSessionId) return;
    if (!agentBinding) {
      if (resolvedBindingRef.current) {
        resolvedBindingRef.current = null;
        setBinding({ kind: 'none' });
        setSelectedSessionId(null);
        setOverview(null);
        setProviderOverview(null);
      }
      return;
    }
    let cancelled = false;
    setBindingError(null);
    if (resolvedBindingRef.current !== agentBinding) {
      setBinding({ kind: 'resolving' });
      setSelectedSessionId(null);
      setOverview(null);
      setProviderOverview(null);
      resolvedBindingRef.current = agentBinding;
    }
    const initialLoad = resolveAgentSession(agentBinding, bindingProvider)
      .then((result) => {
        if (cancelled) return;
        const bindable = result.matches.filter((match) => match.mandible_session_id);
        if (result.truncated) {
          // Review C4 — a capped scan may hide further identities; never
          // auto-bind (or render a single provider-scoped view) from it.
          setBinding({ kind: 'many', matches: result.matches, truncated: true });
        } else if (result.matches.length === 0) {
          setBinding({ kind: 'zero' });
        } else if (result.matches.length === 1 && bindable.length === 1) {
          setBinding({ kind: 'bound', match: bindable[0] });
          setSelectedSessionId(bindable[0].mandible_session_id);
          writeSessionParamToHash(bindable[0].mandible_session_id);
        } else if (result.matches.length === 1 && result.matches[0].conversation_id) {
          // One match known via its ingested transcript but with no registry
          // session row — render the provider-scoped overview instead of
          // dropping to the picker. Display/navigation-only, like binding.
          setBinding({ kind: 'provider-scoped', match: result.matches[0] });
        } else if (result.matches.length === 1) {
          // One match but no registry session or transcript behind it —
          // nothing to bind or render.
          setBinding({ kind: 'zero' });
        } else {
          setBinding({ kind: 'many', matches: result.matches });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBindingError(err instanceof Error ? err.message : 'Resolver request failed');
        setBinding((current) => current.kind === 'resolving' ? { kind: 'none' } : current);
      });
    registerInitialRouteLoad(initialLoad);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBinding, bindingProvider, managedBindingRefresh, registerInitialRouteLoad]);

  useEffect(() => {
    if (!selectedSessionId) {
      setOverview(null);
      setOverviewError(null);
      return;
    }
    let cancelled = false;
    setOverviewLoading(true);
    setOverviewError(null);
    const matchingAgentBinding = binding.kind === 'bound'
      && binding.match.mandible_session_id === selectedSessionId
      ? agentBinding
      : null;
    const initialLoad = getSessionOverview(selectedSessionId, matchingAgentBinding)
      .then((payload) => {
        if (cancelled) return;
        setOverview(payload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOverviewError(err instanceof Error ? err.message : 'Failed to load overview');
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    registerInitialRouteLoad(initialLoad);
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, agentBinding, binding, refreshToken, registerInitialRouteLoad]);

  // Local ledger state stays fresh without a user-operated refresh control.
  // Keep the last good snapshot visible while a background reconciliation runs.
  useEffect(() => {
    if ((embedded && !managedConversation) || typeof window === 'undefined') return undefined;
    const refreshVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (selectedSessionId) {
        invalidateApiGetCache(`/api/sessions/${encodeURIComponent(selectedSessionId)}/overview`);
      }
      setRefreshToken((token) => token + 1);
    };
    const interval = window.setInterval(refreshVisible, 15_000);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [embedded, Boolean(managedConversation), selectedSessionId]);

  // Provider-scoped overview: loaded only for the conversation-only binding
  // state, keyed on the full identity and provider the (possibly short)
  // binding resolved to server-side (review C2 — no hard-coded provider).
  // Read-only rendering.
  const providerScopedRef =
    binding.kind === 'provider-scoped' ? binding.match.matched_ref : null;
  const providerScopedProvider =
    binding.kind === 'provider-scoped' ? binding.match.provider : null;
  useEffect(() => {
    if (binding.kind !== 'provider-scoped' || !providerScopedRef || selectedSessionId) {
      setProviderOverview(null);
      setProviderOverviewError(null);
      return;
    }
    if (providerScopedProvider !== 'codex') {
      // The by-provider overview endpoint is codex-only today. Render the
      // honest unavailable state for other providers instead of presenting
      // their data as codex-scoped.
      setProviderOverview(null);
      setProviderOverviewError(managedConversation ? null :
        `Provider-scoped overview is not available for provider ${providerScopedProvider ?? 'unknown'} yet.`,
      );
      return;
    }
    let cancelled = false;
    setProviderOverviewError(null);
    const initialLoad = getProviderScopedOverview(providerScopedProvider, providerScopedRef)
      .then((payload) => {
        if (!cancelled) setProviderOverview(payload);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProviderOverviewError(
          err instanceof Error ? err.message : 'Failed to load provider-scoped overview',
        );
      });
    registerInitialRouteLoad(initialLoad);
    return () => {
      cancelled = true;
    };
  }, [binding.kind, providerScopedRef, providerScopedProvider, selectedSessionId, refreshToken, registerInitialRouteLoad]);

  const handleSelect = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    writeSessionParamToHash(sessionId);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedSessionId(null);
    writeSessionParamToHash(null);
  }, []);

  const session = overview?.session ?? null;
  const sessionId = session ? String(session.id ?? selectedSessionId ?? '') : selectedSessionId ?? '';
  const sharedHeader = !embedded && session ? (
    <DetailPaneHeader
      variant="standard"
      identity={{
        entityLabel: 'Session',
        displayRef: sessionText(session, 'app') ?? 'registered',
        canonicalRef: sessionId,
        copyRef: sessionId,
        copyLabel: 'Copy session id',
      }}
      title={sessionDisplayName(session)}
      status={(
        <span className={`session-overview-badge session-overview-badge--${String(session.status ?? 'unknown')}`}>
          {String(session.status ?? 'unknown') === 'active' ? 'running' : String(session.status ?? 'unknown')}
        </span>
      )}
      actions={(
        <details className="session-overview__menu">
          <summary aria-label="Session actions" title="Session actions">•••</summary>
          <div role="menu" className="app-anchored-menu session-overview__menu-items">
            <button type="button" role="menuitem" onClick={() => setMetadataOpen(true)}>Show metadata</button>
            <button type="button" role="menuitem" onClick={handleClearSelection}>Change session</button>
          </div>
        </details>
      )}
      actionsLabel="Session actions"
      secondaryMetadata={(
        <dl className="session-overview__facts">
          <div><dt>App</dt><dd>{sessionText(session, 'app') ?? '—'}</dd></div>
          <div><dt>Branch</dt><dd>{sessionText(session, 'branch') ?? '—'}</dd></div>
          <div><dt>Cwd</dt><dd className="session-overview__path">{sessionText(session, 'cwd') ?? '—'}</dd></div>
          <div><dt>Created</dt><dd>{formatTimestamp(session.created_at)}</dd></div>
          <div><dt>Last message</dt><dd>{formatTimestamp(session.last_active)}</dd></div>
        </dl>
      )}
    />
  ) : !embedded ? <DetailPaneHeader variant="compact" title="Session Overview" /> : null;

  return (
    <div ref={scrollOwnerRef} className={`view session-overview${embedded ? ' session-overview--embedded' : ''}`}>
      {sharedHeader}
      {managedConversation ? <ManagedConversationFacts {...managedConversation} /> : null}
      <AppOperationalNoticeOutlet registerAsMain={!embedded} />
      {(bindingError || providerOverviewError || overviewError || pickerError) ? (
        <DetailPaneNotice severity="error" density="compact" title="Session overview unavailable">
          {bindingError ?? providerOverviewError ?? overviewError ?? pickerError}
        </DetailPaneNotice>
      ) : null}
      <DetailPaneModal
        open={!embedded && metadataOpen}
        onClose={() => setMetadataOpen(false)}
        titleId="session-overview-metadata-title"
        title="Session metadata"
        closeLabel="Close session metadata"
        embeddedFallback={{ scrollOwnerRef }}
      >
        <dl className="session-overview__metadata">
          <div><dt>Session id</dt><dd>{sessionId || '—'}</dd></div>
          <div><dt>Agent binding</dt><dd>{agentBinding ?? '—'}</dd></div>
          <div><dt>Provider session</dt><dd>{session ? sessionText(session, 'provider_session_id') ?? '—' : '—'}</dd></div>
        </dl>
      </DetailPaneModal>

      {!managedConversation && agentBinding && binding.kind !== 'bound' && binding.kind !== 'provider-scoped' ? (
        <div className="session-overview__binding" role="status">
          {binding.kind === 'resolving' && (
            <span>Resolving agent session {shortUuid(agentBinding)}…</span>
          )}
          {binding.kind === 'zero' && (
            <span>
              No Mandible session matches agent session <code>{shortUuid(agentBinding)}</code>.
              Pick a session below.
            </span>
          )}
          {binding.kind === 'many' && (
            <span>
              {binding.truncated ? (
                <>
                  Agent session <code>{shortUuid(agentBinding)}</code> matches too many
                  identities to resolve uniquely — use a longer id or pick one explicitly.
                </>
              ) : (
                <>
                  Agent session <code>{shortUuid(agentBinding)}</code> matches multiple Mandible
                  sessions — pick one explicitly.
                </>
              )}
            </span>
          )}
        </div>
      ) : null}

      {binding.kind === 'many' && !selectedSessionId ? (
        <ul className="session-overview__picker" aria-label="Agent session matches">
          {binding.matches.map((match, index) => {
            const matchId = match.mandible_session_id ?? match.matched_ref;
            const peerIds = binding.matches.map((candidate) => (
              candidate.mandible_session_id ?? candidate.matched_ref
            ));
            return (
            <li key={`${match.mandible_session_id ?? match.console_session_id ?? index}`}>
              <button
                type="button"
                disabled={!match.mandible_session_id}
                onClick={() => {
                  if (match.mandible_session_id) handleSelect(match.mandible_session_id);
                }}
              >
                <span className="session-overview__picker-id">
                  {match.mandible_session_id
                    ? distinctSessionRef(matchId, peerIds)
                    : 'no registry session'}
                </span>
                <span className="session-overview__picker-task">
                  {match.sources.join(', ')}
                  {match.console_session_id ? ` · console ${shortUuid(match.console_session_id)}` : ''}
                </span>
              </button>
            </li>
            );
          })}
        </ul>
      ) : null}

      {!selectedSessionId && binding.kind === 'provider-scoped' ? (
        <div className="session-overview__body">
          {!managedConversation && !providerOverview && !providerOverviewError ? (
            <p className="text-muted">Loading provider-scoped overview…</p>
          ) : null}
          {providerOverview ? (
            <>
              <SectionTable
                label="Linked issues"
                columns={['Issue', 'Title', 'Status', 'Work units']}
                count={providerOverview.linked_issues.items.length}
                emptyText="No issues reachable via provider-matched work units."
              >
                {providerOverview.linked_issues.items.map((issue) => (
                  <ProviderIssueRow key={issue.issue_id} issue={issue} />
                ))}
              </SectionTable>
              <p className="text-muted">{providerOverview.linked_issues.note}</p>

              <SectionTable
                label="Work units"
                columns={['Issue', 'Repo', 'Branch', 'State', 'Kind', 'Created']}
                count={providerOverview.work_units.items.length}
                emptyText="No work units matched this agent session id."
              >
                {providerOverview.work_units.items.map((unit) => (
                  <WorkUnitRow key={unit.id} unit={unit} />
                ))}
              </SectionTable>

              <SectionTable
                label="Child sessions"
                columns={['Session', 'App', 'Status', 'Task', 'Depth', 'Last active']}
                count={0}
                emptyText=""
                unavailableReason={providerOverview.children.reason}
              />

              <SectionTable
                label="Conversations"
                columns={['Conversation', 'Source', 'Blocks', 'Started', 'Ended']}
                count={providerOverview.conversations.items.length}
                emptyText="No indexed conversations for this agent session."
              >
                {providerOverview.conversations.items.map((conversation) => (
                  <ConversationRow key={conversation.id} conversation={conversation} />
                ))}
              </SectionTable>
            </>
          ) : null}
        </div>
      ) : !selectedSessionId && (binding.kind === 'many' || binding.kind === 'resolving') ? null
      : !selectedSessionId && managedConversation ? null
      : !selectedSessionId ? (
        <SessionPicker onSelect={handleSelect} onErrorChange={setPickerError} />
      ) : (
        <div className="session-overview__body">
          {overviewLoading && !overview && !managedConversation ? <p className="text-muted">Loading overview…</p> : null}
          {session ? (
            <>
              {embedded ? <section className="session-overview__section" aria-label="Session">
                <dl className="session-overview__facts">
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <span className={`session-overview-badge session-overview-badge--${String(session.status ?? 'unknown')}`}>
                        {String(session.status ?? 'unknown')}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>App</dt>
                    <dd>{sessionText(session, 'app') ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>{sessionText(session, 'branch') ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Cwd</dt>
                    <dd className="session-overview__path">{sessionText(session, 'cwd') ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatTimestamp(session.created_at)}</dd>
                  </div>
                  <div>
                    <dt>Last message</dt>
                    <dd>{formatTimestamp(session.last_active)}</dd>
                  </div>
                  {sessionText(session, 'task') ? (
                    <div className="session-overview__facts-wide">
                      <dt>Task</dt>
                      <dd>{sessionText(session, 'task')}</dd>
                    </div>
                  ) : null}
                </dl>
              </section> : null}

              {overview ? (
                <>
                  <SectionTable
                    label="Linked issues"
                    columns={['Issue', 'Title', 'Status', 'Link', 'Last seen']}
                    count={overview.linked_issues.items.length}
                    emptyText="No explicit ledger issue links for this session."
                  >
                    {overview.linked_issues.items.map((issue) => (
                      <IssueRow key={`${issue.issue_id}:${issue.link_type}`} issue={issue} />
                    ))}
                  </SectionTable>

                  <SectionTable
                    label="Work units"
                    columns={['Issue', 'Repo', 'Branch', 'State', 'Kind', 'Created']}
                    count={overview.work_units.items.length}
                    emptyText="No work units assigned to this session or its descendants."
                  >
                    {overview.work_units.items.map((unit) => (
                      <WorkUnitRow key={unit.id} unit={unit} />
                    ))}
                  </SectionTable>

                  <SectionTable
                    label="Child sessions"
                    columns={['Session', 'App', 'Status', 'Task', 'Depth', 'Last active']}
                    count={overview.children.items.length}
                    emptyText="No child sessions recorded."
                    unavailableReason={overview.children.available ? null : overview.children.reason}
                  >
                    {overview.children.items.map((child) => (
                      <ChildRow key={child.id} child={child} />
                    ))}
                  </SectionTable>
                  {overview.children.truncated ? (
                    <p className="text-muted">
                      Child list truncated (depth limit {overview.children.depth_limit}, count limit{' '}
                      {overview.children.count_limit}).
                    </p>
                  ) : null}

                  <SectionTable
                    label="Conversations"
                    columns={['Conversation', 'Source', 'Blocks', 'Started', 'Ended']}
                    count={overview.conversations.items.length}
                    emptyText="No indexed conversations for this session."
                  >
                    {overview.conversations.items.map((conversation) => (
                      <ConversationRow key={conversation.id} conversation={conversation} />
                    ))}
                  </SectionTable>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
