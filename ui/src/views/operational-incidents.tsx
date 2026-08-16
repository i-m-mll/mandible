// Operational incident region (issue 5308097, spec §8).
//
// This renders the durable incident ledger at the top of the Briefing page. It
// is an OBSERVER surface, not a task controller: Mandible records what an
// executor reported and what the operator said about it, and offers exactly two
// forward actions — acknowledge, and prepare a reviewable fix. There is
// deliberately no keep, dismiss, undo, verdict, retry, deploy, dry-run or
// enable affordance anywhere below. Incidents are not feedback items and never
// enter the feedback collection model.
//
// THE THREE REGIONS, in the order the spec fixes:
//
//   1. A sticky "Active operational incidents" header.
//   2. Active + unacknowledged incidents as full warning cards, newest first.
//   3. One compact "Acknowledged but still active (N)" row, expandable.
//   4. Collapsible "Resolved incident history", newest resolution first.
//
// THE HARD JUDGEMENT — acknowledged but still active. Such an incident is still
// happening, so hiding it would be a lie; but the operator has already said "I
// have seen this", so continuing to shout would make the warning region
// worthless. The resolution here: the acknowledged set keeps a permanent,
// always-visible row of its own with a live count, one click from the full
// cards, and those cards carry the same facts as the warning cards — but the
// row is muted rather than red, is not sticky, and is not counted in the
// navigation badge. Discoverable, never undismissable.
//
// ACKNOWLEDGEMENT IS SERVER STATE. Nothing here holds an "acknowledged" flag
// that a refetch could contradict. Every render reads `attention` from the last
// server projection, so polling, SSE reconciliation, a reconnect refetch, later
// telemetry, and a daemon restart all converge on the stored acknowledgement
// instead of resetting it. A failed poll keeps the previous reconciled list
// rather than flickering the region empty.
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  acknowledgeOperationalIncident,
  canPrepareOperationalIncidentFix,
  closeOperationalIncident,
  dispatchAgent,
  getCachedOperationalIncidents,
  getOperationalIncidents,
  isApiErrorStatus,
  operationalIncidentAttentionLabel,
  operationalIncidentConditionLabel,
  operationalIncidentObservationLabel,
  operationalIncidentRemediationLabel,
  previewAgentDispatch,
  type AgentDispatchPlan,
  type InstanceInfo,
  type OperationalIncident,
  type OperationalIncidentCounts,
  type OperationalIncidentList,
} from '../api';

/**
 * The fixed Prepare-fix instruction (spec §7). It is a constant rather than an
 * editable field on purpose: preview and confirm must hash the same prompt, and
 * the sentence itself is what keeps a triage agent from deploying or running
 * the very task that is failing.
 */
export const PREPARE_FIX_INSTRUCTION =
  'Investigate this failure and prepare the smallest reviewable fix. '
  + 'Do not deploy, enable, or run the task.';

const INCIDENT_QUERY = { status: 'all', limit: 100 } as const;
const RELOAD_INTERVAL_MS = 60_000;

const EMPTY_COUNTS: OperationalIncidentCounts = {
  active_unacknowledged: 0,
  active_acknowledged: 0,
  resolved: 0,
};

export type OperationalIncidentGroups = {
  activeUnacknowledged: OperationalIncident[];
  acknowledgedActive: OperationalIncident[];
  resolved: OperationalIncident[];
};

/**
 * Partition and order the list exactly as the spec fixes it. Ordering is done
 * here rather than trusted from the server so the three regions stay
 * deterministic even if a paged response interleaves them.
 */
export function groupOperationalIncidents(
  incidents: readonly OperationalIncident[],
): OperationalIncidentGroups {
  const activeUnacknowledged: OperationalIncident[] = [];
  const acknowledgedActive: OperationalIncident[] = [];
  const resolved: OperationalIncident[] = [];
  for (const incident of incidents) {
    if (incident.resolved) resolved.push(incident);
    else if (incident.attention === 'acknowledged') acknowledgedActive.push(incident);
    else activeUnacknowledged.push(incident);
  }
  const byFirstSeenDesc = (a: OperationalIncident, b: OperationalIncident): number =>
    (b.first_seen ?? 0) - (a.first_seen ?? 0) || a.id.localeCompare(b.id);
  activeUnacknowledged.sort(byFirstSeenDesc);
  acknowledgedActive.sort(byFirstSeenDesc);
  resolved.sort((a, b) =>
    (b.resolved_at ?? 0) - (a.resolved_at ?? 0) || a.id.localeCompare(b.id));
  return { activeUnacknowledged, acknowledgedActive, resolved };
}

function formatTimestamp(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  return new Date(value).toLocaleString();
}

type CardTone = 'warning' | 'muted';

type IncidentCardProps = {
  incident: OperationalIncident;
  tone: CardTone;
  mutationsAllowed: boolean;
  busy: boolean;
  error: string | null;
  onAcknowledge(incident: OperationalIncident): void;
  onPrepareFix(incident: OperationalIncident): void;
  onClose(incident: OperationalIncident): void;
};

/**
 * One incident. The same component renders the warning, acknowledged and
 * historical variants — only the tone class differs — so an acknowledged or
 * resolved incident can never quietly lose a fact the warning card showed,
 * including the provenance label.
 */
function IncidentCard({
  incident,
  tone,
  mutationsAllowed,
  busy,
  error,
  onAcknowledge,
  onPrepareFix,
  onClose,
}: IncidentCardProps): JSX.Element {
  const prepareFixAllowed = canPrepareOperationalIncidentFix(incident);
  return (
    <article
      className={`operational-incident-card operational-incident-card--${tone}`}
      data-testid="operational-incident-card"
      data-incident-id={incident.id}
      data-observation={incident.observation}
      data-attention={incident.attention}
      data-remediation={incident.remediation}
      aria-label={`${incident.task} — ${operationalIncidentConditionLabel(incident.condition)}`}
    >
      <header className="operational-incident-card__header">
        <h4 className="operational-incident-card__title">
          {incident.task}
          {' — '}
          {operationalIncidentConditionLabel(incident.condition)}
        </h4>
        <span
          className="operational-incident-card__observation"
          data-testid="operational-incident-observation"
        >
          {operationalIncidentObservationLabel(incident)}
        </span>
      </header>

      {/* The three axes are stated separately and never merged into one
          status: recovery does not mean acknowledged, and acknowledgement
          does not mean fixed. */}
      <dl className="operational-incident-card__states">
        <div>
          <dt>Attention</dt>
          <dd data-testid="operational-incident-attention">
            {operationalIncidentAttentionLabel(incident)}
          </dd>
        </div>
        <div>
          <dt>Remediation</dt>
          <dd data-testid="operational-incident-remediation">
            {operationalIncidentRemediationLabel(incident.remediation)}
          </dd>
        </div>
        <div>
          <dt>Executor</dt>
          <dd>{incident.executor}</dd>
        </div>
      </dl>

      <dl className="operational-incident-card__times">
        <div>
          <dt>First seen</dt>
          <dd>{formatTimestamp(incident.first_seen)}</dd>
        </div>
        <div>
          <dt>Latest observation</dt>
          <dd>{formatTimestamp(incident.latest_observed_at)}</dd>
        </div>
      </dl>

      {/* Not decoration. Mandible authenticated the sender of these facts and
          verified nothing else about them; the reader has to know that. */}
      <p
        className="operational-incident-card__provenance"
        data-testid="operational-incident-provenance"
      >
        {incident.provenance_label}
      </p>

      {error ? (
        <p className="operational-incident-card__error" role="alert">{error}</p>
      ) : null}

      <div className="operational-incident-card__actions">
        {incident.attention === 'unacknowledged' ? (
          <button
            type="button"
            className="btn"
            disabled={busy || !mutationsAllowed}
            title={mutationsAllowed ? undefined : 'Read-only instance'}
            onClick={() => onAcknowledge(incident)}
          >
            Acknowledge
          </button>
        ) : null}
        {prepareFixAllowed ? (
          <button
            type="button"
            className="btn"
            disabled={busy || !mutationsAllowed}
            title={mutationsAllowed ? undefined : 'Read-only instance'}
            onClick={() => onPrepareFix(incident)}
          >
            Prepare fix…
          </button>
        ) : null}
        {!incident.resolved ? (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || !mutationsAllowed}
            title={mutationsAllowed ? undefined : 'Read-only instance'}
            onClick={() => onClose(incident)}
          >
            Close as operator…
          </button>
        ) : null}
      </div>
    </article>
  );
}

type PrepareFixState = {
  incident: OperationalIncident;
  phase: 'loading' | 'ready' | 'dispatching' | 'done' | 'stale' | 'error';
  plan: AgentDispatchPlan | null;
  sessionHandle: string | null;
  error: string | null;
};

type PrepareFixDialogProps = {
  state: PrepareFixState;
  onConfirm(): void;
  onRepreview(): void;
  onCancel(): void;
};

/**
 * Preview-then-confirm gate for Prepare-fix.
 *
 * Opening this dialog calls ONLY the preview route, which writes nothing —
 * no workflow event, no prompt file, no process. Cancelling therefore leaves no
 * trace whatsoever. The confirm call echoes back both digests the preview
 * returned; if the prompt or the executor telemetry moved in between, the
 * server answers 409 and this dialog demands a fresh preview rather than
 * starting an agent on evidence the operator never read.
 */
function PrepareFixDialog({
  state,
  onConfirm,
  onRepreview,
  onCancel,
}: PrepareFixDialogProps): JSX.Element {
  const { incident, phase, plan } = state;
  return (
    <div
      className="operational-incident-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`Prepare a fix for ${incident.task}`}
      data-testid="operational-incident-prepare-dialog"
    >
      <div className="operational-incident-dialog__panel">
        <h3>Prepare a fix for {incident.task}</h3>

        {phase === 'loading' ? <p>Preparing the task…</p> : null}

        {plan && (phase === 'ready' || phase === 'dispatching' || phase === 'stale') ? (
          <>
            <section>
              <h4>Task the agent will be given</h4>
              <p data-testid="operational-incident-prepare-task">{plan.instruction}</p>
            </section>
            <section>
              <h4>What this session can do</h4>
              <ul data-testid="operational-incident-prepare-capabilities">
                {plan.capability_surface.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </section>
            <p className="operational-incident-dialog__provenance">
              {incident.provenance_label}
            </p>
            <details>
              <summary>Full seed prompt ({plan.prompt.length} characters)</summary>
              {/* Text node only: this quotes executor-authored telemetry and
                  must never be interpreted as markup. */}
              <pre data-testid="operational-incident-prepare-prompt">{plan.prompt}</pre>
            </details>
          </>
        ) : null}

        {phase === 'stale' ? (
          <p role="alert" data-testid="operational-incident-prepare-stale">
            This incident changed since the preview was taken. Take a new preview
            before starting an agent.
          </p>
        ) : null}

        {phase === 'done' ? (
          <p data-testid="operational-incident-prepare-outcome">
            {state.sessionHandle
              ? `Agent started: ${state.sessionHandle}`
              : 'The agent did not start.'}
          </p>
        ) : null}

        {state.error ? (
          <p role="alert" data-testid="operational-incident-prepare-error">{state.error}</p>
        ) : null}

        <div className="operational-incident-dialog__actions">
          {phase === 'done' ? (
            <button type="button" className="btn" onClick={onCancel}>Close</button>
          ) : (
            <>
              <button type="button" className="btn btn--ghost" onClick={onCancel}>
                Cancel
              </button>
              {phase === 'stale' ? (
                <button type="button" className="btn btn--primary" onClick={onRepreview}>
                  Preview again
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={phase !== 'ready'}
                  onClick={onConfirm}
                >
                  {phase === 'dispatching' ? 'Starting…' : 'Start agent'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export type OperationalIncidentsRegionProps = {
  instance: InstanceInfo | null;
  /** When false the region neither polls nor refetches (inactive surface). */
  active?: boolean;
};

export function OperationalIncidentsRegion({
  instance,
  active = true,
}: OperationalIncidentsRegionProps): JSX.Element | null {
  const [list, setList] = useState<OperationalIncidentList | null>(
    () => getCachedOperationalIncidents(INCIDENT_QUERY),
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  const [acknowledgedExpanded, setAcknowledgedExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [prepareFix, setPrepareFix] = useState<PrepareFixState | null>(null);
  const loadSequence = useRef(0);

  const reload = useCallback(() => setReloadNonce((value) => value + 1), []);

  const loadIncidents = useCallback(async (signal: AbortSignal) => {
    const sequence = ++loadSequence.current;
    try {
      const next = await getOperationalIncidents(INCIDENT_QUERY, signal);
      if (!signal.aborted && sequence === loadSequence.current) setList(next);
    } catch {
      // Keep the last reconciled list. A transient poll failure must not empty
      // the region, collapse an expanded section, or drop an acknowledgement
      // the server already holds.
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    void loadIncidents(controller.signal);
    return () => controller.abort();
  }, [active, loadIncidents, reloadNonce]);

  useEffect(() => {
    if (!active) return undefined;
    const interval = window.setInterval(reload, RELOAD_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, reload]);

  // SSE and reconnect are RECONCILIATION INPUTS: they schedule a refetch and
  // nothing else. They never collapse a section, clear an error, or alter a
  // state axis locally — the next server projection decides all of that.
  useEffect(() => {
    if (!active) return undefined;
    let timer: number | null = null;
    const reconcile = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type;
      if (type !== 'reconnected' && !type?.startsWith('operational-incident:')) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        reload();
      }, 100);
    };
    window.addEventListener('operational-incident:sse', reconcile);
    return () => {
      window.removeEventListener('operational-incident:sse', reconcile);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, reload]);

  const groups = useMemo(
    () => groupOperationalIncidents(list?.incidents ?? []),
    [list],
  );
  const counts = list?.counts ?? EMPTY_COUNTS;
  const mutationsAllowed = !instance || instance.operational_mutations === 'allow';

  const setCardError = useCallback((incidentId: string, message: string | null) => {
    setCardErrors((current) => {
      if (message === null) {
        if (!(incidentId in current)) return current;
        const next = { ...current };
        delete next[incidentId];
        return next;
      }
      return { ...current, [incidentId]: message };
    });
  }, []);

  const acknowledge = useCallback(async (incident: OperationalIncident) => {
    setBusyId(incident.id);
    setCardError(incident.id, null);
    try {
      await acknowledgeOperationalIncident(incident.id);
      // Reveal where the card went. The operator's own action is the only
      // thing that opens this section automatically.
      setAcknowledgedExpanded(true);
      reload();
    } catch (cause) {
      setCardError(incident.id, cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }, [reload, setCardError]);

  const closeIncident = useCallback(async (incident: OperationalIncident) => {
    // Closure is an explicit, reasoned operator act — never a dismissal — so it
    // requires typed justification and records it on the ledger.
    const reason = window.prompt(
      'Why is this incident being closed without executor-verified recovery?',
    );
    if (reason === null || !reason.trim()) return;
    setBusyId(incident.id);
    setCardError(incident.id, null);
    try {
      await closeOperationalIncident(incident.id, reason.trim(), incident.updated_at ?? 0);
      reload();
    } catch (cause) {
      setCardError(incident.id, cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }, [reload, setCardError]);

  const runPreview = useCallback(async (incident: OperationalIncident) => {
    setPrepareFix({
      incident, phase: 'loading', plan: null, sessionHandle: null, error: null,
    });
    try {
      const plan = await previewAgentDispatch(
        { kind: 'incident', incident_id: incident.id },
        PREPARE_FIX_INSTRUCTION,
      );
      setPrepareFix((current) => (
        current && current.incident.id === incident.id
          ? { ...current, phase: 'ready', plan }
          : current
      ));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setPrepareFix((current) => (
        current && current.incident.id === incident.id
          ? { ...current, phase: 'error', error: message }
          : current
      ));
    }
  }, []);

  const confirmPrepareFix = useCallback(async () => {
    const current = prepareFix;
    if (!current || current.phase !== 'ready' || !current.plan) return;
    const { incident, plan } = current;
    setPrepareFix({ ...current, phase: 'dispatching', error: null });
    try {
      const result = await dispatchAgent(
        { kind: 'incident', incident_id: incident.id },
        PREPARE_FIX_INSTRUCTION,
        {
          expected_prompt_sha256: plan.prompt_sha256,
          expected_incident_telemetry_sha256: plan.incident_telemetry_sha256,
        },
      );
      setPrepareFix({
        incident,
        phase: 'done',
        plan,
        sessionHandle: result.ok ? result.event.session_handle : null,
        error: result.ok ? null : (result.event.error ?? 'The agent did not start.'),
      });
      reload();
    } catch (cause) {
      // 409 means the plan this dialog displayed is no longer the plan the
      // server would run. That is not an error to retry through — it requires a
      // new preview, which is a new deliberate look at new evidence.
      if (isApiErrorStatus(cause, 409)) {
        setPrepareFix({ ...current, phase: 'stale', error: null });
        reload();
        return;
      }
      setPrepareFix({
        ...current,
        phase: 'error',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [prepareFix, reload]);

  const hasAnything = counts.active_unacknowledged > 0
    || counts.active_acknowledged > 0
    || counts.resolved > 0
    || groups.activeUnacknowledged.length > 0
    || groups.acknowledgedActive.length > 0
    || groups.resolved.length > 0;
  if (!hasAnything) return null;

  const renderCard = (incident: OperationalIncident, tone: CardTone): JSX.Element => (
    <IncidentCard
      key={incident.id}
      incident={incident}
      tone={tone}
      mutationsAllowed={mutationsAllowed}
      busy={busyId === incident.id}
      error={cardErrors[incident.id] ?? null}
      onAcknowledge={(target) => void acknowledge(target)}
      onPrepareFix={(target) => void runPreview(target)}
      onClose={(target) => void closeIncident(target)}
    />
  );

  return (
    <section
      className="operational-incidents"
      aria-label="Operational incidents"
      data-testid="operational-incidents-region"
    >
      <header
        className="operational-incidents__sticky"
        data-testid="operational-incidents-sticky"
      >
        <h3>Active operational incidents</h3>
        <p className="operational-incidents__summary">
          {counts.active_unacknowledged} unacknowledged
          {' · '}
          {counts.active_acknowledged} acknowledged and still active
        </p>
      </header>

      {groups.activeUnacknowledged.length > 0 ? (
        <div
          className="operational-incidents__warning-list"
          data-testid="operational-incidents-active"
        >
          {groups.activeUnacknowledged.map((incident) => renderCard(incident, 'warning'))}
        </div>
      ) : (
        <p className="operational-incidents__empty">
          No unacknowledged operational incidents.
        </p>
      )}

      {counts.active_acknowledged > 0 || groups.acknowledgedActive.length > 0 ? (
        <div
          className="operational-incidents__acknowledged"
          data-testid="operational-incidents-acknowledged"
        >
          <button
            type="button"
            className="operational-incidents__acknowledged-row"
            aria-expanded={acknowledgedExpanded}
            data-testid="operational-incidents-acknowledged-row"
            onClick={() => setAcknowledgedExpanded((value) => !value)}
          >
            Acknowledged but still active ({
              Math.max(counts.active_acknowledged, groups.acknowledgedActive.length)
            })
          </button>
          {acknowledgedExpanded ? (
            <div data-testid="operational-incidents-acknowledged-list">
              {groups.acknowledgedActive.map((incident) => renderCard(incident, 'muted'))}
            </div>
          ) : null}
        </div>
      ) : null}

      {counts.resolved > 0 || groups.resolved.length > 0 ? (
        <div
          className="operational-incidents__history"
          data-testid="operational-incidents-history"
        >
          <button
            type="button"
            className="operational-incidents__history-row"
            aria-expanded={historyExpanded}
            data-testid="operational-incidents-history-row"
            onClick={() => setHistoryExpanded((value) => !value)}
          >
            Resolved incident history ({Math.max(counts.resolved, groups.resolved.length)})
          </button>
          {historyExpanded ? (
            <div data-testid="operational-incidents-history-list">
              {groups.resolved.map((incident) => renderCard(incident, 'muted'))}
            </div>
          ) : null}
        </div>
      ) : null}

      {prepareFix ? (
        <PrepareFixDialog
          state={prepareFix}
          onConfirm={() => void confirmPrepareFix()}
          onRepreview={() => void runPreview(prepareFix.incident)}
          onCancel={() => setPrepareFix(null)}
        />
      ) : null}
    </section>
  );
}

export default OperationalIncidentsRegion;
