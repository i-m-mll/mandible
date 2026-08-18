import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getAsk,
  getClientAuthWhoami,
  isApiErrorStatus,
  postAskAnswers,
  postAskSubmission,
  type AskAnswerOperation,
  type AskItem,
  type AskProjection,
  type AskResponseValue,
  type AskSubmissionAnswer,
  type InstanceInfo,
} from '../../api';
import { useAppShell } from '../../app-shell';
import {
  effectiveDraft,
  loadAskDraft,
  responseValuesEqual,
  saveAskDraft,
  type AskDraft,
} from './ask-view-state';
import { AskDocumentPanel } from './AskDocumentPanel';

export type BoundedAskRendererProps = {
  askId: string;
  instance: InstanceInfo | null;
  onAskChange?(ask: AskProjection | null): void;
};

type LoadState = { ask: AskProjection | null; loading: boolean; error: string | null };

function storageOrNull(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function meaningful(value: AskResponseValue | null): boolean {
  if (!value) return false;
  if ('text' in value) return value.text.trim().length > 0;
  if ('option_keys' in value) return value.option_keys.length > 0;
  return true;
}

function inputId(item: AskItem): string {
  return `bounded-ask-${item.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

export function BoundedAskRenderer({
  askId,
  instance,
  onAskChange,
}: BoundedAskRendererProps): JSX.Element {
  const { active } = useAppShell();
  const [load, setLoad] = useState<LoadState>({ ask: null, loading: true, error: null });
  const [userId, setUserId] = useState<string | null>(null);
  const [userKind, setUserKind] = useState<string | null>(null);
  const [draft, setDraft] = useState<AskDraft>({});
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contentGate, setContentGate] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const currentAskId = useRef(askId);
  currentAskId.current = askId;

  const reconcile = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoad((current) => ({ ...current, loading: current.ask === null, error: null }));
    try {
      const [identity, ask] = await Promise.all([getClientAuthWhoami(), getAsk(askId)]);
      if (sequence !== loadSequence.current || currentAskId.current !== askId) return null;
      if (ask.ask_id !== askId) throw new Error('The ask service returned a mismatched ask identity.');
      const nextUserId = identity.authenticated ? identity.user?.id ?? null : null;
      setUserId(nextUserId);
      setUserKind(identity.user?.kind ?? null);
      setLoad({ ask, loading: false, error: null });
      onAskChange?.(ask);
      const nextDraftScope = `${nextUserId ?? 'memory'}:${askId}`;
      setDraft((current) => {
        if (draftScope === nextDraftScope) return current;
        const stored = loadAskDraft(storageOrNull(), nextUserId, askId, ask.items);
        return Object.keys(stored).length > 0 ? stored : effectiveDraft(ask.items);
      });
      setDraftScope(nextDraftScope);
      return ask;
    } catch (error) {
      if (sequence !== loadSequence.current || currentAskId.current !== askId) return null;
      const message = error instanceof Error ? error.message : String(error);
      setLoad((current) => ({ ...current, loading: false, error: message }));
      onAskChange?.(null);
      return null;
    }
  }, [askId, draftScope, onAskChange]);

  useEffect(() => {
    loadSequence.current += 1;
    mutationSequence.current += 1;
    setLoad({ ask: null, loading: true, error: null });
    setUserId(null);
    setUserKind(null);
    setBusy(false);
    setContentGate(null);
    setDraftScope(null);
    setValidationErrors({});
    setStatus(null);
    onAskChange?.(null);
    void reconcile();
  }, [askId]); // Deliberately reload/hydrate only when the deep-linked identity changes.

  useEffect(() => {
    if (!active) return undefined;
    let timer: number | null = null;
    const onFeedback = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; data?: { ask_id?: string } }>).detail;
      const type = detail?.type;
      if (type !== 'reconnected' && !type?.startsWith('ask:')) return;
      if (detail?.data?.ask_id && detail.data.ask_id !== askId) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        setReload((value) => value + 1);
      }, 100);
    };
    window.addEventListener('feedback:sse', onFeedback);
    return () => {
      window.removeEventListener('feedback:sse', onFeedback);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, askId]);

  useEffect(() => {
    if (reload === 0 || !active) return;
    void reconcile();
  }, [active, reload]);

  useEffect(() => {
    if (draftScope !== `${userId ?? 'memory'}:${askId}`) return;
    saveAskDraft(storageOrNull(), userId, askId, draft);
  }, [askId, draft, draftScope, userId]);

  const ask = load.ask;
  const profile = ask?.document?.profile === 'mandible-briefing.v1';
  const itemById = useMemo(
    () => new Map((ask?.items ?? []).map((item) => [item.id, item])),
    [ask],
  );
  const childrenByParent = useMemo(() => {
    const children = new Map<string | null, AskItem[]>();
    for (const item of ask?.items ?? []) {
      const parent = item.parent_item_id && itemById.has(item.parent_item_id) ? item.parent_item_id : null;
      children.set(parent, [...(children.get(parent) ?? []), item]);
    }
    return children;
  }, [ask, itemById]);

  const setValue = (itemId: string, value: AskResponseValue | null) => {
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
    ask?.valid
    && ask.ask_id === askId
    && userId
    && userKind === 'human'
    && ask.responder_user_ids.includes(userId)
    && ask.items.every((item) => item.responseVisible)
    && (ask.state === 'open' || ask.state === 'submitted')
    && (!profile || ask.directive_binding?.status === 'valid')
    && (!instance || instance.operational_mutations === 'allow'),
  );
  const requiredIncomplete = Boolean(ask?.items.some((item) => item.item_kind === 'item' && item.revision.required && !meaningful(draft[item.id] ?? null)));
  const draftDiffers = Boolean(ask?.items.some((item) => item.item_kind === 'item'
    && !responseValuesEqual(draft[item.id] ?? null, item.effective_response?.value ?? null)));
  const currentAnswerIds = (ask?.items ?? []).flatMap((item) => item.effective_response ? [item.effective_response.response_event_id] : []);
  const currentAnnotationIds = (ask?.annotations ?? []).map((annotation) => annotation.annotation_event_id);
  const frozenMatches = Boolean(ask?.latest_frozen_membership
    && currentAnswerIds.length === ask.latest_frozen_membership.answer_event_ids.length
    && currentAnnotationIds.length === ask.latest_frozen_membership.annotation_event_ids.length
    && currentAnswerIds.every((id) => ask.latest_frozen_membership!.answer_event_ids.includes(id))
    && currentAnnotationIds.every((id) => ask.latest_frozen_membership!.annotation_event_ids.includes(id)));
  const submitReason = !canMutate
    ? (ask?.directive_binding?.reason || 'This ask is read-only for the current identity or instance.')
    : profile && ask?.directive_binding?.status !== 'valid'
      ? (ask.directive_binding.reason || 'The directive binding is unavailable.')
      : profile && contentGate === null ? 'Loading pinned document…'
      : contentGate ? contentGate
      : busy ? 'Submitting changes…'
        : requiredIncomplete ? 'Complete the required directives before submitting.'
          : !draftDiffers && frozenMatches ? 'No answer or annotation changes since your latest submission.'
            : null;

  const submit = async () => {
    if (!ask || !canMutate || busy) return;
    const mutation = ++mutationSequence.current;
    const submittedAskId = ask.ask_id;
    const mutationIsCurrent = () => mutationSequence.current === mutation
      && currentAskId.current === submittedAskId;
    const invalid: Record<string, string> = {};
    for (const item of ask.items) {
      if (item.item_kind !== 'item' || !item.revision.required) continue;
      if (!meaningful(draft[item.id] ?? null)) invalid[item.id] = 'This answer is required.';
    }
    if (Object.keys(invalid).length > 0) {
      setValidationErrors(invalid);
      setStatus('Complete the required answers before submitting.');
      const first = ask.items.find((item) => invalid[item.id]);
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
      const answerItems = ask.items.filter((item) => item.item_kind === 'item');
      const operations: AskAnswerOperation[] = [];
      const changedItems: AskItem[] = [];
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
          item_id: item.id,
          item_revision_id: item.revision.id,
          operation: desired === null ? 'retract' : 'set',
          expected_response_event_id: item.effective_response?.response_event_id ?? null,
          ...(desired === null ? {} : { value: desired }),
        });
      }

      const answerResult = operations.length > 0
        ? await postAskAnswers(ask.ask_id, operations)
        : { answer_event_ids: [] };
      if (answerResult.answer_event_ids.length !== operations.length) {
        throw new Error('The answer service returned an ambiguous answer-event result.');
      }
      const changedEventIds = new Map(changedItems.map((item, index) => [
        item.id,
        operations[index].operation === 'set' ? answerResult.answer_event_ids[index] : null,
      ]));
      const submissionAnswers: AskSubmissionAnswer[] = [];
      for (const item of answerItems) {
        if (changedEventIds.has(item.id)) {
          const eventId = changedEventIds.get(item.id);
          if (eventId) submissionAnswers.push({
            item_id: item.id,
            item_revision_id: item.revision.id,
            response_event_id: eventId,
          });
        } else if (item.effective_response) {
          submissionAnswers.push({
            item_id: item.id,
            item_revision_id: item.revision.id,
            response_event_id: item.effective_response.response_event_id,
          });
        }
      }
      await postAskSubmission(ask.ask_id, {
        expected_lifecycle_event_id: ask.lifecycle_event_id,
        ...(ask.latest_submission_for_actor
          ? { supersedes_submission_id: ask.latest_submission_for_actor.id }
          : {}),
        answers: submissionAnswers,
        annotations: (ask.annotations ?? []).map((annotation) => ({
          annotation_event_id: annotation.annotation_event_id,
        })),
      });
      saveAskDraft(storageOrNull(), userId, ask.ask_id, {});
      if (!mutationIsCurrent()) return;
      const refreshed = await reconcile();
      if (refreshed) setDraft(effectiveDraft(refreshed.items));
      setStatus(ask.state === 'submitted' ? 'Correction submitted.' : 'Answers submitted.');
      setValidationErrors({});
    } catch (error) {
      if (!mutationIsCurrent()) return;
      setStatus(error instanceof Error ? error.message : String(error));
      // The answer batch may have landed even when submit failed. Refetch both
      // ordinary failures and 409s, preserving the unsaved local draft.
      await reconcile();
      if (isApiErrorStatus(error, 409)) setStatus(`The ask changed. ${error.message}`);
    } finally {
      if (mutationIsCurrent()) setBusy(false);
    }
  };

  const renderItem = (item: AskItem): JSX.Element => {
    const childItems = childrenByParent.get(item.id) ?? [];
    if (item.item_kind === 'group') {
      return (
        <section className="bounded-ask__group" aria-labelledby={`${inputId(item)}-title`} key={item.id}>
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
              <label className="bounded-ask__choice" key={option.option_key}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`ask-answer-${item.id}`}
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
      <div className={`bounded-ask__item${error ? ' bounded-ask__item--invalid' : ''}`} key={item.id}>
        <label htmlFor={item.revision.response_type === 'free_text' ? inputId(item) : undefined}>
          <strong>{item.revision.title || item.revision.prompt}</strong>
          {item.revision.required ? <span className="bounded-ask__required"> Required</span> : null}
        </label>
        {item.revision.title && item.revision.prompt ? <p>{item.revision.prompt}</p> : null}
        {item.revision.description ? <p id={`${inputId(item)}-description`}>{item.revision.description}</p> : null}
        {control}
        {error ? <p id={`${inputId(item)}-error`} className="bounded-ask__field-error">{error}</p> : null}
        {childItems.map(renderItem)}
      </div>
    );
  };

  if (load.loading && !ask) return <div className="briefing-empty" role="status">Loading ask…</div>;
  if (load.error && !ask) return <div className="briefing-error" role="alert">{load.error}</div>;
  if (!ask) return <div className="briefing-empty" role="status">Ask unavailable.</div>;
  if (!ask.valid) {
    return <div className="briefing-error" role="alert">This ask has an invalid or unsupported projection and is read-only.</div>;
  }

  const roots = childrenByParent.get(null) ?? [];
  return (
    <article className="bounded-ask" data-testid="bounded-ask-renderer">
      <header className="bounded-ask__header">
        <div>
          <span className="briefing-eyebrow">Bounded ask</span>
          <h2>{ask.request_key || 'Agent question'}</h2>
        </div>
        <span className={`briefing-chip briefing-chip--${ask.state}`}>{ask.state}</span>
      </header>
      {!canMutate ? (
        <p className="bounded-ask__read-only" role="status">
          {ask.state === 'expired' || ask.state === 'cancelled' || ask.state === 'closed'
            ? `This ask is ${ask.state} and is read-only.`
            : 'This ask is read-only for the current identity or instance.'}
        </p>
      ) : null}
      {Object.keys(validationErrors).length > 0 ? (
        <div className="bounded-ask__validation" role="alert">
          Complete {Object.keys(validationErrors).length} required answer{Object.keys(validationErrors).length === 1 ? '' : 's'}.
        </div>
      ) : null}
      {ask.document ? (
        <AskDocumentPanel ask={ask} canMutate={canMutate && !busy} onRefresh={reconcile}
          draft={Object.fromEntries(Object.entries(draft).filter(([, value]) => !value || 'verdict' in value)) as Record<string, { verdict: 'keep' | 'dismiss' } | null>}
          onDirectiveVerdict={(itemId, verdict) => setValue(itemId, { verdict })}
          onContentGateChange={setContentGate} />
      ) : null}
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        {!profile ? roots.map(renderItem) : null}
        {(!profile && canMutate) ? <button type="submit" className="briefing-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button> : null}
        {profile ? <div className="bounded-ask__submit-bar" role="region" aria-label="Round submission">
          <button type="submit" className="briefing-primary" disabled={Boolean(submitReason)}>{busy ? 'Submitting…' : ask.latest_submission_for_actor ? 'Submit correction' : 'Submit'}</button>
          {submitReason ? <span className="bounded-ask__submit-reason">{submitReason}</span> : null}
        </div> : null}
      </form>
      <div className="bounded-ask__status" role="status" aria-live="polite">{status}</div>
    </article>
  );
}

export default BoundedAskRenderer;
