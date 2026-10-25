import { formatSessionExecution } from "../../../src/session-execution-format";
import { acquireSharedSse } from "../sse-shared";
// Session Overview: one page per agent session, for every provider. The page
// is keyed on any session alias (a provider session id, a Claude subagent id,
// a `sessions.id`, a console session id) or a prefix of one: the explicit
// #/overview?session=<ref> selection, else the tab-local agent_session
// binding. A prefix naming several sessions lists them to pick from. The
// binding is display/navigation-only: it is never attached to a mutation.
import { CONVERSATION_SOURCE_TO_PROVIDER } from '../../../src/provider-identities';
import { chatControlFailureNotice } from '../chat/ChatFailureNotice';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AppOperationalNoticeOutlet, useLiveLoad, useRouteLoad } from '../app-shell';
import { refreshAbandoned } from '../lib/coalesced-refresh';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import {
  ApiError,
  getSessionOverview,
  getSessions,
  invalidateApiGetCache,
  type SessionDescendant,
  type Conversation,
  type ConversationControlSnapshot,
  type ConversationSpawnReceipt,
  type SessionOverview,
  type SessionOverviewAmbiguous,
  type SessionOverviewConversation,
  type SessionOverviewLinkedIssue,
  type SessionOverviewWorkUnit,
  type SessionSummary,
} from '../api';
import { parseRouteFromHash, replaceRouteHash, routeHashWithParams, shortRouteId } from '../routing';
import { resourceRefHref } from '../resource-refs';
import type { SessionRecord } from '../types/session';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';

export type ManagedConversationOverview = {
  conversation: Pick<Conversation, 'id' | 'title' | 'source' | 'cwd' | 'branch' | 'model' | 'started_at'> & { source_path?: string };
  control: ConversationControlSnapshot | null;
  spawn: ConversationSpawnReceipt | null;
};

function ManagedConversationFacts({ conversation, control, spawn }: ManagedConversationOverview): JSX.Element {
  const provider = CONVERSATION_SOURCE_TO_PROVIDER[conversation.source] ?? conversation.source;
  const matchingControl = control?.conversation_id === conversation.id ? control : null;
  const failure = spawn?.error?.message ?? (
    matchingControl?.turn.kind === 'failed' ? chatControlFailureNotice(matchingControl.turn.error).detail
      : matchingControl?.controller.kind === 'failed' ? chatControlFailureNotice(matchingControl.controller.error).detail
        : null
  );
  const status = spawn?.state === 'failed' ? 'Failed'
    : spawn && (spawn.state === 'reserved' || spawn.state === 'starting') && (!matchingControl || matchingControl.turn.kind === 'none') ? spawn.state
    : matchingControl ? matchingControl.turn.kind === 'none' ? matchingControl.controller.kind : matchingControl.turn.kind
      : spawn?.state ?? null;
  return (
    <section className="session-overview__section" aria-label="Conversation">
      <dl className="session-overview__facts">
        <div className="session-overview__facts-wide"><dt>Conversation</dt><dd>{conversation.title}</dd></div>
        <div><dt>Provider</dt><dd>{provider}</dd></div>
        {status ? <div><dt>Status</dt><dd>{status}</dd></div> : null}
        {conversation.model ? <div><dt>{conversation.source_path?.startsWith('mandible://') ? 'Requested model' : 'Recorded model'}</dt><dd>{conversation.model}</dd></div> : null}
        {conversation.branch ? <div><dt>Branch</dt><dd>{overviewBranch(conversation.branch)}</dd></div> : null}
        {conversation.cwd ? <div className="session-overview__facts-wide"><dt>Cwd</dt><dd className="session-overview__path">{conversation.cwd}</dd></div> : null}
        <div><dt>Started</dt><dd>{formatTimestamp(conversation.started_at)}</dd></div>
        {failure ? <div className="session-overview__facts-wide" role="alert"><dt>Failure</dt><dd>{failure}</dd></div> : null}
      </dl>
    </section>
  );
}
type OverviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'resolved'; overview: SessionOverview }
  | { kind: 'ambiguous'; result: SessionOverviewAmbiguous }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

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

function overviewBranch(branch: string | null): string {
  return branch === 'HEAD' ? 'No named branch recorded' : branch ?? '—';
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

/** Update the #/overview session param in place so refreshes keep the selection. */
function writeSessionParamToHash(sessionId: string | null): void {
  if (typeof window === 'undefined') return;
  if (parseRouteFromHash(window.location.hash).tab !== 'overview') return;
  replaceRouteHash(routeHashWithParams(window.location.hash, 'overview', { session: sessionId ? shortRouteId(sessionId) : null }));
}

function overviewHref(sessionId: string): string {
  return `#/overview?session=${encodeURIComponent(shortRouteId(sessionId))}`;
}

function ExecutionObservation({ session }: { session: SessionSummary }): JSX.Element {
  const observation = session.execution;
  const failure = observation?.state.kind === 'failure' ? observation.state.error : null;
  return <div>
    <span>{formatSessionExecution(observation)}</span>
    {observation && <small> · {observation.source} · {formatTimestamp(observation.observed_at)}</small>}
    {failure?.message && <div>{failure.message}</div>}
    {(failure?.details || failure?.data) && <details><summary>Error details</summary>
      {failure.details && <pre>{failure.details}</pre>}{failure.data && <pre>{JSON.stringify(failure.data, null, 2)}</pre>}
    </details>}
    {observation?.source === 'codex_hook' && <small>External Codex does not report API failures</small>}
  </div>;
}

function LivenessBadge({ liveness }: { liveness: SessionSummary['liveness'] }): JSX.Element {
  return <span className={`session-overview-badge session-overview-badge--${liveness}`}>{liveness}</span>;
}

function sessionLabel(session: SessionSummary): string {
  if (session.title) return session.title;
  if (session.cwd) return session.cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) || 'Session';
  return session.provider ? `${session.provider.charAt(0).toUpperCase()}${session.provider.slice(1)} session` : 'Session';
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

function ChildRow({ child }: { child: SessionDescendant }): JSX.Element {
  return (
    <tr>
      <td>
        <a href={overviewHref(child.id)}>{shortUuid(child.id)}</a>
      </td>
      <td>{child.provider ?? '—'}</td>
      <td><LivenessBadge liveness={child.liveness} /><ExecutionObservation session={child} /></td>
      <td className="session-overview__cell-grow">{child.agent ? `${child.agent} · ` : ''}{child.title ?? child.branch ?? '—'}</td>
      <td>{child.depth}</td>
      <td>{formatTimestamp(child.last_activity ?? child.started_at)}</td>
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
  children,
}: {
  label: string;
  columns: string[];
  count: number;
  emptyText: string;
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
      {count === 0 ? (
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

function SessionPicker({
  onSelect,
  onErrorChange,
}: {
  onSelect: (sessionId: string) => void;
  onErrorChange: (error: string | null) => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useRouteLoad((registerInitialRouteLoad) => {
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
  }, [onErrorChange]);

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

function SessionFacts({ session }: { session: SessionSummary }): JSX.Element {
  return (
    <dl className="session-overview__facts">
      <div><dt>Status</dt><dd><LivenessBadge liveness={session.liveness} /></dd></div>
      <div><dt>Execution</dt><dd><ExecutionObservation session={session} /></dd></div>
      <div><dt>Provider</dt><dd>{session.provider ?? '—'}</dd></div>
      <div><dt>Branch</dt><dd>{overviewBranch(session.branch)}</dd></div>
      <div><dt>Cwd</dt><dd className="session-overview__path">{session.cwd ?? '—'}</dd></div>
      <div><dt>Started</dt><dd>{formatTimestamp(session.started_at)}</dd></div>
      <div><dt>Last activity</dt><dd>{formatTimestamp(session.last_activity)}</dd></div>
      {session.agent ? <div><dt>Agent</dt><dd>{session.agent}</dd></div> : null}
      {session.process ? (
        <div><dt>Process</dt><dd>{session.process.status}{session.process.pid ? ` · pid ${session.process.pid}` : ''}</dd></div>
      ) : null}
    </dl>
  );
}

function OverviewSections({ overview }: { overview: SessionOverview }): JSX.Element {
  return (
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
        emptyText="No work units held by this session or its descendants."
      >
        {overview.work_units.items.map((unit) => (
          <WorkUnitRow key={unit.id} unit={unit} />
        ))}
      </SectionTable>

      <SectionTable
        label="Child sessions"
        columns={['Session', 'Provider', 'Status', 'Task', 'Depth', 'Last active']}
        count={overview.children.items.length}
        emptyText="No child sessions recorded."
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
  );
}

export function SessionOverviewView({
  initialSessionId,
  agentBinding,
  embedded = false,
  managedConversation,
}: SessionOverviewViewProps): JSX.Element {
  const routeRef = initialSessionId ?? agentBinding;
  const [selection, setSelection] = useState({ routeRef, value: routeRef });
  const selectedRef = selection.routeRef === routeRef ? selection.value : routeRef;
  const setSelectedRef = (value: string | null) => setSelection({ routeRef, value });
  const [result, setResult] = useState<{ ref: string | null; state: OverviewState; error?: string }>({ ref: null, state: { kind: 'idle' } });
  const state: OverviewState = result.ref === selectedRef ? result.state : selectedRef ? { kind: 'loading' } : { kind: 'idle' };
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const scrollOwnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelection((current) => current.routeRef === routeRef ? current : { routeRef, value: routeRef });
  }, [routeRef]);

  // One live load: on activation and selection change, every 15 s, on execution events and
  // window focus. The last good snapshot stays visible while a refresh runs.
  const loadedOverviewRef = useRef<string | null>(null);
  const refreshOverview = useLiveLoad((signal) => {
    if (!selectedRef) return undefined;
    const ref = selectedRef;
    if (loadedOverviewRef.current === ref) invalidateApiGetCache(`/api/sessions/${encodeURIComponent(ref)}/overview`);
    loadedOverviewRef.current = ref;
    const setState = (state: OverviewState) => setResult({ ref, state });
    setResult((current) => current.ref === ref && current.state.kind === 'resolved'
      ? current : { ref, state: { kind: 'loading' } });
    return getSessionOverview(ref, signal)
      .then((payload) => {
        if (signal.aborted) return;
        if (payload.status === 'ambiguous') {
          setState({ kind: 'ambiguous', result: payload });
          return;
        }
        setState({ kind: 'resolved', overview: payload });
        if (!embedded && !initialSessionId) writeSessionParamToHash(payload.session.id);
      })
      .catch((err: unknown) => {
        if (refreshAbandoned(signal)) return;
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'not-found' });
        else {
          const message = err instanceof Error ? err.message : 'Failed to load overview';
          setResult((current) => current.ref === ref && current.state.kind === 'resolved'
            ? { ...current, error: message }
            : { ref, state: { kind: 'error', message } });
        }
      });
  }, [selectedRef, embedded, initialSessionId], 15_000);
  useEffect(() => {
    const events = acquireSharedSse();
    events.on("session:execution-updated", refreshOverview);
    events.connect();
    window.addEventListener('focus', refreshOverview);
    return () => {
      events.close();
      window.removeEventListener('focus', refreshOverview);
    };
  }, [refreshOverview]);

  const handleSelect = useCallback((sessionId: string) => {
    setSelectedRef(sessionId);
    writeSessionParamToHash(sessionId);
  }, [routeRef]);

  const handleClearSelection = useCallback(() => {
    setSelectedRef(null);
    writeSessionParamToHash(null);
  }, [routeRef]);

  const session = state.kind === 'resolved' ? state.overview.session : null;
  const sharedHeader = !embedded && session ? (
    <DetailPaneHeader
      variant="standard"
      identity={{
        entityLabel: 'Session',
        displayRef: session.provider ?? 'session',
        canonicalRef: session.id,
        copyRef: session.id,
        copyLabel: 'Copy session id',
      }}
      title={sessionLabel(session)}
      status={<><LivenessBadge liveness={session.liveness} /><ExecutionObservation session={session} /></>}
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
      secondaryMetadata={<SessionFacts session={session} />}
    />
  ) : !embedded ? <DetailPaneHeader variant="compact" title="Session Overview" /> : null;

  const errorMessage = state.kind === 'error' ? state.message : (result.ref === selectedRef ? result.error : null) ?? pickerError;

  return (
    <div ref={scrollOwnerRef} className={`view session-overview${embedded ? ' session-overview--embedded' : ''}`}>
      {sharedHeader}
      {managedConversation ? <ManagedConversationFacts {...managedConversation} /> : null}
      <AppOperationalNoticeOutlet registerAsMain={!embedded} />
      {errorMessage ? (
        <DetailPaneNotice severity="error" density="compact" title="Session overview unavailable">
          {errorMessage}
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
          <div><dt>Session id</dt><dd>{session?.id ?? '—'}</dd></div>
          <div><dt>Agent binding</dt><dd>{agentBinding ?? '—'}</dd></div>
          <div><dt>Process session</dt><dd>{session?.process?.id ?? '—'}</dd></div>
          <div><dt>Conversation</dt><dd>{session?.conversation_id ?? '—'}</dd></div>
        </dl>
      </DetailPaneModal>

      {!managedConversation && selectedRef && state.kind === 'not-found' ? (
        <div className="session-overview__binding" role="status">
          No session matches <code>{shortUuid(selectedRef)}</code>.
        </div>
      ) : null}

      {selectedRef && state.kind === 'ambiguous' ? (
        <>
          <div className="session-overview__binding" role="status">
            {state.result.truncated
              ? <>Session <code>{shortUuid(selectedRef)}</code> matches too many sessions to list; use a longer id.</>
              : <>Session <code>{shortUuid(selectedRef)}</code> matches several sessions; pick one.</>}
          </div>
          <ul className="session-overview__picker" aria-label="Matching sessions">
            {state.result.candidates.map((candidate) => (
              <li key={candidate.id}>
                <button type="button" onClick={() => handleSelect(candidate.id)}>
                  <span className="session-overview__picker-id">{shortUuid(candidate.id)}</span>
                  <span className="session-overview__picker-app">{candidate.provider ?? '?'}</span>
                  <LivenessBadge liveness={candidate.liveness} />
                  <span className="session-overview__picker-task">{candidate.title ?? candidate.cwd ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {!managedConversation && (!selectedRef || (state.kind === 'not-found' && !embedded)) ? (
        <SessionPicker onSelect={handleSelect} onErrorChange={setPickerError} />
      ) : (
        <div className="session-overview__body">
          {state.kind === 'loading' && !managedConversation ? <p className="text-muted">Loading overview…</p> : null}
          {state.kind === 'resolved' ? (
            <>
              {embedded && !managedConversation ? (
                <section className="session-overview__section" aria-label="Session">
                  <SessionFacts session={state.overview.session} />
                </section>
              ) : null}
              <OverviewSections overview={state.overview} />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
