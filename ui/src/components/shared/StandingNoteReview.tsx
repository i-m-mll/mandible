import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { artifactReviewSource, reviewRangeFromSelection, reviewSelectionFromRange } from '../../../../src/feedback/review-ranges';
import type { StandingNoteMutation } from '../../../../src/feedback/standing-notes';
import type { ReviewRange, ReviewRangeKind, StandingNotePresentation } from '../../../../src/feedback/review-types';
import type { MarkdownDocumentHandle, MarkdownSelection, MarkdownSourceRange } from '../MarkdownDocument';
import { Icon } from '../icons/Icon';
import { ContextualAction } from './ContextualAction';
import { DetailPaneModal } from './DetailPaneModal';
import { ReviewCommentsSidebar, type ReviewSidebarComment } from './ReviewCommentsSidebar';

type StandingNoteView = StandingNotePresentation;

export function standingNoteSidebarEntry(note: StandingNoteView, range: MarkdownSourceRange | null): ReviewSidebarComment {
  return { id: note.id, quote: note.quote, author: note.author, status: note.anchor.status, range,
    content: note.body, ...(note.resolved ? { thread: { resolved: true, events: [] } } : {}) };
}

type NoteReviewOptions = {
  scopeKey: string;
  source: string;
  rangeKind: ReviewRangeKind;
  notes: readonly StandingNoteView[];
  onCreate?(range: ReviewRange, body: string, source: string): Promise<void>;
  onMutate?(id: string, mutation: StandingNoteMutation): Promise<void>;
  stripBom?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  documentRef?: { current: MarkdownDocumentHandle | null };
  scrollOwnerRef?: { current: HTMLElement | null };
};

type Composer = { kind: 'add'; range: ReviewRange; source: string } | { kind: 'edit'; note: StandingNoteView };

export function useStandingNoteReview({ scopeKey, source, rangeKind, notes, onCreate, onMutate, stripBom,
  open, onOpenChange, documentRef: externalRef, scrollOwnerRef,
}: NoteReviewOptions) {
  const ownDocumentRef = useRef<MarkdownDocumentHandle>(null);
  const documentRef = externalRef ?? ownDocumentRef;
  const titleId = useId();
  const [selection, setSelection] = useState<MarkdownSelection | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [body, setBody] = useState('');
  const [localOpen, setLocalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offset = stripBom && source.startsWith('\uFEFF') ? 1 : 0;
  const noteSource = stripBom ? artifactReviewSource(source) : source;

  useEffect(() => {
    setSelection(null);
    setSelectedId(null);
    setComposer(null);
    setError(null);
  }, [scopeKey]);

  const setOpen = (value: boolean) => {
    setLocalOpen(value);
    onOpenChange?.(value);
  };
  const showNote = (id: string) => {
    setSelectedId(id);
    setOpen(true);
  };

  const notesWithRanges = useMemo(() => notes.map(note => {
    const current = note.anchor.status === 'detached' ? null
      : reviewSelectionFromRange(noteSource, note.anchor, rangeKind);
    return { note, range: current ? { start: current.start + offset, end: current.end + offset } : null };
  }), [notes, noteSource, offset, rangeKind]);

  const decorations = useMemo(() => notesWithRanges.flatMap(({ note, range }) => range
    ? [{ ...range, id: note.id, className: 'review-range' }] : []), [notesWithRanges]);
  const range = selection && source.slice(selection.start, selection.end) === selection.quote
    ? reviewRangeFromSelection(noteSource, Math.max(0, selection.start - offset), selection.end - offset, rangeKind)
    : null;

  const run = async (mutation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await mutation();
      setComposer(null);
      setOpen(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const toolbar = onCreate && <ContextualAction aria-label="Comment on selection" title="Comment on selection"
    disabled={busy || !range} onClick={() => {
      if (!range) return;
      setError(null);
      setBody('');
      setComposer({ kind: 'add', range, source });
    }}><Icon name="comment" /></ContextualAction>;

  const comments = notesWithRanges.map(({ note, range }): ReviewSidebarComment => {
    const entry = standingNoteSidebarEntry(note, range);
    if (!note.can_edit || !onMutate) return entry;
    return { ...entry, edit: () => {
      if (busy) return;
      setError(null);
      setBody(note.body);
      setComposer({ kind: 'edit', note });
    }, thread: { resolved: note.resolved, events: [], actions: <>
      {!note.resolved && <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
        onClick={() => void run(() => onMutate(note.id, { kind: 'resolve' }))}>Resolve</button>}
      <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
        onClick={() => void run(() => onMutate(note.id, { kind: 'retract' }))}>Retract</button>
    </> } };
  });

  const sidebar = <>
    <ReviewCommentsSidebar comments={comments} open={open ?? localOpen} setOpen={setOpen} selectedId={selectedId}
      onNavigate={(range, id) => { documentRef.current?.select(range); showNote(id); }} />
    {error && !composer && <p role="alert" className="review-comments__error">{error}</p>}
  </>;

  const composerChanged = composer?.kind === 'add' && composer.source !== source;
  const editDialog = <DetailPaneModal open={composer !== null} onClose={() => !busy && setComposer(null)}
    titleId={titleId} title={composer?.kind === 'edit' ? 'Edit comment' : 'Add comment'}
    closeLabel="Close comment editor" embeddedFallback={{ scrollOwnerRef }}
    className="briefing-document__annotation-modal" panelClassName="briefing-document__popover">
    {composer && <form className="briefing-document__popover-content" onSubmit={event => {
      event.preventDefault();
      if (busy || !body.trim() || composerChanged) return;
      if (composer.kind === 'add' && onCreate) void run(() => onCreate(composer.range, body.trim(), composer.source));
      if (composer.kind === 'edit' && onMutate) void run(() => onMutate(composer.note.id, { kind: 'edit', body: body.trim() }));
    }}>
      <blockquote className="review-comments__quote">{composer.kind === 'add' ? composer.range.quote : composer.note.quote}</blockquote>
      <textarea aria-label="Comment" value={body} disabled={busy} onInput={event => setBody(event.currentTarget.value)} />
      {(error || composerChanged) && <p role="alert">{error ?? 'The text changed. Select it again to comment.'}</p>}
      <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !body.trim() || composerChanged}>Save comment</button>
    </form>}
  </DetailPaneModal>;

  return { documentProps: { documentRef, onSelectionChange: setSelection, decorations, onDecorationClick: showNote },
    toolbar, sidebar, composer: editDialog };
}
