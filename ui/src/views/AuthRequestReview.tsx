import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useAuthReviewDrafts, type AuthReviewFileDraft } from './useAuthReviewDrafts';
import type { ChangeTextFileView } from '../components/ChangeList';
import { lazy, Suspense } from 'preact/compat';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { CollapsiblePanel } from '../components/shared/CollapsiblePanel';
import type { RequestReviewComment } from '../../../src/feedback/request-review';
import type { ReviewRange } from '../../../src/feedback/review-types';
import type { AuthChangeReport, DiffFilePair } from '../../../src/contracts';
import {
  annotateAuthReview, getAuthReview, getAuthReviewComparison, returnAuthReview, type AuthReviewProjection,
} from '../api';
import { MarkdownDocument, type MarkdownDocumentHandle, type MarkdownSelection } from '../components/MarkdownDocument';
import { ReviewCommentsSidebar } from '../components/shared/ReviewCommentsSidebar';
import { ContextualAction } from '../components/shared/ContextualAction';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { Icon } from '../components/icons/Icon';
import { NativeSelect } from '../components/shared/NativeSelect';
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
    const next = await getAuthReview(id, controller.signal);
    if (!controller.signal.aborted) setData(next);
  }, [id]);
  useEffect(() => {
    void refresh().catch(() => undefined);
    return () => request.current?.abort();
  }, [refresh, status, updatedAt]);

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
    openDecision, selection, lineSelection, markdownSelection, remove, busy, error,
    clearSelection: () => setSelection(null),
    comment: () => { setEditor(selection); setText(''); setError(null); },
    editor, decision, text, setText, saveComment, submitDecision,
    close: () => { if (!busy) { setEditor(null); setDecision(null); setError(null); } },
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
            : `${comment.source.path} · ${comment.source.side === 'before' ? 'Before' : 'After'}`,
          content: <>{comment.body}
            {review.available && comment.origin_request_id === id && <ContextualAction aria-label="Remove comment"
              title="Remove comment" disabled={review.busy} onClick={() => review.remove(comment)}>
              <Icon name="dismiss" />
            </ContextualAction>}</>,
        }))} />
    </div>}
  </div>;
}

export function AuthReviewMarkdown({ review, binding, value, comparison, label, wholeFile }: {
  review: AuthRequestReviewState;
  binding?: Binding;
  value: string;
  comparison?: string;
  label: string;
  wholeFile?: boolean;
}) {
  const document = useRef<MarkdownDocumentHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const target = review.navigation;
  useLayoutEffect(() => {
    if (!target || !binding || target.comment.document_binding_id !== binding.id) return;
    const anchor = range(target.comment);
    if (!anchor) return;
    container.current?.scrollIntoView({ block: 'nearest' });
    document.current?.select(anchor);
  }, [target?.token, binding?.id]);
  const marks = (review.data?.annotations ?? []).flatMap(comment => {
    const anchor = binding && comment.document_binding_id === binding.id && range(comment);
    return anchor ? [{ ...anchor, id: comment.annotation_event_id, className: 'review-range' }] : [];
  });
  return <div ref={container}><MarkdownDocument value={value} comparison={comparison} comparisonLayout={wholeFile ? 'full-document' : undefined} readOnly ariaLabel={label}
    documentRef={document} decorations={marks} onSelectionChange={selection => review.markdownSelection(binding, selection)} /></div>;
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
        {versions.map((version, index) => <option key={version.id} value={version.id}>
          {index + 1} · {version.short_id} · {version.status}
        </option>)}
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
  const label = review.editor ? 'Comment' : review.decision === 'return' ? 'Return for revision' : 'Reject request';
  return <DetailPaneModal open={Boolean(review.editor || review.decision)} onClose={review.close}
    titleId="auth-review-decision" title={label} closeLabel="Close review dialog">
    <form className="auth-review__dialog" onSubmit={event => {
      event.preventDefault();
      if (review.editor) review.saveComment();
      else review.submitDecision();
    }}>
      {review.editor && <blockquote className="review-comments__quote">{review.editor.quote}</blockquote>}
      <label>{review.editor ? 'Comment' : 'Reason (optional)'}
        <textarea value={review.text} rows={4} onInput={event => review.setText(event.currentTarget.value)} />
      </label>
      {review.error && <div role="alert">{review.error}</div>}
      <button type="submit" className="btn" disabled={review.busy || (review.decision === 'return' && review.drafts.hasConflicts) || Boolean(review.editor && !review.text.trim())}>
        {review.editor ? 'Save comment' : review.decision === 'return' ? (review.drafts.hasEdits ? 'Return with edits' : 'Return') : 'Reject'}
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

export function AuthReviewTextFile({ review, pair, index, view }: {
  review: AuthRequestReviewState; pair: TextPair; index: number; view: ChangeTextFileView;
}) {
  const markdown = /\.(?:md|markdown)$/i.test(pair.after.name);
  const pinned = markdown ? <AuthReviewMarkdownChange review={review} pair={pair} index={index} wholeFile={view.wholeFile} /> : view.defaultContent;
  const draft = !review.against ? review.drafts.forFile(index, pair) : null;
  if (!draft) return <>{pinned}</>;
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
      ? <MarkdownDocument value={draft.source} readOnly={!draft.writable} comparison={pair.after.contents}
        comparisonLayout={view.wholeFile ? 'full-document' : undefined} ariaLabel={label} onChange={draft.change} />
      : <PierreReviewDraft key={`${draft.externalVersion}:${Boolean(review.available)}`}
        editable={Boolean(review.available)} draft={draft} pair={pair} view={view} />) : pinned}
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
