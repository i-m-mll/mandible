import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getBriefing,
  getClientAuthWhoami,
  isApiErrorStatus,
  postBriefingAnswers,
  postBriefingSubmission,
  type BriefingAnswerOperation,
  type BriefingDirectiveItem,
  type BriefingProjection,
  type BriefingResponseValue,
  type BriefingRoundSummary,
  type BriefingSubmissionAnswer,
  type InstanceInfo,
} from '../../api';
import { useAppShell } from '../../app-shell';
import { DetailHeaderIdentity } from '../../components/shared/DetailHeaderIdentity';
import { DetailPaneModal } from '../../components/shared/DetailPaneModal';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { artifactDetailHref, displayResourceRef } from '../../resource-refs';
import { shortRouteId } from '../../routing';
import {
  effectiveDraft,
  loadBriefingDraft,
  responseValuesEqual,
  saveBriefingDraft,
  type BriefingDraft,
} from './briefing-round-view-state';
import { BriefingDocumentPanel } from './BriefingDocumentPanel';

export type BriefingDocumentRendererProps = {
  briefingId: string;
  briefingTitle?: string;
  roundId?: string | null;
  instance: InstanceInfo | null;
  onBriefingChange?(briefing: BriefingProjection | null): void;
  onRoundChange?(roundId: string | null): void;
};

type LoadState = { round: BriefingProjection | null; loading: boolean; error: string | null };

function storageOrNull(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function meaningful(value: BriefingResponseValue | null): boolean {
  if (!value) return false;
  if ('text' in value) return value.text.trim().length > 0;
  if ('option_keys' in value) return value.option_keys.length > 0;
  return true;
}

function inputId(item: BriefingDirectiveItem): string {
  return `briefing-directive-${item.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

const occurrenceDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function roundTimestamp(round: BriefingRoundSummary): number | null {
  const timestamp = new Date(round.created_at).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function briefingRoundOptions(rounds: readonly BriefingRoundSummary[]): Array<{ round: BriefingRoundSummary; label: string }> {
  const sorted = [...rounds].sort((left, right) => {
    const leftTimestamp = roundTimestamp(left);
    const rightTimestamp = roundTimestamp(right);
    if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
    if (leftTimestamp === null && rightTimestamp !== null) return 1;
    if (leftTimestamp !== null && rightTimestamp === null) return -1;
    const leftOrdinal = Number.isFinite(left.ordinal) ? left.ordinal : Number.NEGATIVE_INFINITY;
    const rightOrdinal = Number.isFinite(right.ordinal) ? right.ordinal : Number.NEGATIVE_INFINITY;
    if (leftOrdinal !== rightOrdinal) return rightOrdinal - leftOrdinal;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const bases = sorted.map((round) => {
    const timestamp = roundTimestamp(round);
    return { round, label: timestamp === null ? 'Unknown occurrence' : occurrenceDateTimeFormatter.format(timestamp) };
  });
  const counts = new Map<string, number>();
  for (const entry of bases) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  return bases.map(({ round, label }) => ({
    round,
    label: `${label}${(counts.get(label) ?? 0) > 1 ? ` · #${round.ordinal}` : ''}`,
  }));
}

export function BriefingDocumentRenderer({
  briefingId,
  briefingTitle,
  roundId = null,
  instance,
  onBriefingChange,
  onRoundChange,
}: BriefingDocumentRendererProps): JSX.Element {
  const { active } = useAppShell();
  const [load, setLoad] = useState<LoadState>({ round: null, loading: true, error: null });
  const [userId, setUserId] = useState<string | null>(null);
  const [userKind, setUserKind] = useState<string | null>(null);
  const [draft, setDraft] = useState<BriefingDraft>({});
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contentGate, setContentGate] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const currentSelection = useRef(`${briefingId}:${roundId ?? 'latest'}`);
  currentSelection.current = `${briefingId}:${roundId ?? 'latest'}`;

  const reconcile = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoad((current) => ({ ...current, loading: current.round === null, error: null }));
    try {
      const [identity, round] = await Promise.all([getClientAuthWhoami(), getBriefing(briefingId, roundId)]);
      if (sequence !== loadSequence.current || currentSelection.current !== `${briefingId}:${roundId ?? 'latest'}`) return null;
      if (round.briefing_id !== briefingId || (roundId && !round.selected_round_id.startsWith(roundId))) throw new Error('The Briefing service returned a mismatched immutable round.');
      const nextUserId = identity.authenticated ? identity.user?.id ?? null : null;
      setUserId(nextUserId);
      setUserKind(identity.user?.kind ?? null);
      setLoad({ round, loading: false, error: null });
      onBriefingChange?.(round);
      const roundScope = `${briefingId}:${round.selected_round_id}`;
      const nextDraftScope = `${nextUserId ?? 'memory'}:${roundScope}`;
      setDraft((current) => {
        if (draftScope === nextDraftScope) return current;
        const stored = loadBriefingDraft(storageOrNull(), nextUserId, roundScope, round.items);
        return Object.keys(stored).length > 0 ? stored : effectiveDraft(round.items);
      });
      setDraftScope(nextDraftScope);
      return round;
    } catch (error) {
      if (sequence !== loadSequence.current || currentSelection.current !== `${briefingId}:${roundId ?? 'latest'}`) return null;
      const message = error instanceof Error ? error.message : String(error);
      setLoad((current) => ({ ...current, loading: false, error: message }));
      onBriefingChange?.(null);
      return null;
    }
  }, [briefingId, draftScope, onBriefingChange, roundId]);

  useEffect(() => {
    loadSequence.current += 1;
    mutationSequence.current += 1;
    setLoad({ round: null, loading: true, error: null });
    setUserId(null);
    setUserKind(null);
    setBusy(false);
    setContentGate(null);
    setDraftScope(null);
    setValidationErrors({});
    setStatus(null);
    onBriefingChange?.(null);
    void reconcile();
  }, [briefingId, roundId]);

  useEffect(() => {
    if (!active) return undefined;
    let timer: number | null = null;
    const onBriefing = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; data?: { briefing_id?: string } }>).detail;
      const type = detail?.type;
      if (type !== 'reconnected' && !type?.startsWith('briefing:')) return;
      if (detail?.data?.briefing_id && detail.data.briefing_id !== briefingId) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        setReload((value) => value + 1);
      }, 100);
    };
    window.addEventListener('briefing:sse', onBriefing);
    return () => {
      window.removeEventListener('briefing:sse', onBriefing);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, briefingId]);

  useEffect(() => {
    if (reload === 0 || !active) return;
    void reconcile();
  }, [active, reload]);

  useEffect(() => {
    if (!load.round || draftScope !== `${userId ?? 'memory'}:${briefingId}:${load.round.selected_round_id}`) return;
    saveBriefingDraft(storageOrNull(), userId, `${briefingId}:${load.round.selected_round_id}`, draft);
  }, [briefingId, draft, draftScope, load.round, userId]);

  const round = load.round;
  const setValue = (itemId: string, value: BriefingResponseValue | null) => {
    setDraft((current) => ({ ...current, [itemId]: value }));
    setValidationErrors((current) => {
      if (!current[itemId]) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    setStatus(null);
  };

  const canMutate = Boolean(
    round?.valid
    && round.briefing_id === briefingId
    && userId
    && userKind === 'human'
    && round.items.every((item) => item.responseVisible)
    && (round.state === 'open' || round.state === 'submitted')
    && round.directive_binding?.status === 'valid'
    && (!instance || instance.operational_mutations === 'allow'),
  );
  const requiredIncomplete = Boolean(round?.items.some((item) => item.item_kind === 'item' && item.revision.required && !meaningful(draft[item.id] ?? null)));
  const draftDiffers = Boolean(round?.items.some((item) => item.item_kind === 'item'
    && !responseValuesEqual(draft[item.id] ?? null, item.effective_response?.value ?? null)));
  const currentAnswerIds = (round?.items ?? []).flatMap((item) => item.effective_response ? [item.effective_response.response_event_id] : []);
  const currentAnnotationIds = (round?.annotations ?? []).map((annotation) => annotation.annotation_event_id);
  const frozenMatches = Boolean(round?.latest_frozen_membership
    && currentAnswerIds.length === round.latest_frozen_membership.answer_event_ids.length
    && currentAnnotationIds.length === round.latest_frozen_membership.annotation_event_ids.length
    && currentAnswerIds.every((id) => round.latest_frozen_membership!.answer_event_ids.includes(id))
    && currentAnnotationIds.every((id) => round.latest_frozen_membership!.annotation_event_ids.includes(id)));
  const submitReason = !canMutate
    ? (round?.directive_binding?.reason || 'Submitting is unavailable for the current identity or instance.')
    : round?.directive_binding?.status !== 'valid'
      ? (round.directive_binding.reason || 'The directive binding is unavailable.')
      : contentGate === null ? 'Loading pinned document…'
      : contentGate ? contentGate
      : busy ? 'Submitting changes…'
        : requiredIncomplete ? 'Complete the required directives before submitting.'
          : !draftDiffers && frozenMatches ? 'No answer or annotation changes since your latest submission.'
            : null;

  const submit = async () => {
    if (!round || !canMutate || busy || contentGate !== '') return;
    const mutation = ++mutationSequence.current;
    const submittedRoundId = round.selected_round_id;
    const mutationIsCurrent = () => mutationSequence.current === mutation
      && currentSelection.current === `${briefingId}:${roundId ?? 'latest'}`;
    const invalid: Record<string, string> = {};
    for (const item of round.items) {
      if (item.item_kind !== 'item' || !item.revision.required) continue;
      if (!meaningful(draft[item.id] ?? null)) invalid[item.id] = 'This answer is required.';
    }
    if (Object.keys(invalid).length > 0) {
      setValidationErrors(invalid);
      setStatus('Complete the required answers before submitting.');
      const first = round.items.find((item) => invalid[item.id]);
      if (first) window.setTimeout(() => {
        const control = document.getElementById(inputId(first));
        const focusTarget = control instanceof HTMLFieldSetElement
          ? control.querySelector<HTMLInputElement>('input')
          : control;
        focusTarget?.focus();
      }, 0);
      return;
    }

    setBusy(true);
    setStatus(null);
    try {
      const answerItems = round.items.filter((item) => item.item_kind === 'item');
      const operations: BriefingAnswerOperation[] = [];
      const changedItems: BriefingDirectiveItem[] = [];
      for (const item of answerItems) {
        const desired = draft[item.id] ?? null;
        const current = item.effective_response?.value ?? null;
        if (responseValuesEqual(desired, current)) continue;
        changedItems.push(item);
        operations.push({
          directive_key: item.client_item_key ?? item.id,
          operation: desired === null ? 'retract' : 'set',
          expected_response_event_id: item.effective_response?.response_event_id ?? null,
          ...(desired === null ? {} : { value: desired }),
        });
      }

      const answerResult = operations.length > 0
        ? await postBriefingAnswers(briefingId, submittedRoundId, operations)
        : { answer_event_ids: [] };
      if (answerResult.answer_event_ids.length !== operations.length) {
        throw new Error('The answer service returned an ambiguous answer-event result.');
      }
      const changedEventIds = new Map(changedItems.map((item, index) => [
        item.id,
        operations[index].operation === 'set' ? answerResult.answer_event_ids[index] : null,
      ]));
      const submissionAnswers: BriefingSubmissionAnswer[] = [];
      for (const item of answerItems) {
        if (changedEventIds.has(item.id)) {
          const eventId = changedEventIds.get(item.id);
          if (eventId) submissionAnswers.push({
            directive_key: item.client_item_key ?? item.id,
            response_event_id: eventId,
          });
        } else if (item.effective_response) {
          submissionAnswers.push({
            directive_key: item.client_item_key ?? item.id,
            response_event_id: item.effective_response.response_event_id,
          });
        }
      }
      await postBriefingSubmission(briefingId, submittedRoundId, {
        ...(round.latest_submission_for_actor
          ? { supersedes_submission_id: round.latest_submission_for_actor.id }
          : {}),
        answers: submissionAnswers,
        annotations: (round.annotations ?? []).map((annotation) => ({
          annotation_event_id: annotation.annotation_event_id,
        })),
      });
      saveBriefingDraft(storageOrNull(), userId, `${briefingId}:${submittedRoundId}`, {});
      if (!mutationIsCurrent()) return;
      const refreshed = await reconcile();
      if (refreshed) setDraft(effectiveDraft(refreshed.items));
      setStatus(round.state === 'submitted' ? 'Correction submitted.' : 'Answers submitted.');
      setValidationErrors({});
    } catch (error) {
      if (!mutationIsCurrent()) return;
      setStatus(error instanceof Error ? error.message : String(error));
      // The answer batch may have landed even when submit failed. Refetch both
      // ordinary failures and 409s, preserving the unsaved local draft.
      await reconcile();
      if (isApiErrorStatus(error, 409)) setStatus(`The round changed. ${error.message}`);
    } finally {
      if (mutationIsCurrent()) setBusy(false);
    }
  };

  const title = round?.title || briefingTitle || 'Briefing';
  const roundOptions = briefingRoundOptions(round?.rounds ?? []);
  const roundLabels = new Map(roundOptions.map(({ round: summary, label }) => [summary.id, label]));
  const selectedSummary = round?.rounds.find((candidate) => candidate.id === round.selected_round_id) ?? null;
  const newestRoundId = roundOptions[0]?.round.id ?? null;
  const selectedIsNewest = Boolean(round && newestRoundId && round.selected_round_id === newestRoundId);
  const artifactVersionId = selectedSummary?.artifact_version_id ?? round?.document?.artifact_version_id ?? null;
  const artifactVersionRef = artifactVersionId
    ? artifactVersionId.startsWith('artifact-version:') ? artifactVersionId : `artifact-version:${artifactVersionId}`
    : null;
  const body = load.loading && !round
    ? <div className="briefing-empty" role="status">Loading Briefing…</div>
    : load.error && !round
      ? <div className="briefing-error" role="alert">{load.error}</div>
      : !round
        ? <div className="briefing-empty" role="status">Briefing unavailable.</div>
        : !round.valid
          ? <div className="briefing-error" role="alert">The selected Briefing projection is invalid or unsupported.</div>
          : (
            <div className="briefing-document" data-testid="briefing-document-renderer">
              {Object.keys(validationErrors).length > 0 ? (
                <div className="briefing-document__validation" role="alert">
                  Complete {Object.keys(validationErrors).length} required answer{Object.keys(validationErrors).length === 1 ? '' : 's'}.
                </div>
              ) : null}
              {round.document ? (
                <BriefingDocumentPanel briefingId={briefingId} briefingTitle={title} roundId={round.selected_round_id} round={round} canMutate={canMutate && !busy && contentGate === ''} onRefresh={reconcile}
                  draft={Object.fromEntries(Object.entries(draft).filter(([, value]) => !value || 'verdict' in value)) as Record<string, { verdict: 'keep' | 'dismiss' } | null>}
                  onDirectiveVerdict={(itemId, verdict) => setValue(itemId, { verdict })}
                  onContentGateChange={setContentGate} />
              ) : null}
              <div className="sr-only" role="status" aria-live="polite">{status}</div>
            </div>
          );
  return (
    <DetailPaneShell
      as="section"
      className="briefing-detail"
      headerClassName="briefing-detail__header"
      headerPrimaryClassName="briefing-detail__header-primary"
      bodyClassName="briefing-detail__body"
      footerClassName="briefing-detail__footer"
      headerRef={headerRef}
      ariaBusy={load.loading}
      header={(
        <div className="briefing-detail__heading">
          <DetailHeaderIdentity
            className="briefing-detail__eyebrow"
            contextLabel="Briefing"
            shortId={shortRouteId(briefingId)}
            copyValue={briefingId}
            copyLabel="Copy full Briefing ID"
          />
          <div className="briefing-detail__title-row">
            <h2 title={title}>{title}</h2>
            {round ? (
              <div className="briefing-detail__actions">
                <button
                  type="button"
                  className="briefing-detail__actions-trigger"
                  aria-label="Briefing actions"
                  aria-haspopup="menu"
                  aria-expanded={actionsOpen}
                  onClick={() => setActionsOpen((open) => !open)}
                >
                  <HorizontalDotsIcon />
                </button>
                {actionsOpen ? (
                  <div className="briefing-detail__actions-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setMetadataOpen(true); }}>Metadata</button>
                    {artifactVersionRef ? (
                      <a role="menuitem" href={artifactDetailHref(displayResourceRef(artifactVersionRef))} onClick={() => setActionsOpen(false)}>Go to artifact version</a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {round ? (
            <div className="briefing-detail__meta">
              <div className="briefing-detail__controls">
                <span>Round occurrence</span>
                {selectedIsNewest ? <span className="briefing-detail__latest">Latest</span> : null}
                <select
                  aria-label="Round occurrence"
                  value={round.selected_round_id}
                  onInput={(event) => onRoundChange?.(event.currentTarget.value === round.latest_round_id ? null : event.currentTarget.value)}
                >
                  {roundOptions.map(({ round: summary, label }) => <option key={summary.id} value={summary.id}>{label}</option>)}
                </select>
                <BriefingRoundCopyButton value={round.selected_round_id} />
              </div>
            </div>
          ) : null}
        </div>
      )}
      footer={round?.valid ? (
        <>
          <button
            type="button"
            className="briefing-primary"
            aria-disabled={Boolean(submitReason)}
            aria-describedby={submitReason ? 'briefing-submit-reason' : undefined}
            title={submitReason ?? undefined}
            onClick={(event) => { if (submitReason) { event.preventDefault(); return; } void submit(); }}
            onKeyDown={(event) => { if (submitReason && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); }}
          >
            {busy ? 'Submitting…' : round.latest_submission_for_actor ? 'Submit correction' : 'Submit'}
          </button>
          {submitReason ? <span id="briefing-submit-reason" className="sr-only">{submitReason}</span> : null}
        </>
      ) : undefined}
      overlays={(
        <DetailPaneModal
          open={metadataOpen}
          onClose={() => setMetadataOpen(false)}
          titleId="briefing-metadata-title"
          title="Briefing metadata"
          closeLabel="Close Briefing metadata"
          excludeAboveRef={headerRef}
          scrollOwnerSelector=".feedback-collection-shell__content"
          panelClassName="briefing-detail__metadata"
        >
          <dl>
            <div><dt>Round occurrence</dt><dd>{selectedSummary ? roundLabels.get(selectedSummary.id) : 'Unavailable'}</dd></div>
            {round ? <div><dt>Round ID</dt><dd><DetailHeaderIdentity shortId={shortRouteId(round.selected_round_id)} copyValue={round.selected_round_id} copyLabel="Copy full round ID" /></dd></div> : null}
            {artifactVersionRef ? <div><dt>Pinned artifact version</dt><dd><DetailHeaderIdentity shortId={displayResourceRef(artifactVersionRef)} copyValue={artifactVersionRef} copyLabel="Copy exact artifact-version ref" /></dd></div> : null}
          </dl>
        </DetailPaneModal>
      )}
    >
      {body}
    </DetailPaneShell>
  );
}

function HorizontalDotsIcon(): JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>;
}

function BriefingRoundCopyButton({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const label = copied ? 'Copied selected round ref' : 'Copy full selected round ref';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="briefing-detail__round-copy" aria-label={label} title={label} onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon(): JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
}

function CheckIcon(): JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
}

export default BriefingDocumentRenderer;
