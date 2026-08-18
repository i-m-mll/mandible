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
  type BriefingSubmissionAnswer,
  type InstanceInfo,
} from '../../api';
import { useAppShell } from '../../app-shell';
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
  roundId?: string | null;
  instance: InstanceInfo | null;
  onBriefingChange?(briefing: BriefingProjection | null): void;
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

export function BriefingDocumentRenderer({
  briefingId,
  roundId = null,
  instance,
  onBriefingChange,
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
      if (round.briefing_id !== briefingId || (roundId && round.selected_round_id !== roundId)) throw new Error('The Briefing service returned a mismatched immutable round.');
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
  const profile = round?.document?.profile === 'mandible-briefing.v1';
  const itemById = useMemo(
    () => new Map((round?.items ?? []).map((item) => [item.id, item])),
    [round],
  );
  const childrenByParent = useMemo(() => {
    const children = new Map<string | null, BriefingDirectiveItem[]>();
    for (const item of round?.items ?? []) {
      const parent = item.parent_item_id && itemById.has(item.parent_item_id) ? item.parent_item_id : null;
      children.set(parent, [...(children.get(parent) ?? []), item]);
    }
    return children;
  }, [round, itemById]);

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
    && (!profile || round.directive_binding?.status === 'valid')
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
    ? (round?.directive_binding?.reason || 'This round is read-only for the current identity or instance.')
    : profile && round?.directive_binding?.status !== 'valid'
      ? (round.directive_binding.reason || 'The directive binding is unavailable.')
      : profile && contentGate === null ? 'Loading pinned document…'
      : contentGate ? contentGate
      : busy ? 'Submitting changes…'
        : requiredIncomplete ? 'Complete the required directives before submitting.'
          : !draftDiffers && frozenMatches ? 'No answer or annotation changes since your latest submission.'
            : null;

  const submit = async () => {
    if (!round || !canMutate || busy || (profile && contentGate !== '')) return;
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
        let desired = draft[item.id] ?? null;
        if (item.revision.response_type === 'free_text' && desired && 'text' in desired && !desired.text.trim()) {
          desired = null;
        }
        if (item.revision.response_type === 'multi_choice'
            && desired && 'option_keys' in desired && desired.option_keys.length === 0) {
          desired = null;
        }
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

  const renderItem = (item: BriefingDirectiveItem): JSX.Element => {
    const childItems = childrenByParent.get(item.id) ?? [];
    if (item.item_kind === 'group') {
      return (
        <section className="briefing-document__group" aria-labelledby={`${inputId(item)}-title`} key={item.id}>
          <h3 id={`${inputId(item)}-title`}>{item.revision.title || item.revision.prompt}</h3>
          {item.revision.title && item.revision.prompt ? <p>{item.revision.prompt}</p> : null}
          {item.revision.description ? <p>{item.revision.description}</p> : null}
          {childItems.map(renderItem)}
        </section>
      );
    }
    const value = draft[item.id] ?? null;
    const error = validationErrors[item.id];
    const describedBy = [item.revision.description ? `${inputId(item)}-description` : '', error ? `${inputId(item)}-error` : '']
      .filter(Boolean).join(' ') || undefined;
    const common = {
      disabled: !canMutate || busy,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy,
    };
    let control: JSX.Element;
    if (item.revision.response_type === 'free_text') {
      control = (
        <textarea
          id={inputId(item)}
          value={value && 'text' in value ? value.text : ''}
          onInput={(event) => setValue(item.id, { text: event.currentTarget.value })}
          {...common}
        />
      );
    } else {
      const options = item.revision.response_type === 'verdict'
        ? [{ option_key: 'keep', label: 'Keep', description: null, position: 0 }, { option_key: 'dismiss', label: 'Dismiss', description: null, position: 1 }]
        : item.revision.options;
      const multi = item.revision.response_type === 'multi_choice';
      control = (
        <fieldset id={inputId(item)} {...common}>
          <legend className="sr-only">{item.revision.title || item.revision.prompt}</legend>
          {options.map((option) => {
            const checked = multi
              ? Boolean(value && 'option_keys' in value && value.option_keys.includes(option.option_key))
              : item.revision.response_type === 'verdict'
                ? Boolean(value && 'verdict' in value && value.verdict === option.option_key)
                : Boolean(value && 'option_key' in value && value.option_key === option.option_key);
            return (
              <label className="briefing-document__choice" key={option.option_key}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`round-answer-${item.id}`}
                  value={option.option_key}
                  checked={checked}
                  onChange={() => {
                    if (multi) {
                      const selected = new Set(value && 'option_keys' in value ? value.option_keys : []);
                      if (selected.has(option.option_key)) selected.delete(option.option_key);
                      else selected.add(option.option_key);
                      setValue(item.id, {
                        option_keys: options.map((candidate) => candidate.option_key).filter((key) => selected.has(key)),
                      });
                    } else if (item.revision.response_type === 'verdict') {
                      setValue(item.id, { verdict: option.option_key as 'keep' | 'dismiss' });
                    } else setValue(item.id, { option_key: option.option_key });
                  }}
                  {...common}
                />
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </label>
            );
          })}
        </fieldset>
      );
    }
    return (
      <div className={`briefing-document__item${error ? ' briefing-document__item--invalid' : ''}`} key={item.id}>
        <label htmlFor={item.revision.response_type === 'free_text' ? inputId(item) : undefined}>
          <strong>{item.revision.title || item.revision.prompt}</strong>
          {item.revision.required ? <span className="briefing-document__required"> Required</span> : null}
        </label>
        {item.revision.title && item.revision.prompt ? <p>{item.revision.prompt}</p> : null}
        {item.revision.description ? <p id={`${inputId(item)}-description`}>{item.revision.description}</p> : null}
        {control}
        {error ? <p id={`${inputId(item)}-error`} className="briefing-document__field-error">{error}</p> : null}
        {childItems.map(renderItem)}
      </div>
    );
  };

  if (load.loading && !round) return <div className="briefing-empty" role="status">Loading Briefing round…</div>;
  if (load.error && !round) return <div className="briefing-error" role="alert">{load.error}</div>;
  if (!round) return <div className="briefing-empty" role="status">Briefing round unavailable.</div>;
  if (!round.valid) {
    return <div className="briefing-error" role="alert">This Briefing round has an invalid or unsupported projection and is read-only.</div>;
  }

  const roots = childrenByParent.get(null) ?? [];
  return (
    <article className="briefing-document" data-testid="briefing-document-renderer">
      <header className="briefing-document__header">
        <div>
          <span className="briefing-eyebrow">Briefing round</span>
          <h2>{round.briefing_key || round.selected_round_id}</h2>
        </div>
        <span className={`briefing-chip briefing-chip--${round.state}`}>{round.state}</span>
      </header>
      {!canMutate ? (
        <p className="briefing-document__read-only" role="status">
          This round is read-only for the current identity or instance.
        </p>
      ) : null}
      {Object.keys(validationErrors).length > 0 ? (
        <div className="briefing-document__validation" role="alert">
          Complete {Object.keys(validationErrors).length} required answer{Object.keys(validationErrors).length === 1 ? '' : 's'}.
        </div>
      ) : null}
      {round.document ? (
        <BriefingDocumentPanel briefingId={briefingId} roundId={round.selected_round_id} round={round} canMutate={canMutate && !busy && (!profile || contentGate === '')} onRefresh={reconcile}
          draft={Object.fromEntries(Object.entries(draft).filter(([, value]) => !value || 'verdict' in value)) as Record<string, { verdict: 'keep' | 'dismiss' } | null>}
          onDirectiveVerdict={(itemId, verdict) => setValue(itemId, { verdict })}
          onContentGateChange={setContentGate} />
      ) : null}
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        {!profile ? roots.map(renderItem) : null}
        {(!profile && canMutate) ? <button type="submit" className="briefing-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button> : null}
        {profile ? <div className="briefing-document__submit-bar" role="region" aria-label="Round submission">
          <button type="submit" className="briefing-primary" disabled={Boolean(submitReason)}>{busy ? 'Submitting…' : round.latest_submission_for_actor ? 'Submit correction' : 'Submit'}</button>
          {submitReason ? <span className="briefing-document__submit-reason">{submitReason}</span> : null}
        </div> : null}
      </form>
      <div className="briefing-document__status" role="status" aria-live="polite">{status}</div>
    </article>
  );
}

export default BriefingDocumentRenderer;
