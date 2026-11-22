import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { RequestReviewComment } from '../../../src/feedback/request-review';
import type { ReviewRange, ReviewThreadMutation } from '../../../src/feedback/review-types';
import type { AuthChangeReport, DiffFilePair } from '../../../src/contracts';
import { DOMAIN_EVENTS } from '../../../src/contracts';
import {
  annotateAuthReview, getAuthReview, getAuthReviewComparison, mutateAuthReviewThread, returnAuthReview, type AuthReviewProjection,
} from '../api';
import { MarkdownDocument, type MarkdownDocumentHandle, type MarkdownSelection } from '../components/MarkdownDocument';
import { ReviewCommentsSidebar } from '../components/shared/ReviewCommentsSidebar';
import { ContextualAction } from '../components/shared/ContextualAction';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
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
        await returnAuthReview(id, data, text);
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
  return { data, navigation, setNavigation, commentsOpen, setCommentsOpen, available, against, compare,
    comparison: comparison?.against === against ? comparison.report : undefined, comparisonError,
    openDecision, selection, lineSelection, markdownSelection, remove, busy, error,
    comment: () => { setEditor(selection); setText(''); setError(null); },
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
      <button type="submit" className="btn" disabled={review.busy || Boolean((review.editor || review.replyTarget) && !review.text.trim())}>
        {review.replyTarget ? 'Reply' : review.editor ? 'Save comment' : review.decision === 'return' ? 'Return' : 'Reject'}
      </button>
    </form>
  </DetailPaneModal>;
}
