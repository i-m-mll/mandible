import { NativeSelect } from '../../components/shared/NativeSelect';
import { useQuery } from '@tanstack/preact-query';
import { queryClient } from '../../query/client';
import { ROUTE_DATA_FRESH_MS } from '../../detail-cache';
import { browserResourceKeys } from '../../query/browserResources';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getBriefing,
  getBriefingReviewedMarkdown,
  getClientAuthWhoami,
  isApiErrorStatus,
  postBriefingAnswers,
  postBriefingAnnotations,
  postBriefingSubmission,
  updateBriefingTitle,
  type BriefingAnswerOperation,
  type BriefingDirectiveItem,
  type BriefingProjection,
  type BriefingResponseValue,
  type BriefingRoundSummary,
  type BriefingSubmissionAnswer,
  type BriefingSubmissionOverlaySummary,
  type InstanceInfo,
} from '../../api';
import { useRouteLoad, useViewActive } from '../../app-shell';
import { DetailHeaderIdentity } from '../../components/shared/DetailHeaderIdentity';
import { DetailPaneHeader } from '../../components/shared/DetailPaneHeader';
import { DetailPaneMenuTrigger } from '../../components/shared/DetailPaneMenuTrigger';
import { DetailPaneModal } from '../../components/shared/DetailPaneModal';
import { DetailPaneShell } from '../../components/shared/DetailPaneShell';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';

import { artifactDetailHref, displayResourceRef } from '../../resource-refs';
import { shortRouteId } from '../../routing';
import {
  effectiveDraft,
  loadBriefingDraft,
  responseValuesEqual,
  saveBriefingDraft,
  type BriefingDraft,
  type BriefingDraftScope,
} from './briefing-round-view-state';
import { BriefingDocumentPanel } from './BriefingDocumentPanel';

export type BriefingDocumentRendererProps = {
  briefingId: string;
  briefingTitle?: string;
  briefingDescription?: string | null;
  roundId?: string | null;
  displayContext?: { groupId: string; proposalBundleId: string | null };
  instance: InstanceInfo | null;
  onBriefingChange?(briefing: BriefingProjection | null): void;
  onTitleChange?(title: string): void;
  onRoundChange?(roundId: string | null): void;
  keepSubmittedAnnotations?: boolean;
};

type SubmissionSort = { field: 'date' | 'actor' | 'annotations'; direction: 'asc' | 'desc' };

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

function draftStorageScope(briefingId: string, round: BriefingProjection): BriefingDraftScope | null {
  return round.document ? {
    briefingId,
    roundId: round.selected_round_id,
    artifactVersionId: round.document.artifact_version_id,
    profile: round.document.profile,
  } : null;
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
  briefingDescription = null,
  roundId = null,
  displayContext,
  instance,
  onBriefingChange,
  onTitleChange,
  onRoundChange,
  keepSubmittedAnnotations = false,
}: BriefingDocumentRendererProps): JSX.Element {
  const active = useViewActive();
  const [draft, setDraft] = useState<BriefingDraft>({});
  const [draftScope, setDraftScope] = useState<string | null>(null);
  const draftBaseline = useRef<{ scope: string | null; values: BriefingDraft } | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contentGate, setContentGate] = useState<string | null>(null);
  const [documentFailure, setDocumentFailure] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [hideSubmittedAnnotations, setHideSubmittedAnnotations] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const [resultCopied, setResultCopied] = useState(false);
  const [submissionSort, setSubmissionSort] = useState<SubmissionSort>({ field: 'date', direction: 'desc' });
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const shelfBodyRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuStyle = useAnchoredMenu({
    open: actionsOpen,
    anchorRef: actionsTriggerRef,
    menuRef: actionsMenuRef,
    onDismiss: () => setActionsOpen(false),
  });
  const mutationSequence = useRef(0);
  const selectionKey = (overlayId: string | null) => `${briefingId}:${roundId ?? 'latest'}:${overlayId ?? 'respond-now'}`;
  const currentSelection = useRef(selectionKey(selectedOverlayId));
  currentSelection.current = selectionKey(selectedOverlayId);

  const projectionKey = browserResourceKeys.briefingProjection(briefingId, roundId, selectedOverlayId, displayContext);
  const projectionQuery = useQuery({
    queryKey: projectionKey,
    queryFn: async ({ signal }) => {
      const round = await getBriefing(briefingId, roundId, selectedOverlayId, signal, displayContext);
      if (round.briefing_id !== briefingId || (roundId && !round.selected_round_id.startsWith(roundId))) {
        throw new Error('The Briefing service returned a mismatched immutable round.');
      }
      return round;
    },
    enabled: active,
    staleTime: ROUTE_DATA_FRESH_MS,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === briefingId && previousQuery.queryKey[3] === roundId ? previous : undefined,
    refetchOnWindowFocus: true,
  }, queryClient);
  const identityQuery = useQuery({
    queryKey: ['local', 'identity'],
    queryFn: () => getClientAuthWhoami(),
    enabled: active,
    refetchOnWindowFocus: true,
  }, queryClient);
  const userId = identityQuery.data?.authenticated ? identityQuery.data.user?.id ?? null : null;
  const userKind = identityQuery.data?.user?.kind ?? null;
  const load = {
    round: projectionQuery.data ?? null,
    loading: projectionQuery.isFetching || identityQuery.isPending,
    error: projectionQuery.error?.message ?? identityQuery.error?.message ?? null,
  };
  const reconcile = useCallback(async (overlayId: string | null = selectedOverlayId) => {
    const key = browserResourceKeys.briefingProjection(briefingId, roundId, overlayId, displayContext);
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    try {
      return await queryClient.fetchQuery({
        queryKey: key,
        queryFn: ({ signal }) => getBriefing(briefingId, roundId, overlayId, signal, displayContext),
        staleTime: 0,
      });
    } catch {
      return null;
    }
  }, [briefingId, roundId, selectedOverlayId, displayContext?.groupId, displayContext?.proposalBundleId]);

  useRouteLoad((register) => {
    if (projectionQuery.isStale) register(projectionQuery.refetch({ cancelRefetch: false }));
  }, [briefingId, roundId, selectedOverlayId, displayContext?.groupId, displayContext?.proposalBundleId]);

  useEffect(() => {
    const round = projectionQuery.data;
    if (!round || !identityQuery.data) return;
    onBriefingChange?.(round);
    const storageScope = draftStorageScope(briefingId, round);
    const nextDraftScope = storageScope
      ? `${userId ?? 'memory'}:${storageScope.briefingId}:${storageScope.roundId}:${storageScope.artifactVersionId}:${storageScope.profile}`
      : null;
    const nextBaseline = effectiveDraft(round.items);
    const previousBaseline = draftBaseline.current;
    draftBaseline.current = { scope: nextDraftScope, values: nextBaseline };
    setDraft((current) => {
      if (round.selected_submission_overlay) return nextBaseline;
      if (draftScope === nextDraftScope && previousBaseline?.scope === nextDraftScope) {
        // Refresh canonical defaults without overwriting values the user edited.
        let reconciled = current;
        for (const [id, value] of Object.entries(nextBaseline)) {
          if ((!(id in current) || responseValuesEqual(current[id], previousBaseline.values[id] ?? null))
            && !responseValuesEqual(current[id] ?? null, value)) {
            if (reconciled === current) reconciled = { ...current };
            reconciled[id] = value;
          }
        }
        return reconciled;
      }
      const stored = storageScope ? loadBriefingDraft(storageOrNull(), userId, storageScope, round.items) : {};
      return Object.keys(stored).length > 0 ? stored : effectiveDraft(round.items);
    });
    setDraftScope(round.selected_submission_overlay ? null : nextDraftScope);
  }, [projectionQuery.data, identityQuery.data, userId, briefingId, draftScope]);

  useEffect(() => {
    mutationSequence.current += 1;
    setBusy(false);
    setContentGate(null);
    setDocumentFailure(null);
    setValidationErrors({});
    setStatus(null);
    setExportBusy(false);
    setExportError(null);
    setHideSubmittedAnnotations(false);
    setResultId(null);
    setResultCopied(false);
    setClearConfirmOpen(false);
    setClearBusy(false);
  }, [briefingId, roundId]);

  useEffect(() => {
    if (!load.round || load.round.selected_submission_overlay) return;
    const scope = draftStorageScope(briefingId, load.round);
    const expected = scope ? `${userId ?? 'memory'}:${scope.briefingId}:${scope.roundId}:${scope.artifactVersionId}:${scope.profile}` : null;
    if (!scope || draftScope !== expected) return;
    saveBriefingDraft(storageOrNull(), userId, scope, draft);
  }, [briefingId, draft, draftScope, load.round, userId]);

  const round = load.round;
  const setValue = (itemId: string, value: BriefingResponseValue | null) => {
    setDraft((current) => ({ ...current, [itemId]: value }));
    setValidationErrors((current) => {
      if (!current[itemId] || !meaningful(value)) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
    setStatus(null);
  };

  const canMutate = Boolean(
    !load.loading
    && load.error === null
    && round?.valid
    && !round.selected_submission_overlay
    && round.briefing_id === briefingId
    && round.selected_round_id === round.round_id
    && (roundId ? round.selected_round_id.startsWith(roundId) : round.selected_round_id === round.latest_round_id)
    && userId
    && userKind === 'human'
    && round.items.every((item) => item.responseVisible)
    && (round.state === 'open' || round.state === 'submitted')
    && round.directive_binding?.status === 'valid'
    && instance?.allowed_effects?.includes('ledger:write') === true,
  );
  const requiredIncomplete = Boolean(round?.items.some((item) => item.item_kind === 'item' && item.revision.required && !meaningful(draft[item.id] ?? null)));
  const draftDiffers = Boolean(round?.items.some((item) => item.item_kind === 'item'
    && !responseValuesEqual(draft[item.id] ?? null, item.effective_response?.value ?? null)));
  const currentAnswerIds = (round?.items ?? []).flatMap((item) => item.effective_response ? [item.effective_response.response_event_id] : []);
  const currentAnnotationIds = (round?.annotations ?? []).map((annotation) => annotation.annotation_event_id);
  const frozenAnnotationIds = new Set(round?.latest_frozen_membership?.annotation_event_ids ?? []);
  const pendingAnnotations = (round?.annotations ?? []).filter(
    (annotation) => !frozenAnnotationIds.has(annotation.annotation_event_id),
  );
  const frozenMatches = Boolean(round?.latest_frozen_membership
    && currentAnswerIds.length === round.latest_frozen_membership.answer_event_ids.length
    && currentAnnotationIds.length === round.latest_frozen_membership.annotation_event_ids.length
    && currentAnswerIds.every((id) => round.latest_frozen_membership!.answer_event_ids.includes(id))
    && currentAnnotationIds.every((id) => round.latest_frozen_membership!.annotation_event_ids.includes(id)));
  const emptyNoChange = !draftDiffers && currentAnswerIds.length === 0 && currentAnnotationIds.length === 0;
  const submitReason = !canMutate
    ? (round?.directive_binding?.reason || 'Submitting is unavailable for the current identity or instance.')
    : round?.directive_binding?.status !== 'valid'
      ? (round?.directive_binding?.reason || 'The directive binding is unavailable.')
      : contentGate === null ? 'Loading pinned document…'
      : contentGate ? contentGate
      : clearBusy ? 'Clearing pending annotations…'
        : busy ? 'Submitting changes…'
        : requiredIncomplete ? 'Complete the required directives before submitting.'
          : emptyNoChange ? 'Add an answer or annotation before submitting.'
          : !draftDiffers && frozenMatches ? 'No answer or annotation changes since your latest submission.'
            : null;

  const submit = async () => {
    if (!round || !canMutate || busy || clearBusy || contentGate !== '') return;
    const mutation = ++mutationSequence.current;
    const submittedRoundId = round.selected_round_id;
    const mutationIsCurrent = () => mutationSequence.current === mutation
      && currentSelection.current === selectionKey(null);
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
        const focusTarget = control?.matches('input, textarea, button')
          ? control as HTMLElement
          : control?.querySelector<HTMLElement>('input, textarea, button');
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
      const submission = await postBriefingSubmission(briefingId, submittedRoundId, {
        ...(round.latest_submission_for_actor
          ? { supersedes_submission_id: round.latest_submission_for_actor.id }
          : {}),
        answers: submissionAnswers,
        annotations: (round.annotations ?? []).map((annotation) => ({
          annotation_event_id: annotation.annotation_event_id,
        })),
      });
      const submittedScope = draftStorageScope(briefingId, round);
      if (submittedScope) saveBriefingDraft(storageOrNull(), userId, submittedScope, {});
      if (!mutationIsCurrent()) return;
      setSelectedOverlayId(null);
      currentSelection.current = selectionKey(null);
      setResultId(submission.submission_id);
      setResultCopied(false);
      setHideSubmittedAnnotations(!keepSubmittedAnnotations);
      const refreshed = await reconcile(null);
      if (refreshed) setDraft(effectiveDraft(refreshed.items));
      window.requestAnimationFrame(() => shelfBodyRef.current?.scrollTo({ top: 0 }));
      setStatus('Submitted.');
      setValidationErrors({});
    } catch (error) {
      if (!mutationIsCurrent()) return;
      setStatus(error instanceof Error ? error.message : String(error));
      // The answer batch may have landed even when submit failed. Refetch both
      // ordinary failures and 409s, preserving the unsaved local draft.
      await reconcile(selectedOverlayId);
      if (isApiErrorStatus(error, 409)) setStatus(`The round changed. ${error.message}`);
    } finally {
      if (mutationIsCurrent()) setBusy(false);
    }
  };

  const sortedSubmissionOverlays = useMemo(() => {
    const rows = [...(round?.submission_overlays ?? [])];
    const direction = submissionSort.direction === 'asc' ? 1 : -1;
    return rows.sort((left, right) => {
      let comparison = 0;
      if (submissionSort.field === 'date') comparison = left.created_at - right.created_at;
      else if (submissionSort.field === 'annotations') comparison = left.annotation_count - right.annotation_count;
      else comparison = (left.actor.display_name || left.actor.slug).localeCompare(right.actor.display_name || right.actor.slug);
      if (comparison === 0) comparison = left.ordinal - right.ordinal;
      if (comparison === 0) comparison = left.id.localeCompare(right.id);
      return comparison * direction;
    });
  }, [round?.submission_overlays, submissionSort]);

  const toggleSubmissionSort = (field: SubmissionSort['field']) => {
    setSubmissionSort((current) => current.field === field
      ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { field, direction: field === 'date' ? 'desc' : 'asc' });
  };

  const selectSubmissionOverlay = (submission: BriefingSubmissionOverlaySummary | null) => {
    const overlayId = submission?.id ?? null;
    setSelectedOverlayId(overlayId);
    setHideSubmittedAnnotations(false);
    setResultId(null);
    currentSelection.current = selectionKey(overlayId);
  };

  const resetDraft = (projection: BriefingProjection) => {
    const nextDraft = effectiveDraft(projection.items);
    setDraft(nextDraft);
    const scope = draftStorageScope(briefingId, projection);
    if (scope) saveBriefingDraft(storageOrNull(), userId, scope, {});
    setValidationErrors({});
    setResultId(null);
    setResultCopied(false);
    setStatus('Draft cleared.');
  };

  const requestClear = () => {
    if (!round || busy || clearBusy) return;
    if (round.selected_submission_overlay) {
      selectSubmissionOverlay(null);
      return;
    }
    if (pendingAnnotations.length === 0) {
      resetDraft(round);
      return;
    }
    if (canMutate) setClearConfirmOpen(true);
  };

  const confirmClear = async () => {
    if (!round || !canMutate || clearBusy || pendingAnnotations.length === 0) return;
    const annotationIds = pendingAnnotations.map((annotation) => annotation.annotation_event_id);
    setClearBusy(true);
    setStatus(null);
    try {
      const result = await postBriefingAnnotations(briefingId, round.selected_round_id, annotationIds.map((annotationEventId) => ({
        operation: 'retract' as const,
        annotation_event_id: annotationEventId,
      })));
      if (result.annotation_event_ids.length !== annotationIds.length) {
        throw new Error('The annotation service returned an ambiguous clear result.');
      }
      const refreshed = await reconcile(null);
      resetDraft(refreshed ?? round);
      setClearConfirmOpen(false);
      setStatus(`${annotationIds.length} pending annotation${annotationIds.length === 1 ? '' : 's'} cleared.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      await reconcile(null);
    } finally {
      setClearBusy(false);
    }
  };

  const copyResultId = async () => {
    if (!resultId || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(resultId);
    setResultCopied(true);
    window.setTimeout(() => setResultCopied(false), 1200);
  };

  const title = round?.title || briefingTitle || 'Briefing';
  const description = round?.description ?? briefingDescription;

  const openRename = () => {
    setActionsOpen(false);
    setRenameTitle(title);
    setRenameError(null);
    setRenameOpen(true);
  };

  const renameBriefing = async (event: Event) => {
    event.preventDefault();
    const nextTitle = renameTitle.trim();
    if (!nextTitle || nextTitle === title || renameBusy) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const updated = await updateBriefingTitle(briefingId, nextTitle);
      queryClient.setQueryData<BriefingProjection>(projectionKey, (current) => current ? { ...current, title: updated.title } : current);
      onTitleChange?.(updated.title);
      setRenameOpen(false);
      setStatus(updated.changed ? 'Briefing renamed.' : 'Briefing title unchanged.');
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenameBusy(false);
    }
  };

  const exportReviewedMarkdown = async () => {
    const submissionId = round?.latest_submission_for_actor?.id;
    if (!round || !submissionId || exportBusy) return;
    setActionsOpen(false);
    setExportBusy(true);
    setExportError(null);
    try {
      const result = await getBriefingReviewedMarkdown(briefingId, round.selected_round_id, submissionId);
      const url = URL.createObjectURL(new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(result.sha256 ? `Reviewed Markdown exported (${result.sha256.slice(0, 12)}…).` : 'Reviewed Markdown exported.');
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportBusy(false);
    }
  };
  const roundOptions = briefingRoundOptions(round?.rounds ?? []);
  const roundLabels = new Map(roundOptions.map(({ round: summary, label }) => [summary.id, label]));
  const selectedSummary = round?.rounds.find((candidate) => candidate.id === round.selected_round_id) ?? null;
  const newestRoundId = roundOptions[0]?.round.id ?? null;
  const selectedIsNewest = Boolean(round && newestRoundId && round.selected_round_id === newestRoundId);
  const artifactVersionId = selectedSummary?.artifact_version_id ?? round?.document?.artifact_version_id ?? null;
  const artifactVersionRef = artifactVersionId
    ? artifactVersionId.startsWith('artifact-version:') ? artifactVersionId : `artifact-version:${artifactVersionId}`
    : null;
  const displayedRound = round && hideSubmittedAnnotations && !round.selected_submission_overlay
    ? { ...round, annotations: [] }
    : round;
  const body = load.loading && !round
    ? <div className="briefing-empty" role="status">Loading Briefing…</div>
    : load.error && !round
      ? <div className="briefing-empty">Briefing content is temporarily unavailable.</div>
      : !round
        ? <div className="briefing-empty" role="status">Briefing unavailable.</div>
        : !round.valid
          ? <div className="briefing-empty">The selected Briefing cannot be displayed.</div>
          : (
            <div className="briefing-document" data-testid="briefing-document-renderer">
              {Object.keys(validationErrors).length > 0 ? (
                <div className="briefing-document__validation" role="alert">
                  Complete {Object.keys(validationErrors).length} required answer{Object.keys(validationErrors).length === 1 ? '' : 's'}.
                </div>
              ) : null}
              {round.document ? (
                <BriefingDocumentPanel briefingId={briefingId} briefingTitle={title} roundId={round.selected_round_id} round={displayedRound!} canMutate={canMutate && !busy && !clearBusy && contentGate === ''} draftIdentity={draftScope} onRefresh={() => reconcile(selectedOverlayId)}
                  draft={draft}
                  validationErrors={validationErrors}
                  onDirectiveValue={setValue}
                  onContentGateChange={setContentGate}
                  onDocumentFailureChange={setDocumentFailure} />
              ) : null}
              <div className="sr-only" role="status" aria-live="polite">{status}</div>
            </div>
          );
  return (
    <DetailPaneShell
      as="section"
      className="briefing-detail"
      headerClassName="briefing-detail__header"
      bodyClassName="briefing-detail__body"
      footerClassName="briefing-detail__footer"
      headerRef={headerRef}
      ariaBusy={load.loading}
      notice={load.error || exportError || (round && !round.valid) || documentFailure ? (
        <DetailPaneNotice severity="error" density="compact" title="Briefing needs attention">
          {[
            load.error,
            exportError,
            round && !round.valid ? 'The selected Briefing projection is invalid or unsupported.' : null,
            documentFailure,
          ].filter(Boolean).join(' · ')}
        </DetailPaneNotice>
      ) : null}
      header={(
        <DetailPaneHeader
          variant="versioned"
          identity={{
            displayRef: shortRouteId(briefingId).replace(/^briefing:/i, ''),
            canonicalRef: briefingId,
            copyLabel: 'Copy Briefing reference',
          }}
          title={title}
          titleTooltip={title}
          supportingMetadata={description ? <p className="briefing-detail__description">{description}</p> : undefined}
          state={round && selectedIsNewest
            ? (round.publication_mode === 'published-report' ? 'Current report' : 'Latest')
            : undefined}
          selector={round ? {
            label: round.publication_mode === 'published-report' ? 'Report history' : 'Round occurrence',
            control: (
              <NativeSelect
                aria-label={round.publication_mode === 'published-report' ? 'Report history' : 'Round occurrence'}
                value={round.selected_round_id}
                onInput={(event) => onRoundChange?.(event.currentTarget.value === round.latest_round_id ? null : event.currentTarget.value)}
              >
                {roundOptions.map(({ round: summary, label }) => <option key={summary.id} value={summary.id}>{label}</option>)}
              </NativeSelect>
            ),
            selectedCanonicalRef: round.selected_round_id,
            copyLabel: 'Copy selected round reference',
          } : undefined}
          actions={round ? (
            <>
              <DetailPaneMenuTrigger
                buttonRef={actionsTriggerRef}
                label="Briefing actions"
                expanded={actionsOpen}
                onClick={() => setActionsOpen((open) => !open)}
              />
              {actionsOpen ? (
                <div
                  ref={actionsMenuRef}
                  className="briefing-detail__actions-menu app-anchored-menu"
                  role="menu"
                  popover="manual"
                  style={actionsMenuStyle}
                >
                  {userKind === 'human' ? (
                    <button type="button" role="menuitem" onClick={openRename}>Rename Briefing</button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setMetadataOpen(true); }}>Metadata</button>
                  {round.latest_submission_for_actor ? (
                    <button type="button" role="menuitem" disabled={exportBusy} onClick={() => void exportReviewedMarkdown()}>
                      {exportBusy ? 'Exporting reviewed Markdown…' : 'Export reviewed Markdown'}
                    </button>
                  ) : null}
                  {artifactVersionRef ? (
                    <a role="menuitem" href={artifactDetailHref(displayResourceRef(artifactVersionRef))} onClick={() => setActionsOpen(false)}>Go to artifact version</a>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : undefined}
          actionsLabel="Briefing actions"
        />
      )}
      footer={round?.valid ? {
        content: (
          <div className="briefing-footer-content">
            <div className="briefing-footer-actions">
              {resultId ? (
                <button type="button" className="btn btn--sm btn--success briefing-copy-result" onClick={() => void copyResultId()}>
                  {resultCopied ? 'Copied result ID' : 'Copy result ID'}
                </button>
              ) : null}
              <button
                type="button"
                className="briefing-primary"
                aria-disabled={Boolean(submitReason)}
                aria-busy={busy}
                aria-describedby={submitReason ? 'briefing-submit-reason' : undefined}
                title={submitReason ?? undefined}
                onClick={(event) => { if (submitReason && !requiredIncomplete) { event.preventDefault(); return; } void submit(); }}
                onKeyDown={(event) => {
                  if (!submitReason || !requiredIncomplete || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  void submit();
                }}
              >
                Submit
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm briefing-clear"
                disabled={busy || clearBusy || (!round.selected_submission_overlay && pendingAnnotations.length > 0 && !canMutate)}
                onClick={requestClear}
              >
                Clear
              </button>
              {submitReason ? <span id="briefing-submit-reason" className="sr-only">{submitReason}</span> : null}
            </div>
            {round.submission_overlays.length === 0 ? (
              <div className="briefing-submission-shelf briefing-submission-shelf--inactive">Annotation sets (0)</div>
            ) : (
              <details className="briefing-submission-shelf">
                <summary>Annotation sets ({round.submission_overlays.length})</summary>
                <div ref={shelfBodyRef} className="briefing-submission-shelf__body">
                  <table role="grid" aria-label="Annotation sets for this round">
                    <thead>
                      <tr>
                        <th aria-sort={submissionSort.field === 'date' ? (submissionSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <button type="button" onClick={() => toggleSubmissionSort('date')}>Date</button>
                        </th>
                        <th aria-sort={submissionSort.field === 'actor' ? (submissionSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <button type="button" onClick={() => toggleSubmissionSort('actor')}>Actor</button>
                        </th>
                        <th aria-sort={submissionSort.field === 'annotations' ? (submissionSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <button type="button" onClick={() => toggleSubmissionSort('annotations')}>Annotations</button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSubmissionOverlays.map((submission) => (
                        <tr
                          key={submission.id}
                          tabIndex={0}
                          aria-selected={selectedOverlayId === submission.id}
                          aria-label={`View annotation set by ${submission.actor.display_name || submission.actor.slug}`}
                          className={selectedOverlayId === submission.id ? 'briefing-submission-shelf__row--selected' : undefined}
                          onClick={() => selectSubmissionOverlay(submission)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            selectSubmissionOverlay(submission);
                          }}
                        >
                          <td>{occurrenceDateTimeFormatter.format(new Date(submission.created_at))}</td>
                          <td>{submission.actor.display_name || submission.actor.slug}</td>
                          <td>{submission.annotation_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        ),
      } : undefined}
      overlays={(
        <>
          <DetailPaneModal
            open={renameOpen}
            onClose={() => { if (!renameBusy) setRenameOpen(false); }}
            titleId="briefing-rename-title"
            title="Rename Briefing"
            closeLabel="Close Rename Briefing"
            excludeAboveRef={headerRef}
            scrollOwnerSelector=".feedback-collection-shell__content"
            panelClassName="briefing-detail__rename"
          >
            <form className="briefing-detail__rename-form" onSubmit={(event) => void renameBriefing(event)}>
              <label htmlFor="briefing-rename-input">Briefing title</label>
              <input id="briefing-rename-input" autoFocus value={renameTitle}
                disabled={renameBusy} onInput={(event) => setRenameTitle(event.currentTarget.value)} />
              {renameError ? <DetailPaneNotice severity="error" title="Briefing rename failed">{renameError}</DetailPaneNotice> : null}
              <div className="briefing-detail__rename-actions">
                <button type="button" className="btn btn--ghost btn--sm" disabled={renameBusy} onClick={() => setRenameOpen(false)}>Cancel</button>
                <button type="submit" className="briefing-primary" disabled={renameBusy || !renameTitle.trim() || renameTitle.trim() === title}>
                  {renameBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </DetailPaneModal>
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
          <DetailPaneModal
            open={clearConfirmOpen}
            onClose={() => { if (!clearBusy) setClearConfirmOpen(false); }}
            titleId="briefing-clear-annotations-title"
            title={`Clear ${pendingAnnotations.length} annotation${pendingAnnotations.length === 1 ? '' : 's'}?`}
            closeLabel="Cancel clearing annotations"
            excludeAboveRef={headerRef}
            scrollOwnerSelector=".feedback-collection-shell__content"
            panelClassName="briefing-clear-confirmation"
          >
            <p>This will permanently delete exactly {pendingAnnotations.length} pending annotation{pendingAnnotations.length === 1 ? '' : 's'}. Submitted annotation sets remain unchanged.</p>
            <div className="briefing-clear-confirmation__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={clearBusy} onClick={() => setClearConfirmOpen(false)}>Cancel</button>
              <button type="button" className="btn btn--danger btn--sm" disabled={clearBusy} onClick={() => void confirmClear()}>
                {clearBusy ? 'Deleting…' : `Delete ${pendingAnnotations.length} annotation${pendingAnnotations.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </DetailPaneModal>
        </>
      )}
    >
      {body}
    </DetailPaneShell>
  );
}

export default BriefingDocumentRenderer;
