import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useAuthReviewDrafts, type AuthReviewFileDraft } from './useAuthReviewDrafts';
import type { ChangeTextFileView } from '../components/ChangeList';
import { lazy, Suspense } from 'preact/compat';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import { narrativeDraftSpan, narrativeHunkPair, type NarrativeHunk, type TextSpan } from '../../../src/feedback/request-narrative';
import type { RequestReviewComment } from '../../../src/feedback/request-review';
import type { ReviewRange, ReviewThreadMutation } from '../../../src/feedback/review-types';
import type { AuthChangeReport, DiffFilePair } from '../../../src/contracts';
import { DOMAIN_EVENTS } from '../../../src/contracts';
import {
  annotateAuthReview, answerAuthReview, freezeAuthReview, getAuthReview, getAuthReviewComparison, mutateAuthReviewThread, returnAuthReview,
  type AuthReviewProjection, type BriefingResponseValue,
} from '../api';
import { MarkdownDocument, type MarkdownDocumentHandle, type MarkdownSelection, type MarkdownDirectives, type MarkdownRangeDecoration } from '../components/MarkdownDocument';
import { ReviewCommentsSidebar } from '../components/shared/ReviewCommentsSidebar';
import { ContextualAction } from '../components/shared/ContextualAction';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { Icon } from '../components/icons/Icon';
import { NativeSelect } from '../components/shared/NativeSelect';
import { quoteReviewLines } from '../../../src/feedback/review-ranges';
import type { DiffLineRange } from '../components/PierreFileDiff';

type Binding = AuthReviewProjection['round']['bindings'][number];
type Selection = ReviewRange & { bindingId: string };
type Navigation = { comment: RequestReviewComment; token: string };
export type ReviewDecision = 'return' | 'reject';

export function useAuthRequestReview(id: string, status: string, updatedAt: unknown, canWrite: boolean,
  onReject: (id: string, reason: string) => void | Promise<void>,
  onReturned?: (signal: AbortSignal) => Promise<void>,
) {
  const [data, setData] = useState<AuthReviewProjection | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const [editor, setEditor] = useState<Selection | null>(null);
  const [replyTarget, setReplyTarget] = useState<RequestReviewComment | null>(null);
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
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
  const compare = (id: string) => { setSelection(null); setNavigation(null); setAgainst(id); };
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
  const saveComment = () => {
    if (!available || !data || !editor || !text.trim()) return;
    const { bindingId, ...range } = editor;
    void act(async () => {
      await annotateAuthReview(id, data.precondition, bindingId, { ...range, operation: 'set', kind: 'comment', body: text });
      await refresh();
    }, () => { setEditor(null); setSelection(null); setCommentsOpen(true); });
  };
  const freeze = async (showCandidate: () => void) => {
    if (!available || !data || drafts.hasConflicts || !drafts.hasEdits) return;
    await act(async () => {
      await freezeAuthReview(id, data, await drafts.flush());
      await refresh();
      if (onReturned) await onReturned(new AbortController().signal);
    }, () => {
      setNavigation(null);
      setSelection(null);
      showCandidate();
    });
  };
  const submitDecision = () => {
    if (decision === 'return' && available && data) {
      void act(async () => {
        await returnAuthReview(id, data, text, await drafts.flush());
        setData(old => old && { ...old, status: 'returned' });
        await refresh().catch(() => undefined);
        if (onReturned) void onReturned(new AbortController().signal).catch(() => undefined);
      }, () => setDecision(null));
    } else if (decision === 'reject') {
      void act(async () => { await onReject(id, text); }, () => setDecision(null));
    }
  };
  const remove = (annotation: RequestReviewComment) => {
    if (!available || !data || annotation.origin_request_id !== id) return;
    void act(async () => {
      await annotateAuthReview(id, data.precondition, annotation.document_binding_id, {
        operation: 'retract', annotation_event_id: annotation.annotation_event_id,
      });
      await refresh();
    }, () => undefined);
  };
  const changeThread = (comment: RequestReviewComment, mutation: ReviewThreadMutation) => {
    if (!threadAvailable || !data?.annotations.some(note => note.annotation_event_id === comment.annotation_event_id)) return;
    void act(async () => {
      await mutateAuthReviewThread(id, data.precondition, comment.annotation_event_id, mutation);
      await refresh();
    }, () => setReplyTarget(null));
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
  const select = (binding: Binding | undefined, range: ReviewRange | null) => {
    if (!available || against || !binding) return;
    setSelection(current => range ? { ...range, bindingId: binding.id } : current?.bindingId === binding.id ? null : current);
  };
  const markdownSelection = (binding: Binding | undefined, selection: MarkdownSelection) =>
    select(binding, selection.quote ? { start_offset: selection.start, end_offset: selection.end, quote: selection.quote } : null);
  const lineSelection = (index: number, range: DiffLineRange | null, quote?: string) => {
    const binding = data?.round.bindings.find(item => item.source.kind === 'request_file' && item.source.file_index === index
      && (range ? item.source.side === range.side : item.id === selection?.bindingId));
    select(binding, range && quote ? { start_offset: range.startLine - 1, end_offset: range.endLine, quote } : null);
  };
  return { data, navigation, setNavigation, commentsOpen, setCommentsOpen, available, against, compare, drafts,
    comparison: comparison?.against === against ? comparison.report : undefined, comparisonError,
    openDecision, freeze, selection, lineSelection, markdownSelection, remove, busy, error, answerQuestion,
    clearSelection: () => setSelection(null),
    comment: () => { setEditor(selection); setText(''); setError(null); },
    commentOnMarkdown: (binding: Binding, selection: MarkdownSelection) => {
      if (!available || !selection.quote) return;
      setEditor({ bindingId: binding.id, start_offset: selection.start, end_offset: selection.end, quote: selection.quote });
      setText(''); setError(null);
    },
    threadAvailable, replyTarget, changeThread,
    reply: (comment: RequestReviewComment) => { setReplyTarget(comment); setText(''); setError(null); },
    editor, decision, text, setText, saveComment, submitDecision,
    close: () => { if (!busy) { setEditor(null); setReplyTarget(null); setDecision(null); setError(null); } },
  };
}

export type AuthRequestReviewState = ReturnType<typeof useAuthRequestReview>;

function range(comment: RequestReviewComment) {
  return comment.anchor.status === 'detached' ? null : { start: comment.anchor.start_offset, end: comment.anchor.end_offset };
}

export function AuthReviewSidebar({ review, id, onNavigate, children }: {
  review: AuthRequestReviewState;
  id: string;
  onNavigate: (comment: RequestReviewComment) => void;
  children: ComponentChildren;
}) {
  const annotations = review.data?.annotations ?? [];
  return <div className={`auth-review${review.commentsOpen ? ' auth-review--with-comments' : ''}`}>
    <div className="auth-review__content">{children}</div>
    {review.data && <div className="auth-review__sidebar">
      {review.available && !review.against && <ContextualAction
        aria-label="Comment on selection" title="Comment on selection" onClick={review.comment}
        disabled={!review.selection || review.busy}>
        <Icon name="comment" />
      </ContextualAction>}
      <ReviewCommentsSidebar open={review.commentsOpen} setOpen={review.setCommentsOpen}
        selectedId={review.navigation?.comment.annotation_event_id ?? null}
        onNavigate={(_range, id) => {
          const annotation = annotations.find(comment => comment.annotation_event_id === id);
          if (annotation) onNavigate(annotation);
        }}
        comments={annotations.map(comment => ({
          id: comment.annotation_event_id,
          quote: comment.quote,
          range: range(comment),
          status: comment.origin_request_id === id ? undefined : comment.anchor.status,
          author: comment.source.kind === 'request_description' ? 'Description'
            : comment.source.kind === 'request_narrative' ? 'Narrative'
            : `${comment.source.path} · ${comment.source.side === 'before' ? 'Before' : 'After'}`,
          content: <>{comment.body}
            {review.available && comment.origin_request_id === id && !comment.thread.events.length && <ContextualAction aria-label="Remove comment"
              title="Remove comment" disabled={review.busy} onClick={() => review.remove(comment)}>
              <Icon name="dismiss" />
            </ContextualAction>}</>,
          thread: {
            resolved: comment.thread.resolved,
            events: comment.thread.events.map(event => ({
              id: event.id,
              author: event.operation === 'reply' ? (event.actor_role === 'operator' ? 'Operator' : 'Requester') : undefined,
              content: event.operation === 'reply' ? event.body
                : `${{ address: 'Addressed in', resolve: 'Resolved on', reopen: 'Reopened on' }[event.operation]} ${event.request_ref}`,
            })),
            actions: review.threadAvailable && <>
              <button type="button" className="btn btn--ghost" disabled={review.busy} onClick={() => review.reply(comment)}>Reply</button>
              <button type="button" className="btn btn--ghost" disabled={review.busy}
                onClick={() => review.changeThread(comment, { operation: comment.thread.resolved ? 'reopen' : 'resolve' })}>
                {comment.thread.resolved ? 'Reopen' : 'Resolve'}
              </button>
            </>,
          },
        }))} />
      {review.error && !review.editor && !review.replyTarget && !review.decision
        && <DetailPaneNotice severity="error" density="compact">{review.error}</DetailPaneNotice>}
    </div>}
  </div>;
}

export function authReviewMarkdownMarks(review: AuthRequestReviewState, binding?: Binding, span?: TextSpan): MarkdownRangeDecoration[] {
  return (review.data?.annotations ?? []).flatMap(comment => {
    const anchor = binding && comment.document_binding_id === binding.id && range(comment);
    if (!anchor) return [];
    const start = span ? Math.max(anchor.start, span.start) - span.start : anchor.start;
    const end = span ? Math.min(anchor.end, span.end) - span.start : anchor.end;
    return end > start ? [{ start, end, id: comment.annotation_event_id, className: 'review-range' }] : [];
  });
}

export function AuthReviewMarkdown({ review, binding, value, comparison, label, wholeFile, directives, previewPolicy, span }: {
  review: AuthRequestReviewState;
  binding?: Binding;
  value: string;
  comparison?: string;
  label: string;
  wholeFile?: boolean;
  directives?: MarkdownDirectives;
  previewPolicy?: Parameters<typeof MarkdownDocument>[0]['previewPolicy'];
  span?: TextSpan;
}) {
  const document = useRef<MarkdownDocumentHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const target = review.navigation;
  useLayoutEffect(() => {
    if (!target || !binding || target.comment.document_binding_id !== binding.id) return;
    const anchor = range(target.comment);
    if (!anchor || span && (anchor.start < span.start || anchor.end > span.end)) return;
    container.current?.scrollIntoView({ block: 'nearest' });
    document.current?.select({ start: anchor.start - (span?.start ?? 0), end: anchor.end - (span?.start ?? 0) });
  }, [target?.token, binding?.id, span?.start, span?.end]);
  return <div ref={container}><MarkdownDocument value={value} comparison={comparison}
    comparisonLayout={wholeFile ? 'full-document' : undefined} readOnly ariaLabel={label}
    directives={directives} previewPolicy={previewPolicy} documentRef={document} decorations={authReviewMarkdownMarks(review, binding, span)}
    onSelectionChange={selection => review.markdownSelection(binding,
      { ...selection, start: selection.start + (span?.start ?? 0), end: selection.end + (span?.start ?? 0) })} /></div>;
}

export function AuthReviewMarkdownChange({ review, pair, index, wholeFile }: {
  review: AuthRequestReviewState;
  pair: Extract<DiffFilePair, { kind: 'text' }>;
  index: number;
  wholeFile: boolean;
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
    <AuthReviewMarkdown key={active} review={review} binding={binding} value={pair[active].contents}
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
  const label = review.replyTarget ? 'Reply' : review.editor ? 'Comment' : review.decision === 'return' ? 'Return for revision' : 'Reject request';
  const quote = review.replyTarget?.quote ?? review.editor?.quote;
  return <DetailPaneModal open={Boolean(review.editor || review.replyTarget || review.decision)} onClose={review.close}
    titleId="auth-review-decision" title={label} closeLabel="Close review dialog">
    <form className="auth-review__dialog" onSubmit={event => {
      event.preventDefault();
      if (review.replyTarget) review.changeThread(review.replyTarget, { operation: 'reply', body: review.text });
      else if (review.editor) review.saveComment();
      else review.submitDecision();
    }}>
      {quote && <blockquote className="review-comments__quote">{quote}</blockquote>}
      <label>{review.replyTarget ? 'Reply' : review.editor ? 'Comment' : 'Reason (optional)'}
        <textarea value={review.text} rows={4} onInput={event => review.setText(event.currentTarget.value)} />
      </label>
      {review.error && <div role="alert">{review.error}</div>}
      <button type="submit" className="btn" disabled={review.busy
        || (review.decision === 'return' && review.drafts.hasConflicts)
        || Boolean((review.editor || review.replyTarget) && !review.text.trim())}>
        {review.replyTarget ? 'Reply' : review.editor ? 'Save comment'
          : review.decision === 'return' ? (review.drafts.hasEdits ? 'Return with edits' : 'Return') : 'Reject'}
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

export function AuthReviewTextFile({ review, pair, index, view, section }: {
  review: AuthRequestReviewState; pair: TextPair; index: number;
  view: Omit<ChangeTextFileView, 'defaultContent'> & { defaultContent?: ComponentChildren };
  section?: NarrativeHunk;
}) {
  const markdown = /\.(?:md|markdown)$/i.test(pair.after.name);
  const shown = section ? narrativeHunkPair(pair, section) : pair;
  const bindings = review.data?.round.bindings ?? [];
  const binding = bindings.find(({ source }) => source.kind === 'request_file' && source.file_index === index && source.side === 'after');
  const pinned = !section
    ? (markdown ? <AuthReviewMarkdownChange review={review} pair={pair} index={index} wholeFile={view.wholeFile} /> : view.defaultContent)
    : markdown
      ? <AuthReviewMarkdown review={review} binding={binding} value={shown.after.contents} comparison={shown.before.contents}
          label={pair.after.name} span={section.after} wholeFile />
      : <Suspense fallback={null}><PierreDraftDiff input={{ ...shown, kind: 'contents' }} mode={view.mode} wrap={view.wrap} wholeFile
          ariaLabel={shown.after.name} onLineSelection={range => {
            if (!range) { review.lineSelection(index, null); return; }
            const side = range.side;
            const preceding = pair[side].contents.slice(0, section[side].start).split('\n').length - 1;
            const original = { side, startLine: range.startLine + preceding, endLine: range.endLine + preceding };
            review.lineSelection(index, original, quoteReviewLines(pair[side].contents, original.startLine - 1, original.endLine));
          }} /></Suspense>;
  const fileDraft = !review.against ? review.drafts.forFile(index, pair) : null;
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
