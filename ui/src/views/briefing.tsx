// Briefing view — umbrella 99b74d6, lane d304a9b.
//
// The Briefing is a review queue over agent-produced findings. Its whole reason
// to exist is that a human can trust what it says, so the page is built around
// three rules:
//
//  1. DETERMINISTIC FACTS FIRST. The source-health strip is rendered above
//     anything a model wrote, from batch/ingest facts only. It is nearly
//     invisible when every source is current and auto-expands when it is not.
//     "No findings" while a collector went silent is NOT a successful empty
//     briefing, and the empty state says so in those words.
//  2. MODEL OUTPUT IS LABELLED AND UNTRUSTED. Every model-derived string
//     (`title`, `why_notable`, `refs`) is rendered as a text node — never as
//     HTML — and a ref becomes a link only when it is an http(s) URL or a
//     recognized internal resource ref (ui/src/resource-refs.ts). Anything else
//     renders as inert text.
//  3. JUDGING IS CHEAP AND REVERSIBLE. j/k moves, y keeps, n dismisses, u
//     undoes; every decision raises an undo toast. Judged items leave the
//     default view immediately and stay reachable behind the Judged filter.
//  4. THE PRIMARY AXIS IS THE PRODUCER (issue 5497690). A briefing is not one
//     undifferentiated queue: every candidate names the `source` that produced
//     it and the `task_identity` of the batch it arrived in, and the page is
//     navigable along that axis. The producer selector is CLIENT-SIDE over the
//     already-loaded queue, not a refetch of `/api/briefing/queue?source=`:
//     that route returns every pending candidate plus global source health in
//     one unpaginated payload, so the page already holds the complete set. One
//     poll therefore backs every producer view, switching producers costs no
//     request, and the optimistic judged set, the undo entry, and the "N more
//     pending" counts all stay consistent against a single snapshot. The
//     server-side `source` filter remains the right tool for an API consumer
//     that wants one producer's slice; it is the wrong tool for a view that
//     must also show every OTHER producer's health at the same time.
//
// Server contract: src/contracts.ts (`BriefingQueueResponse` and friends),
// implemented by src/routes/briefing.ts. This view renders ONLY what that
// contract carries (issue 223d090): there is no agent-written digest headline
// and no cost figure anywhere in the pipeline, so the page does not reserve a
// permanent apology for either. It is a pure client of the queue/history/
// decision/comment routes and of the server-authoritative `briefing` badge
// count; it never derives the badge itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getAgentDispatchEvents,
  getBriefingHistory,
  getBriefingQueue,
  isApiErrorStatus,
  postBriefingComment,
  postBriefingDecision,
  type BriefingDecisionTarget,
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
  /** Selected producer (`source`), or null for every producer. */
  source: string | null;
  /** null = follow the deterministic default (open only when unhealthy). */
  healthOpen: boolean | null;
  expandedCandidateId: string | null;
};

const DEFAULT_VIEW_STATE: BriefingViewState = {
  filter: 'pending',
  source: null,
  healthOpen: null,
  expandedCandidateId: null,
};

function normalizeViewState(value: unknown, defaults: Readonly<BriefingViewState>): BriefingViewState {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const filter = row.filter === 'judged' ? 'judged' : defaults.filter;
  // State persisted before the producer axis existed simply has no `source`,
  // which reads as "every producer" — the pre-existing behavior.
  const source = typeof row.source === 'string' && row.source ? row.source : defaults.source;
  const healthOpen = typeof row.healthOpen === 'boolean' ? row.healthOpen : null;
  const expandedCandidateId =
    typeof row.expandedCandidateId === 'string' && row.expandedCandidateId
      ? row.expandedCandidateId
      : null;
  return { filter, source, healthOpen, expandedCandidateId };
}

/**
 * A decision taken in this page session, kept so it can be undone and listed.
 *
 * `eventId` is the identity the server returned for THIS judgment. Undo carries
 * it back so it can only retract the decision this row represents: without it,
 * an Undo clicked here after someone else decided the same revision would erase
 * their newer judgment. Null only if a server answered without an event id, in
 * which case Undo falls back to the pre-existing revision-addressed behavior.
 */
type JudgedEntry = {
  item: BriefingQueueItem;
  action: Exclude<BriefingJudgeAction, 'undo'>;
  eventId: string | null;
};

/**
 * Identity of a JUDGMENT, which is a decision about a revision and not about a
 * candidate. A candidate that is re-ingested with new content gets a new
 * revision and returns to the queue as pending; suppressing it locally because
 * an EARLIER revision of it was judged would hide live work — and would make
 * the producer counts and the "everything is judged" empty state lie — for as
 * long as this page stays mounted.
 */
function judgmentKey(item: BriefingQueueItem): string {
  return `${item.candidate_id}::${item.revision.id}`;
}

/**
 * The same identity as `judgmentKey`, addressed to the server. Local
 * suppression and the wire decision are derived from ONE pair of fields, so the
 * row the operator saw, the row this page hides, and the revision the ledger
 * records can never come apart: an Undo issued from a judged row for revision A
 * undoes revision A, even when the candidate has since moved to revision B.
 */
function decisionTarget(item: BriefingQueueItem): BriefingDecisionTarget {
  return { candidate_id: item.candidate_id, revision_id: item.revision.id };
}

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

/**
 * Age of a source's last ingest batch. The server measures the age itself at
 * response time (`last_ingest_age_ms`), so prefer it over the client clock and
 * fall back to the raw timestamp only when the server did not report one.
 */
export function formatSourceIngestAge(source: BriefingSourceHealth, now: number): string {
  if (source.last_ingest_age_ms !== null) return formatBriefingAge(now - source.last_ingest_age_ms, now);
  return formatBriefingAge(source.last_ingested_at, now);
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
  unknown: number;
  healthy: boolean;
};

/** Deterministic roll-up of the per-source health rows. No model input. */
export function summarizeBriefingHealth(sources: BriefingSourceHealth[]): BriefingHealthSummary {
  const summary = { current: 0, stale: 0, unknown: 0 };
  for (const source of sources) summary[source.status] += 1;
  return {
    ...summary,
    healthy: sources.length > 0 && summary.stale === 0 && summary.unknown === 0,
  };
}

// --- producers ---------------------------------------------------------------

/** One selectable producer: a `source`, its pending count, and its identity. */
export type BriefingProducer = {
  source: string;
  /** Pending candidates this page is currently showing for the source. */
  pending: number;
  /** Identity of the source's most recent batch, when the ledger has one. */
  lastTaskIdentity: string | null;
  status: BriefingSourceStatus;
};

/**
 * The producer axis, derived entirely on the client from the payload the queue
 * route already returned.
 *
 * The health rows ARE the domain: the server groups them over every review
 * candidate, so a source with anything pending necessarily has one. That makes
 * the list stable — a producer stays listed and selectable when its last item
 * is judged away, because its health row does not depend on the queue — and it
 * makes a queue-only source what it actually is: a payload that contradicts the
 * contract. Such a source is still offered rather than hidden (its pending work
 * is real), but with `unknown` health, which the page renders as degraded.
 *
 * Counts come from the queue items rather than `BriefingSourceHealth.pending_count`
 * on purpose: the items are the exact set this page will render, already net of
 * decisions taken in this session, whereas the server count is a snapshot from
 * load time. The health strip keeps reporting the server number as a fact.
 */
export function listBriefingProducers(
  sources: BriefingSourceHealth[],
  items: BriefingQueueItem[],
): BriefingProducer[] {
  const byName = new Map<string, BriefingProducer>();
  for (const source of sources) {
    byName.set(source.source, {
      source: source.source,
      pending: 0,
      lastTaskIdentity: source.last_task_identity,
      status: source.status,
    });
  }
  for (const item of items) {
    const producer = byName.get(item.source);
    if (producer) {
      producer.pending += 1;
      continue;
    }
    byName.set(item.source, {
      source: item.source,
      pending: 1,
      lastTaskIdentity: null,
      status: 'unknown',
    });
  }
  return [...byName.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function BriefingHealthStrip({
  sources,
  summary,
  open,
  loading,
  onToggle,
}: {
  sources: BriefingSourceHealth[];
  summary: BriefingHealthSummary;
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
          {summary.unknown > 0 ? (
            <span className="briefing-health__count briefing-health__count--unknown">
              {summary.unknown} unknown
            </span>
          ) : null}
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
              {/*
                The producing task identity is a first-class fact, not a hover
                affordance: a source is a namespace, and the identity names the
                scheduled task that actually filled it. Its absence is reported
                in words rather than by omitting the field, because "no batch on
                record" is exactly the state the strip exists to expose.
              */}
              <span
                className={`briefing-health__identity${
                  source.last_task_identity ? '' : ' briefing-health__identity--unknown'
                }`}
              >
                {source.last_task_identity ?? 'no batch identity on record'}
              </span>
              <span className="briefing-health__meta">
                last ingest {formatSourceIngestAge(source, now)}
              </span>
              {source.last_digest_version !== null ? (
                <span className="briefing-health__meta">
                  digest v{source.last_digest_version}
                </span>
              ) : null}
              {source.last_batch_item_count !== null ? (
                <span className="briefing-health__meta">
                  {source.last_batch_item_count} in last batch
                </span>
              ) : null}
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

// --- row ---------------------------------------------------------------------

function BriefingProvenance({ item }: { item: BriefingQueueItem }): JSX.Element {
  const revision = item.revision;
  return (
    <div className="briefing-detail__provenance">
      {/*
        The producer of THIS revision, from the batch that carried it — not the
        source's most recent batch identity, which can name a different task.
        Omitted rather than substituted when the server did not resolve one.
      */}
      {item.task_identity ? (
        <span
          className="briefing-chip briefing-chip--provenance"
          title="Task identity of the batch that carried this revision"
        >
          producer {item.task_identity}
        </span>
      ) : null}
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
        {/*
          The history route carries revisions, decisions, and comments — not
          per-occurrence rows. The occurrence facts come from the queue entry's
          aggregate (contract `BriefingOccurrenceStats`), which is what the
          server actually computes.
        */}
        <ul className="briefing-detail__occurrences">
          <li>
            <span className="briefing-detail__occurrence-when">
              first seen {formatBriefingAge(item.occurrences.first_seen_at, Date.now())}
            </span>
            <span className="briefing-detail__occurrence-when">
              last seen {formatBriefingAge(item.occurrences.last_seen_at, Date.now())}
            </span>
          </li>
        </ul>
        {historyLoading ? (
          <LoadingSkeleton variant="detail" label="Loading occurrence history" />
        ) : historyError ? (
          <p className="briefing-detail__error">History unavailable: {historyError}</p>
        ) : history ? (
          <>
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
  /**
   * Sequence number of the load whose completion produced this state; 0 before
   * any load finishes. It exists so the page can ask "is what I am holding old
   * enough to predate that navigation?" — a question the payload itself cannot
   * answer. A load that FAILS still advances it: the point is that an attempt
   * concluded, so nothing can wait forever on a queue route that is down.
   */
  generation: number;
};

/**
 * A candidate link that has not been reconciled with the queue yet.
 *
 * `minGeneration` is the first queue load allowed to declare the link
 * unresolvable. Presence in any payload is proof enough to select — a candidate
 * that is there is there — but ABSENCE only proves something in a payload
 * loaded at or after the navigation. Without that floor, a second navigation
 * into this keep-alive route is answered by whatever snapshot happens to be in
 * hand, and a link arriving moments after the candidate was ingested is dropped
 * against a payload that predates it.
 */
type PendingDeepLink = {
  candidateId: string;
  minGeneration: number;
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
  const [queue, setQueue] = useState<QueueState>({
    data: null,
    loading: true,
    error: null,
    generation: 0,
  });
  const [selectedId, setSelectedId] = useState<string | null>(initialCandidateId ?? null);
  // Held as state rather than a ref so the selection keep-alive sees the same
  // value in the same render pass and cannot race the scope reset a link may
  // force. A link present at mount is armed against the FIRST load, which is
  // the one the mount is about to start.
  const [pendingDeepLink, setPendingDeepLink] = useState<PendingDeepLink | null>(
    initialCandidateId ? { candidateId: initialCandidateId, minGeneration: 1 } : null,
  );
  const [judged, setJudged] = useState<JudgedEntry[]>([]);
  const [undoEntry, setUndoEntry] = useState<JudgedEntry | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => nowMs ?? Date.now());
  const [reloadNonce, setReloadNonce] = useState(0);
  // Monotonic id of the most recently STARTED queue load. Read synchronously
  // when arming a deep link, so the link knows which load it is waiting for.
  const loadSeq = useRef(0);

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

  // Unlike `filter`, a candidate link is honored every time it changes: this
  // route stays mounted while hidden, so a second navigation from Spaces
  // arrives as a new prop on the same instance and must still land on its
  // finding. The mount case is already armed in the initial state above; only a
  // LATER link runs this, and a later link is armed against the next load and
  // asks for that load, because the payload in hand may be a minute old and
  // predate the finding the operator just clicked.
  const deepLinkMount = useRef(true);
  useEffect(() => {
    if (deepLinkMount.current) {
      deepLinkMount.current = false;
      return;
    }
    if (!initialCandidateId) return;
    setPendingDeepLink({ candidateId: initialCandidateId, minGeneration: loadSeq.current + 1 });
    setReloadNonce((current) => current + 1);
  }, [initialCandidateId]);

  const filter = viewState.filter;
  const expandedId = viewState.expandedCandidateId;

  const loadQueue = useCallback(async (signal: AbortSignal) => {
    // Stamped at START, so the stamp orders the REQUESTS. A response that
    // arrives after a newer one is discarded rather than allowed to reinstate
    // an older queue — and the generation never moves backwards, which is what
    // lets a deep link trust it.
    const seq = ++loadSeq.current;
    try {
      const data = await getBriefingQueue(signal);
      if (signal.aborted) return;
      setQueue((current) => (
        seq < current.generation
          ? current
          : { data, loading: false, error: null, generation: seq }
      ));
      setNow(nowMs ?? Date.now());
    } catch (error) {
      if (signal.aborted) return;
      setQueue((current) => (
        seq < current.generation
          ? current
          : {
            data: current.data,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            generation: seq,
          }
      ));
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

  const judgedKeys = useMemo(() => new Set(judged.map((entry) => judgmentKey(entry.item))), [judged]);

  const pendingItems = useMemo(() => {
    const items = queue.data?.candidates ?? [];
    // A judged item leaves the default view immediately, before the next poll
    // confirms it server-side. The suppression is bound to the revision that
    // was judged, so a NEWER revision of the same candidate comes back.
    const visible = items.filter((item) => !judgedKeys.has(judgmentKey(item)));
    return [...visible].sort((left, right) => {
      const leftRank = left.revision.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.revision.rank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftAt = revisionTimestamp(left.revision) ?? 0;
      const rightAt = revisionTimestamp(right.revision) ?? 0;
      if (leftAt !== rightAt) return rightAt - leftAt;
      return left.candidate_id.localeCompare(right.candidate_id);
    });
  }, [queue.data, judgedKeys]);

  const sources = queue.data?.sources ?? [];
  const selectedSource = viewState.source;

  // The producer axis and the pending/judged axis compose: the producer scopes
  // WHICH findings this page is about, the filter scopes what has happened to
  // them. Both lists below are scoped, so the two tab rows always describe the
  // same set of candidates.
  const producers = useMemo(
    () => listBriefingProducers(sources, pendingItems),
    [sources, pendingItems],
  );

  const scopedPending = useMemo(
    () => (selectedSource ? pendingItems.filter((item) => item.source === selectedSource) : pendingItems),
    [pendingItems, selectedSource],
  );
  const scopedJudged = useMemo(
    () => (selectedSource ? judged.filter((entry) => entry.item.source === selectedSource) : judged),
    [judged, selectedSource],
  );

  const visibleItems = useMemo(
    () => scopedPending.slice(0, BRIEFING_VISIBLE_LIMIT),
    [scopedPending],
  );

  // Honest truncation: the queue route returns every pending candidate, so the
  // page's own list IS the pending total. Truncation is a display cap only, and
  // the note counts exactly what this page is hiding — within the selected
  // producer, which is the set the list is showing.
  const totalPending = scopedPending.length;
  const hiddenPending = Math.max(totalPending - visibleItems.length, 0);
  /** Pending work a producer selection is hiding, counted so it can be named. */
  const otherProducerPending = pendingItems.length - scopedPending.length;

  const groups = useMemo(() => {
    const bySource = new Map<string, BriefingQueueItem[]>();
    for (const item of visibleItems) {
      const existing = bySource.get(item.source);
      if (existing) existing.push(item);
      else bySource.set(item.source, [item]);
    }
    return [...bySource.entries()].map(([source, items]) => ({ source, items }));
  }, [visibleItems]);

  /** Health rows by source, so a queue group can name its producer identity. */
  const healthBySource = useMemo(
    () => new Map(sources.map((source) => [source.source, source])),
    [sources],
  );

  // The strip itself stays GLOBAL under a producer selection: hiding another
  // collector's silence because the operator is looking at one producer is the
  // exact failure this page exists to prevent. Only the empty state below
  // narrows, and it narrows to the producer it is actually speaking about.
  const healthSummary = useMemo(() => summarizeBriefingHealth(sources), [sources]);
  const healthOpen = viewState.healthOpen ?? !healthSummary.healthy;

  const scopedSources = useMemo(
    () => (selectedSource ? sources.filter((source) => source.source === selectedSource) : sources),
    [sources, selectedSource],
  );
  const scopedHealthSummary = useMemo(
    () => summarizeBriefingHealth(scopedSources),
    [scopedSources],
  );

  const setFilter = (next: BriefingFilter) => {
    setViewState((current) => ({ ...current, filter: next }));
  };
  const setSource = (next: string | null) => {
    setViewState((current) => (current.source === next ? current : { ...current, source: next }));
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

  // An explicit candidate link (Spaces builds `#/briefing?candidate=…`) is a
  // navigation, and a navigation outranks a persisted producer filter: landing
  // on a page that silently shows a DIFFERENT finding because a filter was left
  // selected in an earlier session is the failure this guards. When the linked
  // candidate is not visible under the current producer scope, the scope is
  // dropped rather than the link. A candidate that is not pending at all
  // changes nothing — the selection keep-alive below owns that case.
  useEffect(() => {
    if (pendingDeepLink === null) return;
    const target = pendingItems.find((item) => item.candidate_id === pendingDeepLink.candidateId);
    if (target) {
      // Presence needs no freshness argument: any payload that carries the
      // candidate answers the link.
      if (selectedSource !== null && target.source !== selectedSource) setSource(null);
      setSelectedId(pendingDeepLink.candidateId);
      setPendingDeepLink(null);
      return;
    }
    // Absence is only evidence in a payload that postdates the navigation.
    // Until such a load has concluded, the link is still open — the candidate
    // may be in the refresh that is on its way.
    if (queue.generation >= pendingDeepLink.minGeneration) setPendingDeepLink(null);
  }, [pendingDeepLink, queue.generation, pendingItems, selectedSource]);

  // Keep a selection alive as rows come and go.
  useEffect(() => {
    // While a deep link is still being honored the visible list is one render
    // behind the scope reset it forces; adopting a default selection here would
    // overwrite the linked candidate with whatever happens to be on top.
    if (pendingDeepLink !== null) return;
    if (visibleItems.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !visibleItems.some((item) => item.candidate_id === selectedId)) {
      setSelectedId(visibleItems[0].candidate_id);
    }
  }, [visibleItems, selectedId, pendingDeepLink]);

  const judge = useCallback(
    async (item: BriefingQueueItem, action: Exclude<BriefingJudgeAction, 'undo'>) => {
      if (!operationalMutationsAllowed) return;
      setBusyIds((current) => (current.includes(item.candidate_id) ? current : [...current, item.candidate_id]));
      setActionError(null);
      try {
        const result = await postBriefingDecision(decisionTarget(item), action);
        const entry: JudgedEntry = { item, action, eventId: result.event_id };
        const key = judgmentKey(item);
        setJudged((current) => [entry, ...current.filter((row) => judgmentKey(row.item) !== key)]);
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
        // Addressed to the revision this row is about AND to the judgment it
        // represents. A server that has since taken a newer revision keeps that
        // newer decision; a revision whose decision is already gone, or whose
        // latest decision is no longer the one this row recorded, answers 409,
        // which surfaces as an action error and leaves the local list as it was.
        await postBriefingDecision(
          {
            ...decisionTarget(entry.item),
            ...(entry.eventId ? { expected_event_id: entry.eventId } : {}),
          },
          'undo',
        );
        const key = judgmentKey(entry.item);
        setJudged((current) => current.filter((row) => judgmentKey(row.item) !== key));
        setUndoEntry((current) => (current && judgmentKey(current.item) === key ? null : current));
        setSelectedId(entry.item.candidate_id);
        // Dropping the local suppression only un-hides an item the last poll
        // still carried. Once a poll has taken the decided candidate out of the
        // queue, the undone item exists only on the server, so the page refetches
        // rather than showing a queue and counts that are missing it for a minute.
        setReloadNonce((current) => current + 1);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        // A 409 means this page's picture of the revision is behind the server:
        // the decision it wanted to retract is gone or has been superseded. The
        // judged row stays (nothing was undone), but the queue and counts are
        // refetched so the view reconciles with whatever actually happened.
        if (isApiErrorStatus(error, 409)) setReloadNonce((current) => current + 1);
      }
    },
    [operationalMutationsAllowed],
  );

  const comment = useCallback(async (candidateId: string, body: string) => {
    if (!operationalMutationsAllowed) return;
    // A rejected comment throws out of the client; reaching here means it landed.
    await postBriefingComment(candidateId, body);
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

  // Scoped to the selected producer: "nothing pending" must be a verdict about
  // the producer being looked at, never a global all-clear borrowed from it.
  const sourcesDegraded =
    scopedHealthSummary.stale > 0
    || scopedHealthSummary.unknown > 0
    || scopedSources.length === 0;

  const degradedReason = selectedSource
    ? scopedSources.length === 0
      ? `${selectedSource} has not reported an ingest batch.`
      : scopedHealthSummary.stale > 0
        ? `${selectedSource} stopped reporting.`
        : `Health for ${selectedSource} could not be established.`
    : scopedHealthSummary.stale > 0
      ? `${scopedHealthSummary.stale} source(s) are stale.`
      : scopedSources.length === 0
        ? 'No collector source has reported an ingest batch.'
        : 'Source health could not be established.';

  /** Names the pending work a producer selection is hiding, and offers it. */
  const otherProducersNote = selectedSource && otherProducerPending > 0 ? (
    <p className="briefing-note" data-testid="briefing-other-producers">
      {otherProducerPending} pending from other producers.{' '}
      <button type="button" className="briefing-button" onClick={() => setSource(null)}>
        Show all producers
      </button>
    </p>
  ) : null;

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
        open={healthOpen}
        loading={queue.data === null && queue.loading}
        onToggle={toggleHealth}
      />

      {!operationalMutationsAllowed ? (
        <PreviewDisabledNotice title="Read-only instance">
          Keep, dismiss, undo, and notes are disabled here. Decisions are recorded only on an
          instance that allows operational mutations.
        </PreviewDisabledNotice>
      ) : null}

      {/*
        The producer selector leads the controls because the producer is the
        primary axis; the pending/judged filter below composes with whatever is
        selected here. With a single producer and no selection the row would say
        nothing the queue's own group heading does not, so it is not rendered —
        but a live selection always keeps its "All producers" way back out, even
        if the selected source has since left the health list entirely.
      */}
      {producers.length > 1 || selectedSource !== null ? (
        <div
          className="briefing-producers"
          role="group"
          aria-label="Producer"
          data-testid="briefing-producers"
        >
          <button
            type="button"
            className={`briefing-tab briefing-tab--producer${selectedSource === null ? ' briefing-tab--active' : ''}`}
            aria-pressed={selectedSource === null}
            data-testid="briefing-producer-all"
            onClick={() => setSource(null)}
          >
            <span className="briefing-tab__name">All producers</span>
            <span className="briefing-tab__count">{pendingItems.length}</span>
          </button>
          {producers.map((producer) => (
            <button
              key={producer.source}
              type="button"
              className={`briefing-tab briefing-tab--producer${
                selectedSource === producer.source ? ' briefing-tab--active' : ''
              }${producer.status !== 'current' ? ' briefing-tab--degraded' : ''}`}
              aria-pressed={selectedSource === producer.source}
              data-testid={`briefing-producer-${producer.source}`}
              title={producer.lastTaskIdentity ?? undefined}
              onClick={() => setSource(producer.source)}
            >
              <span className="briefing-tab__name">{producer.source}</span>
              <span className="briefing-tab__count">{producer.pending}</span>
            </button>
          ))}
        </div>
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
            Judged{scopedJudged.length > 0 ? ` (${scopedJudged.length})` : ''}
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

      {filter === 'judged' ? (
        <section className="briefing-judged" aria-label="Judged findings">
          {scopedJudged.length === 0 ? (
            <p className="briefing-empty">
              {selectedSource
                ? `Nothing from ${selectedSource} has been judged in this session yet.`
                : 'Nothing has been judged in this session yet.'}
            </p>
          ) : (
            <ul className="briefing-judged__list">
              {scopedJudged.map((entry) => (
                <li key={judgmentKey(entry.item)} className="briefing-judged__row">
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
        sourcesDegraded ? (
          <section
            className="briefing-empty briefing-empty--degraded"
            data-testid="briefing-empty-degraded"
            role="status"
          >
            <h3>
              {selectedSource
                ? `No findings from ${selectedSource} — and this is not clean`
                : 'No findings — but this briefing is not clean'}
            </h3>
            <p>
              {degradedReason}{' '}
              An empty queue here does not mean there was nothing to find.
            </p>
            {otherProducersNote}
          </section>
        ) : (
          <section
            className="briefing-empty briefing-empty--healthy"
            data-testid="briefing-empty-healthy"
            role="status"
          >
            <h3>{selectedSource ? `Nothing pending from ${selectedSource}` : 'Nothing pending'}</h3>
            <p>
              {selectedSource
                ? `${selectedSource} is current and every finding it produced has been judged.`
                : 'All sources are current and every finding has been judged.'}
            </p>
            {otherProducersNote}
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
                {/*
                  The producing task identity, from the batch ledger. Labelled
                  as the source's LAST batch because that is what the health row
                  reports; a given row's own producer is in its fold-out.
                */}
                {healthBySource.get(group.source)?.last_task_identity ? (
                  <span className="briefing-group__identity">
                    last batch by {healthBySource.get(group.source)?.last_task_identity}
                  </span>
                ) : null}
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
          {otherProducersNote}
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
