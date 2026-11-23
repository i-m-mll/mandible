import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import { useAuthReviewDrafts, type AuthReviewFileDraft } from './useAuthReviewDrafts';
import type { ChangeTextFileView } from '../components/ChangeList';
import { lazy, Suspense } from 'preact/compat';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { narrativeDraftSpan, narrativeHunkPair, type NarrativeHunk, type TextSpan } from '../../../src/feedback/request-narrative';
import type { RequestReviewComment } from '../../../src/feedback/request-review';
import type { ReviewRange, ReviewThreadMutation } from '../../../src/feedback/review-types';
import type { AuthChangeReport, DiffFilePair } from '../../../src/contracts';
import { isMarkdownFile } from '../../../src/presentation/markdown-file';
import { DOMAIN_EVENTS } from '../../../src/contracts';
import {
  annotateAuthReview, answerAuthReview, freezeAuthReview, getAuthReview, getAuthReviewComparison, mutateAuthReviewThread, returnAuthReview,
  type AuthReviewProjection, type BriefingResponseValue,
} from '../api';
import { MarkdownDocument, type MarkdownChangePosition, type MarkdownDocumentHandle, type MarkdownSelection, type MarkdownDirectives, type MarkdownRangeDecoration } from '../components/MarkdownDocument';
import {
  DocumentCommentsButton, DocumentCommentsDrawer, DocumentCommentSurface, useDocumentComments,
  type DocumentCommentThread,
} from '../components/shared/DocumentComments';
import { ContextualAction } from '../components/shared/ContextualAction';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { Icon } from '../components/icons/Icon';
import { ChoiceDropdown } from '../components/shared/ChoiceDropdown';
import { appTip } from '../components/shared/AppHoverTips';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { quoteReviewLines } from '../../../src/feedback/review-ranges';
import type { DiffLineRange, PierreLineHandle } from '../components/PierreFileDiff';

export type AuthReviewBinding = AuthReviewProjection['round']['bindings'][number];
type Binding = AuthReviewBinding;
type Selection = ReviewRange & { bindingId: string };
type Navigation = { comment: RequestReviewComment; token: string };

export function useAuthRequestReview(id: string, status: string, updatedAt: unknown, revision: number | null | undefined, canWrite: boolean,
  onReject: (id: string, reason: string) => void | Promise<void>,
  onReturned?: (signal: AbortSignal) => Promise<void>,
) {
  const [data, setData] = useState<AuthReviewProjection | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comments = useDocumentComments(id);
  const [showSource, setShowSource] = useState(false);
  const [showChanges, setShowChanges] = useState(true);
  const [fileChangePosition, setFileChangePosition] = useState<MarkdownChangePosition>({ index: 0, total: 0 });
  const fileDocument = useRef<MarkdownDocumentHandle>(null);
  const reportFileChangePosition = useCallback((next: MarkdownChangePosition) => {
    setFileChangePosition(current => current.index === next.index && current.total === next.total ? current : next);
  }, []);
  const request = useRef<AbortController>();
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await getAuthReview(id, controller.signal);
      if (!controller.signal.aborted) setData(next);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }, [id]);
  useEffect(() => {
    void refresh().catch(() => undefined);
    return () => request.current?.abort();
  }, [refresh, status, updatedAt, revision]);
  useEffect(() => {
    const onReviewUpdate = (event: Event) => {
      const changed = (event as CustomEvent<{ request_id: string }>).detail.request_id;
      if (changed === id || data?.versions.some(version => version.id === changed)) void refresh().catch(() => undefined);
    };
    window.addEventListener(DOMAIN_EVENTS.AUTH_REVIEW_UPDATED, onReviewUpdate);
    return () => window.removeEventListener(DOMAIN_EVENTS.AUTH_REVIEW_UPDATED, onReviewUpdate);
  }, [data?.versions, id, refresh]);
  useEffect(() => {
    if (status !== 'pending') return;
    const recheck = () => { void refresh().catch(() => undefined); };
    window.addEventListener('focus', recheck);
    window.addEventListener(DOMAIN_EVENTS.WORK_BRANCH_UPDATED, recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      window.removeEventListener(DOMAIN_EVENTS.WORK_BRANCH_UPDATED, recheck);
    };
  }, [status, refresh]);

  type ComparisonTarget = { kind: 'against' | 'revision'; id: string };
  const [target, setTarget] = useState<ComparisonTarget>();
  const [comparison, setComparison] = useState<{ target: ComparisonTarget; report: AuthChangeReport }>();
  const targetHead = data?.versions.find(version => version.id === target?.id)?.head;
  const displayedHead = data?.versions.find(version => version.id === id)?.head;
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setComparisonError(null);
    if (target && targetHead && (target.kind === 'revision' || displayedHead)) void getAuthReviewComparison(id, target, controller.signal).then(report => {
      if (!controller.signal.aborted) setComparison({ target, report });
    }, error => {
      if (!controller.signal.aborted) setComparisonError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [id, target, targetHead, displayedHead]);
  const selectComparison = (next?: ComparisonTarget) => { comments.select(null); setNavigation(null); setTarget(next); };
  const readOnly = Boolean(target);
  const available = status === 'pending' && data?.status === 'pending' && data.precondition.expected_revision !== null && canWrite && !readOnly;
  const threadAvailable = Boolean(canWrite && data?.round.owner.auth_request_id === id && data.status === status
    && data.precondition.expected_revision !== null && (status === 'pending' || status === 'returned') && !readOnly);
  const drafts = useAuthReviewDrafts(id, data, Boolean(available));
  const openReject = () => {
    setRejecting(true);
    setText('');
    setError(null);
  };
  const act = async (action: () => Promise<void>, settled: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      settled();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      void refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const permission = useRef({ id, data, available, threadAvailable });
  permission.current = { id, data, available, threadAvailable };
  const commentOn = async (selection: Selection, body: string) => {
    const current = permission.current;
    if (current.id !== id || !current.available || !current.data?.round.bindings.some(binding => binding.id === selection.bindingId)) {
      throw new Error('This request can no longer be commented on.');
    }
    const { bindingId, ...range } = selection;
    await annotateAuthReview(id, current.data.precondition, bindingId, { ...range, operation: 'set', kind: 'comment', body });
    await refresh();
  };
  const freeze = async (showCandidate: () => void) => {
    if (!available || !data || drafts.hasConflicts || !drafts.hasEdits) return;
    await act(async () => {
      await freezeAuthReview(id, data, await drafts.flush());
      await refresh();
      if (onReturned) await onReturned(new AbortController().signal);
    }, () => {
      setNavigation(null);
      comments.select(null);
      showCandidate();
    });
  };
  const returnToRequester = () => {
    if (!available || !data) return;
    void act(async () => {
      await returnAuthReview(id, data, '', await drafts.flush());
      setData(old => old && { ...old, status: 'returned' });
      await refresh().catch(() => undefined);
      if (onReturned) void onReturned(new AbortController().signal).catch(() => undefined);
    }, () => undefined);
  };
  const submitReject = () => { void act(async () => { await onReject(id, text); }, () => setRejecting(false)); };
  const remove = async (annotation: RequestReviewComment) => {
    const current = permission.current;
    if (!current.available || !current.data?.active_annotation_event_ids?.includes(annotation.annotation_event_id)) {
      throw new Error('This comment can no longer be deleted.');
    }
    await annotateAuthReview(id, current.data.precondition, annotation.document_binding_id, {
      operation: 'retract', annotation_event_id: annotation.annotation_event_id,
    });
    await refresh();
  };
  const changeThread = async (comment: RequestReviewComment, mutation: ReviewThreadMutation) => {
    const current = permission.current;
    if (!current.threadAvailable || !current.data?.annotations.some(note => note.annotation_event_id === comment.annotation_event_id)) {
      throw new Error('This thread can no longer be changed.');
    }
    await mutateAuthReviewThread(id, current.data.precondition, comment.annotation_event_id, mutation);
    await refresh();
  };
  const answerQuestion = (key: string, value: BriefingResponseValue | null) => {
    if (!available || !data || busy) return;
    const question = data.narrative_questions.find(item => item.directive.key === key);
    if (!question || JSON.stringify(question.effective_response?.value ?? null) === JSON.stringify(value)) return;
    const expected = question.effective_response?.response_event_id ?? null;
    if (value === null && expected === null) return;
    void act(async () => {
      await answerAuthReview(id, data, key, value === null
        ? { operation: 'retract', expected_response_event_id: expected! }
        : { operation: 'set', expected_response_event_id: expected, value });
      await refresh();
    }, () => undefined);
  };
  const threads = (data?.annotations ?? []).map((comment): DocumentCommentThread => {
    const draft = data?.status === 'pending' && !!data.active_annotation_event_ids?.includes(comment.annotation_event_id);
    const writable = threadAvailable && comment.annotation_kind === 'comment';
    const resolved = comment.thread.resolved;
    return {
      id: comment.annotation_event_id, quote: comment.quote, range: range(comment),
      author: comment.author?.display_name ?? null, provider: providerOf(comment.author), createdAt: comment.created_at,
      body: comment.body ?? '', resolved, draft,
      replies: comment.thread.events.flatMap(event => event.operation === 'reply'
        ? [{ id: event.id, author: event.author?.display_name ?? null, provider: providerOf(event.author),
          createdAt: event.created_at, body: event.body }]
        : []),
      onDelete: draft && available && !comment.thread.events.length ? () => remove(comment) : undefined,
      onResolve: writable && !resolved ? () => changeThread(comment, { operation: 'resolve' }) : undefined,
      onReopen: writable && resolved ? () => changeThread(comment, { operation: 'reopen' }) : undefined,
      onReply: writable && !resolved ? body => changeThread(comment, { operation: 'reply', body }) : undefined,
    };
  });
  const draftCommentCount = threads.filter(thread => thread.draft).length;
  return { data, navigation, setNavigation, comments, threads, draftCommentCount, available, target, selectComparison, readOnly, drafts,
    comparison: comparison?.target === target ? comparison?.report : undefined, comparisonError,
    openReject, returnToRequester, freeze, busy, error, answerQuestion, commentOn,
    showSource, setShowSource, showChanges, setShowChanges, fileChangePosition, fileDocument, reportFileChangePosition,
    clearSelection: () => comments.select(null),
    rejecting, text, setText, submitReject,
    closeReject: () => { if (!busy) { setRejecting(false); setError(null); } },
  };
}

function providerOf(author: RequestReviewComment['author']): 'openai' | 'anthropic' | undefined {
  if (author?.kind !== 'agent') return undefined;
  if (author.slug.startsWith('codex')) return 'openai';
  if (author.slug.startsWith('claude')) return 'anthropic';
  return undefined;
}

export type AuthRequestReviewState = ReturnType<typeof useAuthRequestReview>;

function range(comment: RequestReviewComment) {
  return comment.anchor.status === 'detached' ? null : { start: comment.anchor.start_offset, end: comment.anchor.end_offset };
}

export function AuthReviewCommentsButton({ review }: { review: AuthRequestReviewState }) {
  return <DocumentCommentsButton controller={review.comments} count={review.threads.length} />;
}

export function AuthReviewComments({ review, onNavigate }: {
  review: AuthRequestReviewState;
  onNavigate(comment: RequestReviewComment): void;
}) {
  return <DocumentCommentsDrawer controller={review.comments} threads={review.threads} onNavigate={thread => {
    if (!thread.range) return;
    const annotation = review.data?.annotations.find(comment => comment.annotation_event_id === thread.id);
    if (annotation) onNavigate(annotation);
  }} />;
}

export function authReviewDocumentThreads(review: AuthRequestReviewState, binding: Binding | undefined, span?: TextSpan): DocumentCommentThread[] {
  if (!binding) return [];
  const ids = new Set(review.data?.annotations.filter(note => note.document_binding_id === binding.id).map(note => note.annotation_event_id));
  return review.threads.flatMap(thread => {
    const anchor = thread.range;
    if (!anchor || !ids.has(thread.id)) return [];
    const start = span ? Math.max(anchor.start, span.start) - span.start : anchor.start;
    const end = span ? Math.min(anchor.end, span.end) - span.start : anchor.end;
    return end > start ? [{ ...thread, range: { start, end } }] : [];
  });
}

export function authReviewMarkdownMarks(review: AuthRequestReviewState, binding?: Binding, span?: TextSpan): MarkdownRangeDecoration[] {
  return authReviewDocumentThreads(review, binding, span).flatMap(thread => !thread.resolved && thread.range
    ? [{ ...thread.range, id: thread.id, className: 'review-range' }] : []);
}

export function AuthReviewMarkdown({ review, binding, value, comparison, operatorComparison, label, wholeFile, directives, previewPolicy, span, onEdit, draft, headerControls, embedded = [] }: {
  review: AuthRequestReviewState;
  binding?: Binding;
  value: string;
  comparison?: string;
  operatorComparison?: string;
  label: string;
  wholeFile?: boolean;
  directives?: MarkdownDirectives;
  previewPolicy?: Parameters<typeof MarkdownDocument>[0]['previewPolicy'];
  span?: TextSpan;
  onEdit?: (range: MarkdownSelection) => void;
  draft?: Pick<AuthReviewFileDraft, 'source' | 'writable' | 'change'>;
  headerControls?: boolean;
  embedded?: readonly TextSpan[];
}) {
  const localDocument = useRef<MarkdownDocumentHandle>(null);
  const document = headerControls ? review.fileDocument : localDocument;
  const container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<MarkdownSelection | null>(null);
  const editSelection = useRef<MarkdownSelection>();
  useLayoutEffect(() => {
    if (!draft?.writable || !editSelection.current) return;
    const selection = editSelection.current;
    const frame = requestAnimationFrame(() => {
      document.current?.select(selection);
      editSelection.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [draft?.writable, document]);
  const target = review.navigation;
  useLayoutEffect(() => {
    if (!target || !binding || target.comment.document_binding_id !== binding.id) return;
    const anchor = range(target.comment);
    if (!anchor || span && (anchor.start < span.start || anchor.end > span.end)) return;
    review.comments.select(target.comment.annotation_event_id);
    container.current?.scrollIntoView({ block: 'nearest' });
    document.current?.reveal({ start: anchor.start - (span?.start ?? 0), end: anchor.end - (span?.start ?? 0) });
  }, [target?.token, binding?.id, span?.start, span?.end]);
  const selection = !draft && binding && selected?.quote && value.slice(selected.start, selected.end) === selected.quote ? {
    range: selected,
    onEdit: onEdit ? () => { editSelection.current = selected; onEdit(selected); } : undefined,
    onComment: review.available && !review.readOnly ? (body: string) => review.commentOn({
      bindingId: binding.id, start_offset: selected.start + (span?.start ?? 0), end_offset: selected.end + (span?.start ?? 0),
      quote: selected.quote,
    }, body).then(() => setSelected(null)) : undefined,
  } : null;
  const threads = authReviewDocumentThreads(review, binding, span).filter(thread => !embedded.some(item =>
    thread.range && thread.range.start >= item.start && thread.range.end <= item.end));
  const contents = <MarkdownDocument value={draft?.source ?? value} comparison={review.showChanges ? comparison : undefined}
    operatorComparison={review.showChanges ? operatorComparison ?? (draft ? value : undefined) : undefined}
    showSource={review.showSource}
    onChangePosition={headerControls ? review.reportFileChangePosition : undefined}
    comparisonLayout={wholeFile ? 'full-document' : undefined} readOnly={!draft?.writable} ariaLabel={label}
    directives={directives} previewPolicy={previewPolicy} documentRef={document}
    decorations={draft ? undefined : authReviewMarkdownMarks(review, binding, span)} onChange={draft?.change}
    onDecorationClick={review.comments.select} onSelectionChange={setSelected} />;
  return <div ref={container}>{binding ? <DocumentCommentSurface controller={review.comments} selection={selection}
    threads={draft ? [] : threads} documentRef={document} drawer={false}
    navigationKey={`auth.${binding.id}.${span?.start ?? 0}`}>{contents}</DocumentCommentSurface> : contents}</div>;
}

export function AuthReviewMarkdownChange({ review, pair, index, wholeFile, onEdit, draft, headerControls }: {
  review: AuthRequestReviewState;
  pair: Extract<DiffFilePair, { kind: 'text' }>;
  index: number;
  wholeFile: boolean;
  onEdit?: (range: MarkdownSelection) => void;
  draft?: AuthReviewFileDraft;
  headerControls?: boolean;
}) {
  const target = review.readOnly ? null : review.navigation?.comment.source;
  const targetSide = target?.kind === 'request_file' && target.file_index === index ? target.side : undefined;
  const active = targetSide ?? 'after';
  const binding = review.readOnly ? undefined : review.data?.round.bindings.find(item => item.source.kind === 'request_file'
    && item.source.file_index === index && item.source.side === active);
  return <AuthReviewMarkdown key={active} review={review} binding={binding} value={pair[active].contents} onEdit={active === 'after' ? onEdit : undefined}
    comparison={active === 'after' ? pair.before.contents : undefined}
    operatorComparison={active === 'after' ? pair.operator_baseline : undefined} headerControls={headerControls}
    draft={active === 'after' ? draft : undefined} wholeFile={wholeFile}
    label={draft ? `Review draft for ${draft.path}` : `${pair[active].name} ${active}`} />;
}

export function authReviewSelector(review: AuthRequestReviewState, id: string, onSelect: (id: string) => void) {
  const versions = review.data?.versions;
  if (!versions || versions.length < 2) return undefined;
  const selected = versions.find(version => version.id === id);
  return {
    label: 'Request revision',
    selectedCanonicalRef: id,
    selectedCopyRef: selected ? `auth:${selected.short_id}` : undefined,
    control: <ChoiceDropdown label="Request revision" prompt="Request revision" value={review.target?.kind === 'revision' ? review.target.id : id}
      choices={versions.map((version, index) => ({ value: version.id, label: `Revision ${index + 1}` }))}
      onChange={revision => {
        if (revision.includes('@')) review.selectComparison({ kind: 'revision', id: revision });
        else if (revision === id) review.selectComparison();
        else onSelect(revision);
      }} />,
  };
}

export function AuthReviewRejectComposer({ review, anchor }: { review: AuthRequestReviewState; anchor: RefObject<HTMLButtonElement> }) {
  const menuRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const style = useAnchoredMenu({ open: review.rejecting, anchorRef: anchor, menuRef, focusRef: inputRef, onDismiss: review.closeReject });
  if (!review.rejecting) return null;
  return <form ref={menuRef} className="auth-review__dialog app-anchored-menu" aria-label="Reject request"
    popover="manual" style={style} onSubmit={event => { event.preventDefault(); review.submitReject(); }}>
    <textarea ref={inputRef} aria-label="Reason (optional)" placeholder="Reason (optional)" value={review.text}
      onInput={event => review.setText(event.currentTarget.value)} />
    {review.error && <DetailPaneNotice severity="error" density="compact">{review.error}</DetailPaneNotice>}
    <button type="submit" className="btn btn--danger btn--sm" disabled={review.busy}>Reject</button>
  </form>;
}

const PierreDraftDiff = lazy(() => import('../components/PierreFileDiff').then(module => ({ default: module.PierreFileDiff })));
type TextPair = Extract<DiffFilePair, { kind: 'text' }>;

function PierreReviewDraft({ draft, pair, view, editable }: {
  draft: AuthReviewFileDraft; pair: TextPair; view: ChangeTextFileView; editable: boolean;
}) {
  const [working] = useState(() => ({ ...pair.after, contents: draft.source }));
  const [input] = useState(() => editable ? { kind: 'file' as const, file: working }
    : { kind: 'contents' as const, before: pair.after, after: working });
  return <div inert={editable && !draft.writable}>
    <Suspense fallback={null}>
      <PierreDraftDiff input={input} mode={view.mode} wrap={view.wrap} wholeFile
        ariaLabel={`Review draft for ${draft.path}`} onEditChange={editable ? draft.change : undefined} />
    </Suspense>
  </div>;
}

export function AuthReviewDraftControls({ draft, available, allowOpen = true }: {
  draft: AuthReviewFileDraft; available: boolean; allowOpen?: boolean;
}) {
  return <>
    {available && (allowOpen || draft.editing || draft.edited || draft.mergeConflict) && <div className="auth-review__side"
      role="group" aria-label={`Draft actions for ${draft.path}`}>
      {(allowOpen || draft.editing) && draft.mergeConflict !== 'detached' && <ContextualAction
        aria-label={draft.editing ? 'Close review editor' : 'Edit proposed text'}
        {...appTip(draft.editing ? 'Close review editor' : 'Edit proposed text')}
        aria-pressed={draft.editing} disabled={draft.busy} onClick={draft.toggle}>
        <Icon name={draft.editing ? 'markRead' : 'toolEdit'} />
      </ContextualAction>}
      {available && draft.edited && <ContextualAction aria-label={draft.mergeConflict === 'detached' ? 'Discard draft' : 'Revert to proposed text'}
        {...appTip(draft.mergeConflict === 'detached' ? 'Discard draft' : 'Revert to proposed text')}
        disabled={draft.busy || draft.writeConflict} onClick={draft.revert}>
        <Icon name="history" />
      </ContextualAction>}
      {draft.mergeConflict === 'overlap' && available && <button type="button" className="btn"
        disabled={draft.busy || draft.writeConflict} onClick={draft.resolve}>Resolve conflict</button>}
    </div>}
    {draft.mergeConflict && <DetailPaneNotice density="compact" severity="info">
      <Icon name="warning" /> {draft.mergeConflict === 'detached' ? 'Detached review draft' : 'Review draft conflict'}
    </DetailPaneNotice>}
    {draft.error && <DetailPaneNotice density="compact" severity="error" title={draft.path}
      actions={draft.writeConflict && available ? <div className="auth-review__side">
        <button type="button" className="btn" onClick={draft.acceptRemote}>Use saved draft</button>
        <button type="button" className="btn" onClick={draft.keepLocal}>Keep local draft</button>
      </div> : null}>
      {draft.error}
    </DetailPaneNotice>}
  </>;
}

function AuthReviewLineDiff({ review, pair, shown, index, view, section }: {
  review: AuthRequestReviewState; pair: TextPair; shown: TextPair; index: number;
  view: Omit<ChangeTextFileView, 'defaultContent'>;
  section?: NarrativeHunk;
}) {
  const lineRef = useRef<PierreLineHandle>(null);
  const [pending, setPending] = useState<{ range: DiffLineRange; bindingId: string; quote: string }>();
  const input = useMemo(() => ({ ...shown, kind: 'contents' as const }), [shown]);
  const bindings = review.data?.round.bindings.filter(binding => binding.source.kind === 'request_file'
    && binding.source.file_index === index && binding.source.format === 'lines') ?? [];
  const offset = (side: DiffLineRange['side']) => section ? pair[side].contents.slice(0, section[side].start).split('\n').length - 1 : 0;
  const sideFor = (id: string) => {
    const source = review.data?.annotations.find(note => note.annotation_event_id === id)?.source;
    return source?.kind === 'request_file' ? source.side : undefined;
  };
  const threads = bindings.flatMap(binding => authReviewDocumentThreads(review, binding)).flatMap(thread => {
    const side = sideFor(thread.id);
    if (!side || !thread.range) return [];
    const start = Math.max(0, thread.range.start - offset(side));
    const end = Math.min(shown[side].contents.split('\n').length, thread.range.end - offset(side));
    return end > start ? [{ ...thread, range: { start, end } }] : [];
  });
  const lines = threads.flatMap(thread => !thread.resolved && thread.range ? [{
    id: thread.id, active: thread.id === review.comments.selected || thread.id === review.comments.hovered, side: sideFor(thread.id)!,
    startLine: thread.range.start + 1, endLine: thread.range.end,
  }] : []);
  const gutterSelection = useMemo(() => pending && ({
    range: { start: pending.range.startLine - 1, end: pending.range.endLine },
    send: (body: string) => review.commentOn({
      bindingId: pending.bindingId,
      start_offset: pending.range.startLine - 1 + offset(pending.range.side),
      end_offset: pending.range.endLine + offset(pending.range.side),
      quote: pending.quote,
    }, body),
  }), [pending]);
  const target = review.navigation && lines.find(line => line.id === review.navigation?.comment.annotation_event_id);
  return <DocumentCommentSurface controller={review.comments} threads={threads} selection={null} drawer={false}
    gutterSelection={gutterSelection}
    position={(range, id) => {
      const side = id ? sideFor(id) : pending?.range.side;
      return side ? lineRef.current?.bounds({ side, startLine: range.start + 1, endLine: range.end }) ?? null : null;
    }}>
    <Suspense fallback={null}><PierreDraftDiff input={input} mode={view.mode} wrap={view.wrap} wholeFile={view.wholeFile}
      ariaLabel={shown.after.name} lineRef={lineRef}
      lineTarget={target && review.navigation ? { ...target, token: review.navigation.token } : undefined}
      lineReview={{
        lines, onHover: review.comments.hover, onOpen: review.comments.select,
        onComment: review.available && !review.readOnly ? selected => {
          const binding = bindings.find(item => item.source.kind === 'request_file' && item.source.side === selected.side);
          const quote = quoteReviewLines(shown[selected.side].contents, selected.startLine - 1, selected.endLine);
          if (binding && quote) setPending({ range: selected, bindingId: binding.id, quote });
        } : undefined,
      }} /></Suspense>
  </DocumentCommentSurface>;
}

export function AuthReviewTextFile({ review, pair, index, view, section, headerControls }: {
  review: AuthRequestReviewState; pair: TextPair; index: number;
  view: Omit<ChangeTextFileView, 'defaultContent'> & { defaultContent?: ComponentChildren };
  section?: NarrativeHunk;
  headerControls?: boolean;
}) {
  const shown = useMemo(() => section ? narrativeHunkPair(pair, section) : pair, [pair, section?.after.start, section?.after.end, section?.before.start, section?.before.end]);
  const bindings = review.data?.round.bindings ?? [];
  const binding = bindings.find(({ source }) => source.kind === 'request_file' && source.file_index === index && source.side === 'after');
  const markdown = binding?.source.kind === 'request_file' ? binding.source.format === 'markdown' : isMarkdownFile(pair.after.name);
  const fileDraft = !review.readOnly ? review.drafts.forFile(index, pair) : null;
  useLayoutEffect(() => {
    if (headerControls && !markdown) review.reportFileChangePosition({ index: 0, total: 0 });
  }, [headerControls, markdown, review.reportFileChangePosition]);
  const openTextEdit = fileDraft && review.available ? () => {
    review.setNavigation(null);
    review.clearSelection();
    fileDraft.toggle();
  } : undefined;
  const span = fileDraft && section && narrativeDraftSpan(pair.after.contents, fileDraft.source, section.after);
  const draft = fileDraft && (span ? { ...fileDraft, source: fileDraft.source.slice(span.start, span.end),
    change: (source: string) => fileDraft.change(fileDraft.source.slice(0, span.start) + source + fileDraft.source.slice(span.end)) } : fileDraft);
  const target = review.navigation?.comment.source;
  const jump = target?.kind === 'request_file' && target.file_index === index;
  const editing = draft?.editing && !jump && (!section || span) ? draft : undefined;
  const pinned = markdown
    ? section ? <AuthReviewMarkdown review={review} binding={binding} value={shown.after.contents}
      comparison={shown.before.contents} label={editing ? `Review draft for ${editing.path}` : pair.after.name}
      span={section.after} wholeFile onEdit={openTextEdit} draft={editing} />
      : <AuthReviewMarkdownChange review={review} pair={pair} index={index} wholeFile={view.wholeFile} onEdit={openTextEdit}
        headerControls={headerControls} draft={editing} />
    : review.readOnly ? view.defaultContent
      : <AuthReviewLineDiff review={review} pair={pair} shown={shown} index={index} view={view} section={section} />;
  if (!draft || section && !span) return <>{pinned}</>;
  return <>
    <AuthReviewDraftControls draft={{ ...draft, toggle: () => {
      review.setNavigation(null);
      review.clearSelection();
      draft.toggle();
    } }} available={Boolean(review.available)} allowOpen={!markdown} />
    {editing && !markdown ? <>
        {section && pinned}
        <PierreReviewDraft key={`${draft.externalVersion}:${Boolean(review.available)}`}
          editable={Boolean(review.available)} draft={draft} pair={shown} view={{ ...view, defaultContent: null }} />
      </> : pinned}
  </>;
}

function DetachedDraft({ draft, available }: { draft: AuthReviewFileDraft; available: boolean }) {
  const [expanded, setExpanded] = useState(true);
  return <CollapsiblePanel title={draft.path} expanded={expanded} onExpandedChange={setExpanded}>
    <AuthReviewDraftControls draft={draft} available={available} />
    <pre className="auth-review__detached-draft">{draft.source}</pre>
  </CollapsiblePanel>;
}

export function AuthReviewDetachedDrafts({ review }: { review: AuthRequestReviewState }) {
  return <>{review.drafts.detached.map(draft => <DetachedDraft key={draft.path} draft={draft} available={Boolean(review.available)} />)}</>;
}
