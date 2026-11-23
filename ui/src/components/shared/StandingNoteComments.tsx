import { useRef, useState } from 'preact/hooks';
import { artifactReviewSource, reviewRangeFromSelection, reviewSelectionFromRange } from '../../../../src/feedback/review-ranges';
import type { StandingNoteMutation } from '../../../../src/feedback/standing-notes';
import type { ReviewRange, ReviewRangeKind, StandingNotePresentation } from '../../../../src/feedback/review-types';
import type { MarkdownDocumentHandle, MarkdownSelection, MarkdownSourceRange } from '../MarkdownDocument';
import { useDocumentComments, type DocumentCommentSelection, type DocumentCommentThread } from './DocumentComments';

export function standingNoteThread(note: StandingNotePresentation, range: MarkdownSourceRange | null): DocumentCommentThread {
  return { id: note.id, quote: note.quote, author: note.author, createdAt: note.created_at, range,
    body: note.body, resolved: note.resolved };
}

type NoteCommentOptions = {
  scopeKey: string;
  source: string;
  rangeKind: ReviewRangeKind;
  notes: readonly (StandingNotePresentation & { draft?: boolean })[];
  onCreate?(range: ReviewRange, body: string, source: string): Promise<void>;
  onMutate?(id: string, mutation: StandingNoteMutation): Promise<void>;
  onEdit?(range: MarkdownSourceRange): void;
  stripBom?: boolean;
  drawerState?: { open: boolean; setOpen(open: boolean): void };
  documentRef?: { current: MarkdownDocumentHandle | null };
};

export function useStandingNoteComments({ scopeKey, source, rangeKind, notes, onCreate, onMutate, onEdit, stripBom,
  drawerState, documentRef: externalRef,
}: NoteCommentOptions) {
  const ownRef = useRef<MarkdownDocumentHandle>(null);
  const documentRef = externalRef ?? ownRef;
  const controller = useDocumentComments(scopeKey, drawerState);
  const [selected, setSelected] = useState<{ scope: string; value: MarkdownSelection } | null>(null);
  const latestSource = useRef(source);
  latestSource.current = source;
  const offset = stripBom && source.startsWith('\uFEFF') ? 1 : 0;
  const noteSource = stripBom ? artifactReviewSource(source) : source;
  const selection = selected?.scope === scopeKey ? selected.value : null;
  const mapped = selection && selection.quote && source.slice(selection.start, selection.end) === selection.quote
    ? reviewRangeFromSelection(noteSource, Math.max(0, selection.start - offset), selection.end - offset, rangeKind)
    : null;
  const selectionAction: DocumentCommentSelection | null = selection && mapped ? {
    range: selection,
    onComment: onCreate ? async (body) => {
      if (source !== latestSource.current) throw new Error('The selected text changed.');
      await onCreate(mapped, body, source);
      setSelected(null);
    } : undefined,
    onEdit: onEdit ? () => onEdit(selection) : undefined,
  } : null;
  const threads = notes.map(note => {
    const visible = note.anchor.status === 'detached' ? null : reviewSelectionFromRange(noteSource, note.anchor, rangeKind);
    const base = { ...standingNoteThread(note, visible ? { start: visible.start + offset, end: visible.end + offset } : null),
      draft: note.draft };
    if (!note.can_edit || !onMutate) return base;
    return {
      ...base,
      onEdit: (body: string) => onMutate(note.id, { kind: 'edit', body }),
      onResolve: !note.resolved ? () => onMutate(note.id, { kind: 'resolve' }) : undefined,
      onReopen: note.resolved ? () => onMutate(note.id, { kind: 'reopen' }) : undefined,
      onDelete: () => onMutate(note.id, { kind: 'retract' }),
    };
  });
  const decorations = threads.flatMap(thread => thread.range && !thread.resolved
    ? [{ ...thread.range, id: thread.id, className: 'review-range' }] : []);
  return {
    documentProps: { documentRef, decorations, onDecorationClick: controller.select,
      onSelectionChange: (value: MarkdownSelection) => setSelected({ scope: scopeKey, value }) },
    surfaceProps: { controller, documentRef, threads, selection: selectionAction, navigationKey: scopeKey },
  };
}
