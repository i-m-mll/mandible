// Briefing view — umbrella 99b74d6, lane d304a9b.
//
// The Briefing is a review queue over agent-produced findings. Its whole reason
// to exist is that a human can trust what it says, so the page is built around
// three rules:
//
//  1. DETERMINISTIC FACTS FIRST. The source-health strip is rendered above
//     anything a model wrote, from batch/ingest facts only. It is nearly
//     invisible when every source is current and auto-expands when it is not.
//     "No findings" while a collector failed is NOT a successful empty
//     briefing, and the empty state says so in those words.
//  2. MODEL OUTPUT IS LABELLED AND UNTRUSTED. The digest headline carries an
//     explicit agent-generated label. Every model-derived string (`title`,
//     `why_notable`, `refs`) is rendered as a text node — never as HTML — and a
//     ref becomes a link only when it is an http(s) URL or a recognized
//     internal resource ref (ui/src/resource-refs.ts). Anything else renders as
//     inert text.
//  3. JUDGING IS CHEAP AND REVERSIBLE. j/k moves, y keeps, n dismisses, u
//     undoes; every decision raises an undo toast. Judged items leave the
//     default view immediately and stay reachable behind the Judged filter.
//
// Server contract: "Briefing pilot — integration contract v1" §4, implemented
// by lane ce22a3a. This view is a pure client of the queue/history/decision/
// comment routes and of the server-authoritative `briefing` badge count; it
// never derives the badge itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getAgentDispatchEvents,
  getBriefingHistory,
  getBriefingQueue,
  postBriefingComment,
  postBriefingDecision,
  type BriefingCommentResult,
  type BriefingHistory,
  type BriefingJudgeAction,
  type BriefingQueue,
  type BriefingQueueItem,
  type BriefingRevision,
  type BriefingSourceHealth,
  type BriefingSourceStatus,
  type AgentDispatchEvent,
  type InstanceInfo,
} from '../api';
import { AgentDispatchDialog } from '../components/agent-dispatch/AgentDispatchDialog';
import { useAppShell } from '../app-shell';
import { useKeyedAsyncDetail } from '../hooks/useKeyedAsyncDetail';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { PreviewDisabledNotice } from '../components/shared/PreviewDisabledNotice';
import {
  artifactDetailHref,
  compactCommentRef,
  compactIssueRef,
  displayResourceRef,
  parseResourceRef,
} from '../resource-refs';

/** Honest truncation limit: the queue shows the top N and counts the rest. */
export const BRIEFING_VISIBLE_LIMIT = 25;

/** Poll cadence while the route is the visible one. Hidden routes never poll. */
export const BRIEFING_POLL_INTERVAL_MS = 60_000;

const UNDO_TOAST_MS = 12_000;

const VIEW_STATE_KEY = 'mandible.briefing.viewState:v1';

export type BriefingFilter = 'pending' | 'judged';

type BriefingViewState = {
  filter: BriefingFilter;
  /** null = follow the deterministic default (open only when unhealthy). */
  healthOpen: boolean | null;
  expandedCandidateId: string | null;
};

const DEFAULT_VIEW_STATE: BriefingViewState = {
  filter: 'pending',
  healthOpen: null,
  expandedCandidateId: null,
};

function normalizeViewState(value: unknown, defaults: Readonly<BriefingViewState>): BriefingViewState {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const filter = row.filter === 'judged' ? 'judged' : defaults.filter;
  const healthOpen = typeof row.healthOpen === 'boolean' ? row.healthOpen : null;
  const expandedCandidateId =
    typeof row.expandedCandidateId === 'string' && row.expandedCandidateId
      ? row.expandedCandidateId
      : null;
  return { filter, healthOpen, expandedCandidateId };
}

/** A decision taken in this page session, kept so it can be undone and listed. */
type JudgedEntry = {
  item: BriefingQueueItem;
  action: Exclude<BriefingJudgeAction, 'undo'>;
  decidedAt: number;
};

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  initialFilter?: string;
  initialCandidateId?: string | null;
  /** Test seam: inject a fixed clock so relative ages are deterministic. */
  nowMs?: number;
};

// --- formatting --------------------------------------------------------------

export function formatBriefingAge(timestampMs: number | null, now: number): string {
  if (timestampMs === null || !Number.isFinite(timestampMs)) return 'age unknown';
  const delta = now - timestampMs;
  if (delta < 0) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function parseTimestamp(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The moment a finding's evidence was collected, falling back to ingest time. */
export function revisionTimestamp(revision: BriefingRevision): number | null {
  return parseTimestamp(revision.captured_at) ?? revision.ingested_at ?? null;
}

function shortHash(value: string, length = 12): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

const SOURCE_STATUS_LABEL: Record<BriefingSourceStatus, string> = {
  current: 'current',
  stale: 'stale',
  failed: 'failed',
  unknown: 'unknown',
};

// --- ref linkification (allowlist) ------------------------------------------

export type BriefingRefLink = {
  href: string;
  label: string;
  external: boolean;
};

/**
 * Decide whether a model-supplied ref may become a link.
 *
 * ALLOWLIST ONLY: http(s) URLs, and the internal resource-ref forms the shared
 * parser recognizes (issue / comment / artifact). Everything else — including
 * `javascript:`, `data:`, `file:`, bare text, and resource-ref-shaped strings
 * the parser classifies as unknown — returns null and is rendered as inert
 * text by {@link BriefingRef}.
 */
export function briefingRefLink(rawRef: string): BriefingRefLink | null {
  const ref = (rawRef ?? '').trim();
  if (!ref) return null;

  const parsed = parseResourceRef(ref);
  if (parsed) {
    if (parsed.kind === 'issue') {
      const id = ref.replace(/^issue:/i, '').split('/').pop() ?? '';
      if (!id) return null;
      return {
        href: `#/issues?issue=${encodeURIComponent(id)}`,
        label: compactIssueRef(ref),
        external: false,
      };
    }
    if (parsed.kind === 'comment') {
      const body = ref.replace(/^comment:/i, '');
      const [issuePart, commentPart] = body.split('#');
      const issueId = (issuePart ?? '').split('/').pop() ?? '';
      if (!issueId) return null;
      const query = new URLSearchParams({ issue: issueId });
      if (commentPart) query.set('comment', commentPart);
      return { href: `#/issues?${query.toString()}`, label: compactCommentRef(ref), external: false };
    }
    if (parsed.kind === 'artifact') {
      return { href: artifactDetailHref(ref), label: displayResourceRef(ref), external: false };
    }
    // repo://, mandible://, and unknown schemes have no safe in-app target here.
    return null;
  }

  if (!/^https?:\/\//i.test(ref)) return null;
  try {
    const url = new URL(ref);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { href: url.toString(), label: ref, external: true };
  } catch {
    return null;
  }
}

/** Render one model-supplied ref: a link when allowlisted, inert text otherwise. */
export function BriefingRef({ value }: { value: string }): JSX.Element {
  const link = briefingRefLink(value);
  if (!link) {
    return (
      <span className="briefing-ref briefing-ref--inert" title="Not a linkable reference">
        {value}
      </span>
    );
  }
  return (
    <a
      className="briefing-ref"
      href={link.href}
      {...(link.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      title={value}
    >
      {link.label}
    </a>
  );
}

// --- health ------------------------------------------------------------------

export type BriefingHealthSummary = {
  current: number;
  stale: number;
  failed: number;
  unknown: number;
  healthy: boolean;
};

/** Deterministic roll-up of the per-source health rows. No model input. */
export function summarizeBriefingHealth(sources: BriefingSourceHealth[]): BriefingHealthSummary {
  const summary = { current: 0, stale: 0, failed: 0, unknown: 0 };
  for (const source of sources) summary[source.status] += 1;
  return {
    ...summary,
    healthy: sources.length > 0 && summary.stale === 0 && summary.failed === 0 && summary.unknown === 0,
  };
}

function BriefingHealthStrip({
  sources,
  summary,
  cost,
  open,
  loading,
  onToggle,
}: {
  sources: BriefingSourceHealth[];
  summary: BriefingHealthSummary;
  cost: BriefingQueue['cost'];
  open: boolean;
  loading: boolean;
  onToggle(): void;
}): JSX.Element {
  const now = Date.now();
  // "Healthy" is claimed only when sources actually reported as current. An
  // empty source list is unknown, not clean — and while the first read is still
  // in flight the strip stays neutral rather than flashing a false verdict.
  const state = loading
    ? 'loading'
    : summary.failed > 0
      ? 'failed'
      : summary.stale > 0 || summary.unknown > 0 || sources.length === 0
        ? 'degraded'
        : 'healthy';
  return (
    <section
      className={`briefing-health briefing-health--${state}`}
      data-testid="briefing-health"
      data-health-state={state}
      aria-label="Source health"
    >
      <div className="briefing-health__bar">
        <button
          type="button"
          className="briefing-health__toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="briefing-health__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="briefing-health__headline">
            {sources.length === 0
              ? 'No collector sources reported'
              : `${sources.length} source${sources.length === 1 ? '' : 's'}`}
          </span>
        </button>
        <span className="briefing-health__counts">
          <span className="briefing-health__count briefing-health__count--current">
            {summary.current} current
          </span>
          {summary.stale > 0 ? (
            <span className="briefing-health__count briefing-health__count--stale">
              {summary.stale} stale
            </span>
          ) : null}
          {summary.failed > 0 ? (
            <span className="briefing-health__count briefing-health__count--failed">
              {summary.failed} failed
            </span>
          ) : null}
          {summary.unknown > 0 ? (
            <span className="briefing-health__count briefing-health__count--unknown">
              {summary.unknown} unknown
            </span>
          ) : null}
        </span>
        <span className="briefing-health__cost">
          {cost && cost.amount_usd !== null
            ? `$${cost.amount_usd.toFixed(2)}${cost.window_label ? ` · ${cost.window_label}` : ''}`
            : 'cost not reported'}
        </span>
      </div>
      {open ? (
        <ul className="briefing-health__list">
          {sources.length === 0 ? (
            <li className="briefing-health__row briefing-health__row--empty">
              No source has reported an ingest batch yet.
            </li>
          ) : null}
          {sources.map((source) => (
            <li
              key={source.source}
              className={`briefing-health__row briefing-health__row--${source.status}`}
            >
              <span className="briefing-health__source">{source.source}</span>
              <span className={`briefing-chip briefing-chip--${source.status}`}>
                {SOURCE_STATUS_LABEL[source.status]}
              </span>
              <span className="briefing-health__meta">
                last ingest {formatBriefingAge(source.last_ingest_at, now)}
              </span>
              <span className="briefing-health__meta">
                run {source.last_run_status ?? 'unreported'}
              </span>
              {source.pending_count !== null ? (
                <span className="briefing-health__meta">{source.pending_count} pending</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// --- digest headline ---------------------------------------------------------

function BriefingDigestHeadline({ digest }: { digest: BriefingQueue['digest'] }): JSX.Element {
  return (
    <section className="briefing-digest" data-testid="briefing-digest" aria-label="Digest headline">
      <span className="briefing-digest__label">Agent-generated summary</span>
      {digest && digest.headline ? (
        <p className="briefing-digest__text">{digest.headline}</p>
      ) : (
        <p className="briefing-digest__text briefing-digest__text--absent">
          No agent-generated headline was published for this briefing.
        </p>
      )}
      {digest && digest.series_ref ? (
        <p className="briefing-digest__provenance">
          <BriefingRef
            value={
              digest.version !== null
                ? `${digest.series_ref}@${digest.version}`
                : digest.series_ref
            }
          />
        </p>
      ) : null}
    </section>
  );
}

// --- row ---------------------------------------------------------------------

function BriefingProvenance({ item }: { item: BriefingQueueItem }): JSX.Element {
  const revision = item.revision;
  return (
    <div className="briefing-detail__provenance">
      <span className="briefing-chip briefing-chip--provenance">
        evidence: {revision.evidence_kind ?? 'unreported'}
      </span>
      {revision.evidence_hash ? (
        <span className="briefing-chip briefing-chip--provenance" title={revision.evidence_hash}>
          hash {shortHash(revision.evidence_hash)}
        </span>
      ) : null}
      {revision.run_id ? (
        <span className="briefing-chip briefing-chip--provenance" title={revision.run_id}>
          run {shortHash(revision.run_id, 10)}
        </span>
      ) : null}
      {revision.digest_version !== null ? (
        <span className="briefing-chip briefing-chip--provenance">
          digest v{revision.digest_version}
        </span>
      ) : null}
      {revision.batch_key ? (
        <span className="briefing-chip briefing-chip--provenance" title={revision.batch_key}>
          batch {shortHash(revision.batch_key, 10)}
        </span>
      ) : null}
      <span className="briefing-chip briefing-chip--provenance" title={item.candidate_key}>
        candidate {shortHash(item.candidate_key, 10)}
      </span>
    </div>
  );
}

function BriefingRowDetail({
  item,
  history,
  historyLoading,
  historyError,
  mutationsAllowed,
  onComment,
  onDispatched,
}: {
  item: BriefingQueueItem;
  history: BriefingHistory | null;
  historyLoading: boolean;
  historyError: string | null;
  mutationsAllowed: boolean;
  onComment(candidateId: string, body: string): Promise<void>;
  onDispatched(): void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  // Dispatch is deliberately a SEPARATE, non-default action on this editor:
  // `Save note` stays the form's submit button, so pressing Enter or clicking
  // through the obvious path can never start an agent.
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatches, setDispatches] = useState<AgentDispatchEvent[]>([]);
  const revision = item.revision;

  // The recorded dispatch chain for this finding, so a reload still shows the
  // handle (or the failure) rather than only the in-page result.
  useEffect(() => {
    const controller = new AbortController();
    getAgentDispatchEvents({ candidateId: item.candidate_id }, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setDispatches(rows);
      })
      .catch(() => {
        // The audit list is supplementary; its absence must not break the row.
      });
    return () => controller.abort();
  }, [item.candidate_id]);

  const submitComment = async (event: Event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !mutationsAllowed || submitting) return;
    setSubmitting(true);
    setCommentError(null);
    try {
      await onComment(item.candidate_id, body);
      setDraft('');
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="briefing-detail" data-testid={`briefing-detail-${item.candidate_id}`}>
      <div className="briefing-detail__section">
        <h4 className="briefing-detail__heading">References</h4>
        {revision.refs.length === 0 && !revision.source_ref ? (
          <p className="briefing-detail__empty">This finding carried no references.</p>
        ) : (
          <ul className="briefing-detail__refs">
            {revision.source_ref ? (
              <li>
                <span className="briefing-detail__ref-role">source ref</span>
                <BriefingRef value={revision.source_ref} />
              </li>
            ) : null}
            {revision.refs.map((ref, index) => (
              <li key={`${ref}-${index}`}>
                <BriefingRef value={ref} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="briefing-detail__section">
        <h4 className="briefing-detail__heading">Provenance</h4>
        <BriefingProvenance item={item} />
      </div>

      <div className="briefing-detail__section">
        <h4 className="briefing-detail__heading">
          Occurrences ({item.occurrences.count})
        </h4>
        {historyLoading ? (
          <LoadingSkeleton variant="detail" label="Loading occurrence history" />
        ) : historyError ? (
          <p className="briefing-detail__error">History unavailable: {historyError}</p>
        ) : history && !history.available ? (
          <p className="briefing-detail__error">
            History unavailable{history.reason ? `: ${history.reason}` : '.'}
          </p>
        ) : history ? (
          <>
            <ul className="briefing-detail__occurrences">
              {history.occurrences.length === 0 ? (
                <li className="briefing-detail__empty">
                  No individual occurrence rows were returned.
                </li>
              ) : null}
              {history.occurrences.map((occurrence) => (
                <li key={occurrence.id}>
                  <span className="briefing-detail__occurrence-when">
                    {formatBriefingAge(occurrence.seen_at, Date.now())}
                  </span>
                  {occurrence.digest_version !== null ? (
                    <span className="briefing-chip briefing-chip--provenance">
                      digest v{occurrence.digest_version}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {history.revisions.length > 1 ? (
              <p className="briefing-detail__note">
                {history.revisions.length} revisions — new evidence re-pends a candidate once.
              </p>
            ) : null}
            {history.decisions.length > 0 ? (
              <ul className="briefing-detail__decisions">
                {history.decisions.map((decision) => (
                  <li key={decision.id}>
                    <span className={`briefing-chip briefing-chip--${decision.action}`}>
                      {decision.action}
                    </span>
                    <span className="briefing-detail__occurrence-when">
                      {formatBriefingAge(decision.created_at, Date.now())}
                    </span>
                    <span className="briefing-detail__actor">
                      {decision.actor_user_id ? decision.actor_user_id : 'system'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {history.comments.length > 0 ? (
              <ul className="briefing-detail__comments">
                {history.comments.map((comment) => (
                  <li key={comment.id}>
                    <span className="briefing-detail__actor">
                      {comment.actor_user_id ?? 'unknown'}
                    </span>
                    <span className="briefing-detail__comment-body">{comment.body}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="briefing-detail__empty">History not loaded.</p>
        )}
      </div>

      <form className="briefing-detail__comment" onSubmit={submitComment}>
        <label className="briefing-detail__heading" htmlFor={`briefing-comment-${item.candidate_id}`}>
          Add a note
        </label>
        <textarea
          id={`briefing-comment-${item.candidate_id}`}
          className="briefing-detail__comment-input"
          value={draft}
          rows={2}
          disabled={!mutationsAllowed || submitting}
          onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
        />
        <div className="briefing-detail__comment-actions">
          <button
            type="submit"
            className="briefing-button"
            disabled={!mutationsAllowed || submitting || draft.trim() === ''}
          >
            {submitting ? 'Saving…' : 'Save note'}
          </button>
          <button
            type="button"
            className="briefing-button briefing-button--dispatch"
            disabled={!mutationsAllowed || submitting || draft.trim() === ''}
            title={
              mutationsAllowed
                ? 'Save this note and start an interactive agent on it (asks first)'
                : 'Read-only instance'
            }
            onClick={() => setDispatchOpen(true)}
          >
            Save and start agent…
          </button>
        </div>
        {commentError ? <p className="briefing-detail__error">{commentError}</p> : null}
      </form>

      {dispatches.length > 0 ? (
        <div className="briefing-detail__section" data-testid={`briefing-dispatches-${item.candidate_id}`}>
          <h4 className="briefing-detail__heading">Agent dispatches ({dispatches.length})</h4>
          <ul className="briefing-detail__dispatches">
            {dispatches.map((dispatch) => (
              <li key={dispatch.id}>
                <span className={`briefing-chip briefing-chip--${dispatch.status}`}>
                  {dispatch.status}
                </span>
                {dispatch.session_handle ? (
                  <code className="briefing-detail__dispatch-handle">{dispatch.session_handle}</code>
                ) : (
                  <span className="briefing-detail__error">
                    {dispatch.error ?? 'no session handle was reported'}
                  </span>
                )}
                <span className="briefing-detail__occurrence-when">
                  {formatBriefingAge(dispatch.created_at, Date.now())}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {dispatchOpen ? (
        <AgentDispatchDialog
          subject={{ kind: 'finding', candidate_id: item.candidate_id }}
          instruction={draft.trim()}
          title="Start an agent on this finding"
          onClose={() => setDispatchOpen(false)}
          onDispatched={(dispatchEvent) => {
            // The server stored the note as part of the dispatch, so the editor
            // is emptied here rather than by a second comment write.
            setDraft('');
            setDispatches((current) => [dispatchEvent, ...current]);
            onDispatched();
          }}
        />
      ) : null}
    </div>
  );
}

function BriefingRow({
  item,
  now,
  selected,
  expanded,
  busy,
  mutationsAllowed,
  onSelect,
  onToggleExpand,
  onJudge,
  detail,
}: {
  item: BriefingQueueItem;
  now: number;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  mutationsAllowed: boolean;
  onSelect(candidateId: string): void;
  onToggleExpand(candidateId: string): void;
  onJudge(item: BriefingQueueItem, action: Exclude<BriefingJudgeAction, 'undo'>): void;
  detail: JSX.Element | null;
}): JSX.Element {
  const revision = item.revision;
  const age = formatBriefingAge(revisionTimestamp(revision), now);
  return (
    <li
      className={`briefing-row${selected ? ' briefing-row--selected' : ''}`}
      data-testid={`briefing-row-${item.candidate_id}`}
      data-candidate-id={item.candidate_id}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="briefing-row__body">
        <button
          type="button"
          className="briefing-row__main"
          aria-expanded={expanded}
          onClick={() => {
            onSelect(item.candidate_id);
            onToggleExpand(item.candidate_id);
          }}
        >
          <span className="briefing-row__line briefing-row__line--primary">
            <span className="briefing-row__title">{revision.title || '(untitled finding)'}</span>
            <span className="briefing-chip briefing-chip--source">{item.source}</span>
            <span className="briefing-row__age">{age}</span>
            {item.occurrences.count > 1 ? (
              <span className="briefing-chip briefing-chip--repeat">
                seen {item.occurrences.count}×
              </span>
            ) : null}
            {item.state === 'expired_unreviewed' ? (
              <span className="briefing-chip briefing-chip--stale">expired unreviewed</span>
            ) : null}
          </span>
          <span className="briefing-row__line briefing-row__line--secondary">
            {revision.why_notable || 'No rationale was provided for this finding.'}
          </span>
        </button>
        <div className="briefing-row__actions">
          <button
            type="button"
            className="briefing-button briefing-button--keep"
            disabled={!mutationsAllowed || busy}
            title={mutationsAllowed ? 'Keep (y)' : 'Read-only instance'}
            onClick={() => onJudge(item, 'keep')}
          >
            Keep
          </button>
          <button
            type="button"
            className="briefing-button briefing-button--dismiss"
            disabled={!mutationsAllowed || busy}
            title={mutationsAllowed ? 'Dismiss (n)' : 'Read-only instance'}
            onClick={() => onJudge(item, 'dismiss')}
          >
            Dismiss
          </button>
        </div>
      </div>
      {expanded ? detail : null}
    </li>
  );
}

// --- view --------------------------------------------------------------------

type QueueState = {
  data: BriefingQueue | null;
  loading: boolean;
  error: string | null;
};

export function BriefingView({
  instance,
  initialFilter,
  initialCandidateId,
  nowMs,
}: BriefingViewProps): JSX.Element {
  // Keep-alive routes stay mounted when hidden. Everything with a heartbeat —
  // polling and the global key handler — is gated on this flag so a hidden
  // instance neither refetches nor steals keystrokes from the visible route.
  const { active } = useAppShell();
  const operationalMutationsAllowed = !instance || instance.operational_mutations === 'allow';

  const [viewState, setViewState] = usePersistedViewState<BriefingViewState>(
    VIEW_STATE_KEY,
    normalizeViewState,
    DEFAULT_VIEW_STATE,
  );
  const [queue, setQueue] = useState<QueueState>({ data: null, loading: true, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(initialCandidateId ?? null);
  const [judged, setJudged] = useState<JudgedEntry[]>([]);
  const [undoEntry, setUndoEntry] = useState<JudgedEntry | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => nowMs ?? Date.now());
  const [reloadNonce, setReloadNonce] = useState(0);

  // A `filter` deep-link param wins on first mount only. After that the
  // persisted user choice owns the filter: a later route re-render must not
  // silently reset a filter the operator changed by hand.
  const appliedInitialFilter = useRef(false);
  useEffect(() => {
    if (appliedInitialFilter.current) return;
    appliedInitialFilter.current = true;
    if (initialFilter === 'pending' || initialFilter === 'judged') {
      setViewState((current) => (current.filter === initialFilter ? current : { ...current, filter: initialFilter }));
    }
  }, [initialFilter, setViewState]);

  const filter = viewState.filter;
  const expandedId = viewState.expandedCandidateId;

  const loadQueue = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await getBriefingQueue(signal);
      if (signal.aborted) return;
      setQueue({ data, loading: false, error: null });
      setNow(nowMs ?? Date.now());
    } catch (error) {
      if (signal.aborted) return;
      setQueue((current) => ({
        data: current.data,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [nowMs]);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    void loadQueue(controller.signal);
    return () => controller.abort();
  }, [active, loadQueue, reloadNonce]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      setReloadNonce((current) => current + 1);
    }, BRIEFING_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  const loadHistory = useCallback(
    (signal: AbortSignal) => getBriefingHistory(expandedId ?? '', signal),
    [expandedId],
  );
  const history = useKeyedAsyncDetail<BriefingHistory>({
    requestKey: expandedId,
    namespace: 'briefing-history',
    load: loadHistory,
  });

  const judgedIds = useMemo(() => new Set(judged.map((entry) => entry.item.candidate_id)), [judged]);

  const pendingItems = useMemo(() => {
    const items = queue.data?.items ?? [];
    // A judged item leaves the default view immediately, before the next poll
    // confirms it server-side.
    const visible = items.filter((item) => !judgedIds.has(item.candidate_id));
    return [...visible].sort((left, right) => {
      const leftRank = left.revision.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.revision.rank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftAt = revisionTimestamp(left.revision) ?? 0;
      const rightAt = revisionTimestamp(right.revision) ?? 0;
      if (leftAt !== rightAt) return rightAt - leftAt;
      return left.candidate_id.localeCompare(right.candidate_id);
    });
  }, [queue.data, judgedIds]);

  const visibleItems = useMemo(
    () => pendingItems.slice(0, BRIEFING_VISIBLE_LIMIT),
    [pendingItems],
  );

  // Honest truncation: count against the server's pending total when it is
  // larger than what this page received, so a server-side cap is still visible.
  const serverPending = queue.data?.total_pending ?? pendingItems.length;
  const totalPending = Math.max(serverPending - judged.length, pendingItems.length);
  const hiddenPending = Math.max(totalPending - visibleItems.length, 0);

  const groups = useMemo(() => {
    const bySource = new Map<string, BriefingQueueItem[]>();
    for (const item of visibleItems) {
      const existing = bySource.get(item.source);
      if (existing) existing.push(item);
      else bySource.set(item.source, [item]);
    }
    return [...bySource.entries()].map(([source, items]) => ({ source, items }));
  }, [visibleItems]);

  const sources = queue.data?.sources ?? [];
  const healthSummary = useMemo(() => summarizeBriefingHealth(sources), [sources]);
  const healthOpen = viewState.healthOpen ?? !healthSummary.healthy;

  const setFilter = (next: BriefingFilter) => {
    setViewState((current) => ({ ...current, filter: next }));
  };
  const toggleHealth = () => {
    setViewState((current) => ({ ...current, healthOpen: !(current.healthOpen ?? !healthSummary.healthy) }));
  };
  const toggleExpand = useCallback((candidateId: string) => {
    setViewState((current) => ({
      ...current,
      expandedCandidateId: current.expandedCandidateId === candidateId ? null : candidateId,
    }));
  }, [setViewState]);

  // Keep a selection alive as rows come and go.
  useEffect(() => {
    if (visibleItems.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !visibleItems.some((item) => item.candidate_id === selectedId)) {
      setSelectedId(visibleItems[0].candidate_id);
    }
  }, [visibleItems, selectedId]);

  const judge = useCallback(
    async (item: BriefingQueueItem, action: Exclude<BriefingJudgeAction, 'undo'>) => {
      if (!operationalMutationsAllowed) return;
      setBusyIds((current) => (current.includes(item.candidate_id) ? current : [...current, item.candidate_id]));
      setActionError(null);
      try {
        await postBriefingDecision(item.candidate_id, action);
        const entry: JudgedEntry = { item, action, decidedAt: Date.now() };
        setJudged((current) => [entry, ...current.filter((row) => row.item.candidate_id !== item.candidate_id)]);
        setUndoEntry(entry);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyIds((current) => current.filter((id) => id !== item.candidate_id));
      }
    },
    [operationalMutationsAllowed],
  );

  const undo = useCallback(
    async (entry: JudgedEntry) => {
      if (!operationalMutationsAllowed) return;
      setActionError(null);
      try {
        await postBriefingDecision(entry.item.candidate_id, 'undo');
        setJudged((current) => current.filter((row) => row.item.candidate_id !== entry.item.candidate_id));
        setUndoEntry((current) => (current?.item.candidate_id === entry.item.candidate_id ? null : current));
        setSelectedId(entry.item.candidate_id);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [operationalMutationsAllowed],
  );

  const comment = useCallback(async (candidateId: string, body: string) => {
    if (!operationalMutationsAllowed) return;
    const result: BriefingCommentResult = await postBriefingComment(candidateId, body);
    if (!result.ok) throw new Error('The comment was not accepted.');
    history.refresh();
  }, [operationalMutationsAllowed, history]);

  useEffect(() => {
    if (!undoEntry) return undefined;
    const timer = window.setTimeout(() => setUndoEntry(null), UNDO_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [undoEntry]);

  // Keyboard triage. Only bound while this route is the visible one.
  useEffect(() => {
    if (!active) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      if (filter !== 'pending' || visibleItems.length === 0) {
        if (event.key === 'u' && undoEntry) {
          event.preventDefault();
          void undo(undoEntry);
        }
        return;
      }
      const index = Math.max(
        visibleItems.findIndex((item) => item.candidate_id === selectedId),
        0,
      );
      const current = visibleItems[index];
      switch (event.key) {
        case 'j': {
          event.preventDefault();
          const next = visibleItems[Math.min(index + 1, visibleItems.length - 1)];
          if (next) setSelectedId(next.candidate_id);
          break;
        }
        case 'k': {
          event.preventDefault();
          const previous = visibleItems[Math.max(index - 1, 0)];
          if (previous) setSelectedId(previous.candidate_id);
          break;
        }
        case 'o':
        case 'Enter': {
          event.preventDefault();
          if (current) toggleExpand(current.candidate_id);
          break;
        }
        case 'y': {
          if (!operationalMutationsAllowed || !current) return;
          event.preventDefault();
          void judge(current, 'keep');
          break;
        }
        case 'n': {
          if (!operationalMutationsAllowed || !current) return;
          event.preventDefault();
          void judge(current, 'dismiss');
          break;
        }
        case 'u': {
          if (!undoEntry) return;
          event.preventDefault();
          void undo(undoEntry);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    active,
    filter,
    visibleItems,
    selectedId,
    undoEntry,
    operationalMutationsAllowed,
    judge,
    undo,
    toggleExpand,
  ]);

  const queueUnavailable = queue.data !== null && !queue.data.available;
  const sourcesDegraded = healthSummary.failed > 0 || healthSummary.stale > 0 || healthSummary.unknown > 0;

  const renderDetail = (item: BriefingQueueItem): JSX.Element => (
    <BriefingRowDetail
      item={item}
      history={history.key === item.candidate_id ? history.data : null}
      historyLoading={history.key === item.candidate_id && history.loading}
      historyError={history.key === item.candidate_id ? history.error : null}
      mutationsAllowed={operationalMutationsAllowed}
      onComment={comment}
      onDispatched={history.refresh}
    />
  );

  return (
    <div className="briefing" data-testid="briefing-view">
      <BriefingHealthStrip
        sources={sources}
        summary={healthSummary}
        cost={queue.data?.cost ?? null}
        open={healthOpen}
        loading={queue.data === null && queue.loading}
        onToggle={toggleHealth}
      />

      <BriefingDigestHeadline digest={queue.data?.digest ?? null} />

      {!operationalMutationsAllowed ? (
        <PreviewDisabledNotice title="Read-only instance">
          Keep, dismiss, undo, and notes are disabled here. Decisions are recorded only on an
          instance that allows operational mutations.
        </PreviewDisabledNotice>
      ) : null}

      <div className="briefing-toolbar">
        <div className="briefing-toolbar__filters" role="group" aria-label="Briefing filter">
          <button
            type="button"
            className={`briefing-tab${filter === 'pending' ? ' briefing-tab--active' : ''}`}
            aria-pressed={filter === 'pending'}
            onClick={() => setFilter('pending')}
          >
            Pending{totalPending > 0 ? ` (${totalPending})` : ''}
          </button>
          <button
            type="button"
            className={`briefing-tab${filter === 'judged' ? ' briefing-tab--active' : ''}`}
            aria-pressed={filter === 'judged'}
            onClick={() => setFilter('judged')}
          >
            Judged{judged.length > 0 ? ` (${judged.length})` : ''}
          </button>
        </div>
        <p className="briefing-toolbar__keys">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>o</kbd> details · <kbd>y</kbd> keep ·{' '}
          <kbd>n</kbd> dismiss · <kbd>u</kbd> undo
        </p>
        <button
          type="button"
          className="briefing-button"
          onClick={() => setReloadNonce((current) => current + 1)}
        >
          Refresh
        </button>
      </div>

      {actionError ? (
        <p className="briefing-error" role="alert">{actionError}</p>
      ) : null}
      {queue.error ? (
        <p className="briefing-error" role="alert" data-testid="briefing-load-error">
          The briefing queue could not be loaded: {queue.error}
        </p>
      ) : null}
      {queueUnavailable ? (
        <p className="briefing-error" role="alert" data-testid="briefing-unavailable">
          The briefing queue is unavailable
          {queue.data?.reason ? `: ${queue.data.reason}` : '.'}
        </p>
      ) : null}

      {filter === 'judged' ? (
        <section className="briefing-judged" aria-label="Judged findings">
          {judged.length === 0 ? (
            <p className="briefing-empty">Nothing has been judged in this session yet.</p>
          ) : (
            <ul className="briefing-judged__list">
              {judged.map((entry) => (
                <li key={entry.item.candidate_id} className="briefing-judged__row">
                  <span className={`briefing-chip briefing-chip--${entry.action}`}>{entry.action}</span>
                  <span className="briefing-judged__title">{entry.item.revision.title}</span>
                  <span className="briefing-chip briefing-chip--source">{entry.item.source}</span>
                  <button
                    type="button"
                    className="briefing-button"
                    disabled={!operationalMutationsAllowed}
                    onClick={() => void undo(entry)}
                  >
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="briefing-note">
            This list covers decisions made on this page. Earlier decisions are recorded in the
            ledger and are shown per finding under Occurrences.
          </p>
        </section>
      ) : queue.loading && queue.data === null ? (
        <LoadingSkeleton variant="tab" label="Loading briefing queue" />
      ) : visibleItems.length === 0 ? (
        sourcesDegraded || queueUnavailable || sources.length === 0 ? (
          <section
            className="briefing-empty briefing-empty--degraded"
            data-testid="briefing-empty-degraded"
            role="status"
          >
            <h3>No findings — but this briefing is not clean</h3>
            <p>
              {healthSummary.failed > 0
                ? `${healthSummary.failed} source(s) failed to report.`
                : healthSummary.stale > 0
                  ? `${healthSummary.stale} source(s) are stale.`
                  : sources.length === 0
                    ? 'No collector source has reported an ingest batch.'
                    : 'Source health could not be established.'}{' '}
              An empty queue here does not mean there was nothing to find.
            </p>
          </section>
        ) : (
          <section
            className="briefing-empty briefing-empty--healthy"
            data-testid="briefing-empty-healthy"
            role="status"
          >
            <h3>Nothing pending</h3>
            <p>All sources are current and every finding has been judged.</p>
          </section>
        )
      ) : (
        <section className="briefing-queue" aria-label="Pending findings">
          {groups.map((group) => (
            <div className="briefing-group" key={group.source}>
              <h3 className="briefing-group__heading">
                <span className="briefing-chip briefing-chip--source">{group.source}</span>
                <span className="briefing-group__count">
                  {group.items.length} pending
                </span>
              </h3>
              <ul className="briefing-group__list">
                {group.items.map((item) => (
                  <BriefingRow
                    key={item.candidate_id}
                    item={item}
                    now={now}
                    selected={selectedId === item.candidate_id}
                    expanded={expandedId === item.candidate_id}
                    busy={busyIds.includes(item.candidate_id)}
                    mutationsAllowed={operationalMutationsAllowed}
                    onSelect={setSelectedId}
                    onToggleExpand={toggleExpand}
                    onJudge={judge}
                    detail={renderDetail(item)}
                  />
                ))}
              </ul>
            </div>
          ))}
          {hiddenPending > 0 ? (
            <p className="briefing-truncation" data-testid="briefing-truncation">
              {hiddenPending} more pending — showing the top {visibleItems.length}.
            </p>
          ) : null}
        </section>
      )}

      {undoEntry ? (
        <div className="briefing-toast" role="status" data-testid="briefing-undo-toast">
          <span>
            {undoEntry.action === 'keep' ? 'Kept' : 'Dismissed'} “{undoEntry.item.revision.title}”
          </span>
          <button
            type="button"
            className="briefing-button briefing-button--undo"
            disabled={!operationalMutationsAllowed}
            onClick={() => void undo(undoEntry)}
          >
            Undo
          </button>
          <button
            type="button"
            className="briefing-toast__dismiss"
            aria-label="Dismiss notification"
            onClick={() => setUndoEntry(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default BriefingView;
