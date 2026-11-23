import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
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
import { MarkdownDocument, type MarkdownDocumentHandle, type MarkdownSelection, type MarkdownDirectives, type MarkdownRangeDecoration } from '../components/MarkdownDocument';
import {
  DocumentCommentsButton, DocumentCommentsDrawer, DocumentCommentSurface, useDocumentComments,
  type DocumentCommentThread,
} from '../components/shared/DocumentComments';
import { ContextualAction } from '../components/shared/ContextualAction';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { Icon } from '../components/icons/Icon';
import { NativeSelect } from '../components/shared/NativeSelect';
import { quoteReviewLines } from '../../../src/feedback/review-ranges';
import type { DiffLineRange, PierreLineHandle } from '../components/PierreFileDiff';

export type AuthReviewBinding = AuthReviewProjection['round']['bindings'][number];
type Binding = AuthReviewBinding;
type Selection = ReviewRange & { bindingId: string };
type Navigation = { comment: RequestReviewComment; token: string };
export type ReviewDecision = 'return' | 'reject';

export function useAuthRequestReview(id: string, status: string, updatedAt: unknown, canWrite: boolean,
  onReject: (id: string, reason: string) => void | Promise<void>,
  onReturned?: (signal: AbortSignal) => Promise<void>,
) {
  const [data, setData] = useState<AuthReviewProjection | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comments = useDocumentComments(id);
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
  }, [refresh, status, updatedAt]);
  useEffect(() => {
    const onReviewUpdate = (event: Event) => {
      const changed = (event as CustomEvent<{ request_id: string }>).detail.request_id;
      if (changed === id || data?.versions.some(version => version.id === changed)) void refresh().catch(() => undefined);
    };
    window.addEventListener(DOMAIN_EVENTS.AUTH_REVIEW_UPDATED, onReviewUpdate);
    return () => window.removeEventListener(DOMAIN_EVENTS.AUTH_REVIEW_UPDATED, onReviewUpdate);
  }, [data?.versions, id, refresh]);

  const [against, setAgainst] = useState('');
  const [comparison, setComparison] = useState<{ against: string; report: AuthChangeReport }>();
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setComparisonError(null);
    if (against && data?.versions.find(version => version.id === id)?.head && data.versions.find(version => version.id === against)?.head) void getAuthReviewComparison(id, against, controller.signal).then(report => {
      if (!controller.signal.aborted) setComparison({ against, report });
    }, error => {
      if (!controller.signal.aborted) setComparisonError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [id, against, data?.versions.find(version => version.id === id)?.head, data?.versions.find(version => version.id === against)?.head]);
  const compare = (id: string) => { comments.select(null); setNavigation(null); setAgainst(id); };
  const available = status === 'pending' && data?.status === 'pending' && data.precondition.expected_revision !== null && canWrite && !against;
  const threadAvailable = Boolean(canWrite && data?.round.owner.auth_request_id === id && data.status === status
    && data.precondition.expected_revision !== null && (status === 'pending' || status === 'returned'));
  const drafts = useAuthReviewDrafts(id, data, Boolean(available));
  const openDecision = (next: ReviewDecision) => {
    setDecision(next);
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
    }, () => setDecision(null));
  };
  const submitDecision = () => {
    if (decision === 'return') returnToRequester();
    else if (decision === 'reject') void act(async () => { await onReject(id, text); }, () => setDecision(null));
  };
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
  return { data, navigation, setNavigation, comments, threads, draftCommentCount, available, against, compare, drafts,
    comparison: comparison?.against === against ? comparison.report : undefined, comparisonError,
    openDecision, returnToRequester, freeze, busy, error, answerQuestion, commentOn,
    clearSelection: () => comments.select(null),
    decision, text, setText, submitDecision,
    close: () => { if (!busy) { setDecision(null); setError(null); } },
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

export function AuthReviewMarkdown({ review, binding, value, comparison, label, wholeFile, directives, previewPolicy, span, onEdit, embedded = [] }: {
  review: AuthRequestReviewState;
  binding?: Binding;
  value: string;
  comparison?: string;
  label: string;
  wholeFile?: boolean;
  directives?: MarkdownDirectives;
  previewPolicy?: Parameters<typeof MarkdownDocument>[0]['previewPolicy'];
  span?: TextSpan;
  onEdit?: (range: MarkdownSelection) => void;
  embedded?: readonly TextSpan[];
}) {
  const document = useRef<MarkdownDocumentHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<MarkdownSelection | null>(null);
  const target = review.navigation;
  useLayoutEffect(() => {
    if (!target || !binding || target.comment.document_binding_id !== binding.id) return;
    const anchor = range(target.comment);
    if (!anchor || span && (anchor.start < span.start || anchor.end > span.end)) return;
    review.comments.select(target.comment.annotation_event_id);
    container.current?.scrollIntoView({ block: 'nearest' });
    document.current?.reveal({ start: anchor.start - (span?.start ?? 0), end: anchor.end - (span?.start ?? 0) });
  }, [target?.token, binding?.id, span?.start, span?.end]);
  const selection = binding && selected?.quote && value.slice(selected.start, selected.end) === selected.quote ? {
    range: selected,
    onEdit: onEdit ? () => onEdit(selected) : undefined,
    onComment: review.available && !review.against ? (body: string) => review.commentOn({
      bindingId: binding.id, start_offset: selected.start + (span?.start ?? 0), end_offset: selected.end + (span?.start ?? 0),
      quote: selected.quote,
    }, body).then(() => setSelected(null)) : undefined,
  } : null;
  const threads = authReviewDocumentThreads(review, binding, span).filter(thread => !embedded.some(item =>
    thread.range && thread.range.start >= item.start && thread.range.end <= item.end));
  const contents = <MarkdownDocument value={value} comparison={comparison}
    comparisonLayout={wholeFile ? 'full-document' : undefined} readOnly ariaLabel={label}
    directives={directives} previewPolicy={previewPolicy} documentRef={document} decorations={authReviewMarkdownMarks(review, binding, span)}
    onDecorationClick={review.comments.select} onSelectionChange={setSelected} />;
  return <div ref={container}>{binding ? <DocumentCommentSurface controller={review.comments} selection={selection}
    threads={threads} documentRef={document} drawer={false}
    navigationKey={`auth.${binding.id}.${span?.start ?? 0}`}>{contents}</DocumentCommentSurface> : contents}</div>;
}

export function AuthReviewMarkdownChange({ review, pair, index, wholeFile, onEdit }: {
  review: AuthRequestReviewState;
  pair: Extract<DiffFilePair, { kind: 'text' }>;
  index: number;
  wholeFile: boolean;
  onEdit?: (range: MarkdownSelection) => void;
}) {
  const [side, setSide] = useState<'before' | 'after'>(pair.after.contents ? 'after' : 'before');
  const target = review.against ? null : review.navigation?.comment.source;
  const targetSide = target?.kind === 'request_file' && target.file_index === index ? target.side : undefined;
  const active = targetSide ?? side;
  const binding = review.against ? undefined : review.data?.round.bindings.find(item => item.source.kind === 'request_file'
    && item.source.file_index === index && item.source.side === active);
  return <>
    <div role="group" aria-label="Markdown side" className="auth-review__side">
      {(['before', 'after'] as const).map(which => <button key={which} type="button" aria-pressed={active === which}
        onClick={() => { setSide(which); review.setNavigation(null); }}>{which === 'before' ? 'Before' : 'After'}</button>)}
    </div>
    <AuthReviewMarkdown key={active} review={review} binding={binding} value={pair[active].contents} onEdit={active === 'after' ? onEdit : undefined}
      comparison={active === 'after' ? pair.before.contents : undefined} wholeFile={wholeFile} label={`${pair[active].name} ${active}`} />
  </>;
}

export function authReviewSelector(review: AuthRequestReviewState, id: string, onSelect: (id: string) => void, openDiff: () => void) {
  const versions = review.data?.versions;
  if (!versions || versions.length < 2) return undefined;
  const selected = versions.find(version => version.id === id);
  return {
    label: 'Request revision',
    selectedCanonicalRef: id,
    selectedCopyRef: selected ? `auth:${selected.short_id}` : undefined,
    control: <div className="auth-review__versions">
      <NativeSelect aria-label="Request revision" value={id} onChange={event => onSelect(event.currentTarget.value)}>
        {versions.flatMap((version, index) => version.id.includes('@') ? [] : [<option key={version.id} value={version.id}>
          {index + 1} · {version.short_id} · {version.status}
        </option>])}
      </NativeSelect>
      <NativeSelect aria-label="Compare revisions" value={review.against} onChange={event => {
        review.compare(event.currentTarget.value);
        if (event.currentTarget.value) openDiff();
      }}>
        <option value="">Protected base</option>
        {versions.flatMap((version, index) => version.id !== id && (version.head && selected?.head || version.description !== selected?.description)
          ? [<option key={version.id} value={version.id}>Revision {index + 1}</option>] : [])}
      </NativeSelect>
    </div>,
  };
}

export function AuthReviewDialog({ review }: { review: AuthRequestReviewState }) {
  const label = review.decision === 'return' ? 'Return to requester' : 'Reject request';
  return <DetailPaneModal open={Boolean(review.decision)} onClose={review.close}
    titleId="auth-review-decision" title={label} closeLabel="Close review dialog">
    <form className="auth-review__dialog" onSubmit={event => { event.preventDefault(); review.submitDecision(); }}>
      <label>Reason (optional)<textarea value={review.text} rows={4} onInput={event => review.setText(event.currentTarget.value)} /></label>
      {review.error && <DetailPaneNotice severity="error" density="compact">{review.error}</DetailPaneNotice>}
      <button type="submit" className="btn" disabled={review.busy || (review.decision === 'return' && review.drafts.hasConflicts)}>
        {review.decision === 'return' ? 'Return' : 'Reject'}
      </button>
    </form>
  </DetailPaneModal>;
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

export function AuthReviewDraftControls({ draft, available }: { draft: AuthReviewFileDraft; available: boolean }) {
  return <>
    <div className="auth-review__side" role="group" aria-label={`Draft actions for ${draft.path}`}>
      {available && draft.mergeConflict !== 'detached' && <ContextualAction
        aria-label={draft.editing ? 'Close review editor' : 'Edit proposed text'}
        title={draft.editing ? 'Close review editor' : 'Edit proposed text'}
        aria-pressed={draft.editing} disabled={draft.busy} onClick={draft.toggle}>
        <Icon name={draft.editing ? 'markRead' : 'toolEdit'} />
      </ContextualAction>}
      {available && draft.edited && <ContextualAction aria-label={draft.mergeConflict === 'detached' ? 'Discard draft' : 'Revert to proposed text'}
        title={draft.mergeConflict === 'detached' ? 'Discard draft' : 'Revert to proposed text'}
        disabled={draft.busy || draft.writeConflict} onClick={draft.revert}>
        <Icon name="history" />
      </ContextualAction>}
      {draft.mergeConflict === 'overlap' && available && <button type="button" className="btn"
        disabled={draft.busy || draft.writeConflict} onClick={draft.resolve}>Resolve conflict</button>}
    </div>
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
        onComment: review.available && !review.against ? selected => {
          const binding = bindings.find(item => item.source.kind === 'request_file' && item.source.side === selected.side);
          const quote = quoteReviewLines(shown[selected.side].contents, selected.startLine - 1, selected.endLine);
          if (binding && quote) setPending({ range: selected, bindingId: binding.id, quote });
        } : undefined,
      }} /></Suspense>
  </DocumentCommentSurface>;
}

export function AuthReviewTextFile({ review, pair, index, view, section }: {
  review: AuthRequestReviewState; pair: TextPair; index: number;
  view: Omit<ChangeTextFileView, 'defaultContent'> & { defaultContent?: ComponentChildren };
  section?: NarrativeHunk;
}) {
  const shown = useMemo(() => section ? narrativeHunkPair(pair, section) : pair, [pair, section?.after.start, section?.after.end, section?.before.start, section?.before.end]);
  const bindings = review.data?.round.bindings ?? [];
  const binding = bindings.find(({ source }) => source.kind === 'request_file' && source.file_index === index && source.side === 'after');
  const markdown = binding?.source.kind === 'request_file' ? binding.source.format === 'markdown' : isMarkdownFile(pair.after.name);
  const fileDraft = !review.against ? review.drafts.forFile(index, pair) : null;
  const openTextEdit = fileDraft && review.available ? () => {
    review.setNavigation(null);
    review.clearSelection();
    fileDraft.toggle();
  } : undefined;
  const pinned = markdown
    ? section ? <AuthReviewMarkdown review={review} binding={binding} value={shown.after.contents}
      comparison={shown.before.contents} label={pair.after.name} span={section.after} wholeFile onEdit={openTextEdit} />
      : <AuthReviewMarkdownChange review={review} pair={pair} index={index} wholeFile={view.wholeFile} onEdit={openTextEdit} />
    : review.against ? view.defaultContent
      : <AuthReviewLineDiff review={review} pair={pair} shown={shown} index={index} view={view} section={section} />;
  if (!fileDraft) return <>{pinned}</>;
  const span = section && narrativeDraftSpan(pair.after.contents, fileDraft.source, section.after);
  if (section && !span) return <>{pinned}</>;
  const draft = span ? { ...fileDraft, source: fileDraft.source.slice(span.start, span.end),
    change: (source: string) => fileDraft.change(fileDraft.source.slice(0, span.start) + source + fileDraft.source.slice(span.end)) } : fileDraft;
  const label = `Review draft for ${draft.path}`;
  const target = review.navigation?.comment.source;
  const jump = target?.kind === 'request_file' && target.file_index === index;
  return <>
    <AuthReviewDraftControls draft={{ ...draft, toggle: () => {
      review.setNavigation(null);
      review.clearSelection();
      draft.toggle();
    } }} available={Boolean(review.available)} />
    {draft.editing && !jump ? (markdown
      ? <MarkdownDocument value={draft.source} readOnly={!draft.writable} comparison={section ? shown.before.contents : pair.after.contents}
        comparisonLayout={view.wholeFile ? 'full-document' : undefined} ariaLabel={label} onChange={draft.change} />
      : <>
        {section && pinned}
        <PierreReviewDraft key={`${draft.externalVersion}:${Boolean(review.available)}`}
          editable={Boolean(review.available)} draft={draft} pair={shown} view={{ ...view, defaultContent: null }} />
      </>) : pinned}
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
