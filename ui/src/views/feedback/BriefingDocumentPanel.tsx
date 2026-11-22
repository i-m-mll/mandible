import { EditorState } from '@codemirror/state';
import { standingNoteSidebarEntry } from '../../components/shared/StandingNoteReview';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  postBriefingAnnotations, type BriefingAnnotation, type BriefingAnnotationOperation,
  type BriefingDirectiveItem, type BriefingResponseValue, type BriefingRoundProjection,
} from '../../api';
import { Icon } from '../../components/icons/Icon';
import {
  isLargeMarkdownDocument, MarkdownDocument, type MarkdownDirectiveRenderer, type MarkdownDocumentHandle, type MarkdownSelection,
  type MarkdownSourceRange,
} from '../../components/MarkdownDocument';
import { externalSourceUpdate, markdownEditorRange, markdownValue } from '../../components/markdown/source';
import { appTip } from '../../components/shared/AppHoverTips';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { ContextualAction } from '../../components/shared/ContextualAction';
import { DetailPaneModal } from '../../components/shared/DetailPaneModal';
import { ReviewCommentsSidebar, type ReviewSidebarComment } from '../../components/shared/ReviewCommentsSidebar';
import { BriefingDirectiveControls, BRIEFING_MARKDOWN_PREVIEW } from './BriefingDirectiveControls';

export type BriefingDocumentPanelProps = {
  briefingId: string;
  briefingTitle: string;
  roundId: string;
  round: BriefingRoundProjection;
  canMutate: boolean;
  draftIdentity?: string | null;
  onRefresh(): Promise<BriefingRoundProjection | null>;
  draft?: Record<string, BriefingResponseValue | null>;
  validationErrors?: Record<string, string>;
  onDirectiveValue?(itemId: string, value: BriefingResponseValue | null): void;
  onContentGateChange?(reason: string | null): void;
  onDocumentFailureChange?(message: string | null): void;
  onAnnotationEditChange?(editing: boolean): void;
};

type AnnotationEditor = MarkdownSelection & {
  annotation: BriefingAnnotation | null;
  kind: BriefingAnnotation['annotation_kind'];
};
const EMPTY_VALUES = {};

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyDocument(document: { source: string; utf8_bom?: boolean; content_hash: string }) {
  return await sha256((document.utf8_bom ? '\uFEFF' : '') + document.source) === document.content_hash;
}

async function verifyDirectives(source: string, items: readonly BriefingDirectiveItem[]) {
  let cursor = 0;
  for (const item of items) {
    if (!item.directive) return false;
    const directive = item.directive;
    if (directive.start_offset < cursor || directive.end_offset > source.length
        || directive.body_start_offset < directive.start_offset || directive.body_end_offset > directive.end_offset
        || directive.body_start_offset >= directive.body_end_offset) return false;
    if (item.revision.response_type === 'text_variant') {
      if ((item.revision.variants ?? []).some((variant) => variant.start_offset < directive.body_start_offset
          || variant.end_offset > directive.body_end_offset
          || source.slice(variant.body_start_offset, variant.body_end_offset) !== variant.body)) return false;
    } else if (source.slice(directive.body_start_offset, directive.body_end_offset) !== item.revision.prompt) return false;
    cursor = directive.end_offset;
  }
  const digests = await Promise.all(items.map(({ directive }) =>
    sha256(source.slice(directive!.start_offset, directive!.end_offset))));
  return items.every(({ directive }, index) => directive!.definition_digest === digests[index]);
}

function annotationActor(annotation: BriefingAnnotation): string {
  return annotation.presentation?.actor?.display_name || annotation.presentation?.actor?.slug
    || (annotation.presentation?.source === 'current_draft' ? 'You' : 'Reviewer');
}

export function BriefingDocumentPanel({ briefingId, roundId, round, canMutate, draftIdentity, onRefresh,
  draft = EMPTY_VALUES, validationErrors = EMPTY_VALUES, onDirectiveValue, onContentGateChange, onDocumentFailureChange, onAnnotationEditChange,
}: BriefingDocumentPanelProps): JSX.Element | null {
  const document = round.document;
  const standingNotes = round.standing_notes;
  const [verified, setVerified] = useState<{ documentKey: string; directiveKey: string; documentError: string | null;
    directiveError: string | null } | null>(null);
  const [comparison, setComparison] = useState<{ key: string; text: string | undefined; error: string | null } | null>(null);
  const [selection, setSelection] = useState<MarkdownSelection | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [editor, setEditor] = useState<AnnotationEditor | null>(null);
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const documentRef = useRef<MarkdownDocumentHandle>(null);
  const selectionToRestore = useRef<MarkdownSourceRange | null>(null);

  const directives = useMemo(() => [...round.items].sort((a, b) =>
    (a.directive?.start_offset ?? 0) - (b.directive?.start_offset ?? 0)), [round.items]);
  const documentKey = useMemo(() => document
    ? JSON.stringify([document.artifact_version_id, document.content_hash, document.utf8_bom, document.source]) : '',
    [document?.artifact_version_id, document?.content_hash, document?.utf8_bom, document?.source]);
  const directiveKey = useMemo(() => JSON.stringify(directives.map(({ id, directive, revision }) =>
    [id, directive, revision.response_type, revision.prompt, revision.variants])), [directives]);
  const base = document?.comparison_base ?? null;
  const comparisonKey = useMemo(() => JSON.stringify(base && [base.target ?? base.artifact_version_id,
    base.content_hash, base.utf8_bom, base.source]), [base]);
  const roundKey = `${briefingId}:${roundId}`;

  useEffect(() => {
    setEditor(null);
    setSelection(null);
    setSelectedCommentId(null);
    setStatus(null);
  }, [roundKey, documentKey]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    void (async () => {
      let documentError = null;
      let directiveError = null;
      try {
        if (!await verifyDocument(document)) documentError = 'The pinned document content does not match its verified hash.';
        else if ((!directives.length && document.profile !== 'mandible-briefing.v3')
            || !await verifyDirectives(document.source, directives)) {
          directiveError = 'The pinned directives do not match their document binding.';
        }
      } catch (error) {
        documentError = error instanceof Error ? error.message : String(error);
      }
      if (!cancelled) setVerified({ documentKey, directiveKey, documentError, directiveError });
    })();
    return () => { cancelled = true; };
  }, [documentKey, directiveKey]);

  useEffect(() => {
    let cancelled = false;
    if (!base) {
      setComparison({ key: comparisonKey, text: undefined, error: null });
      return;
    }
    void verifyDocument(base).then((valid) => {
      if (!cancelled) setComparison({ key: comparisonKey, text: valid ? base.source : undefined,
        error: valid ? null : 'The pinned comparison content does not match its verified hash.' });
    }).catch((error) => {
      if (!cancelled) setComparison({ key: comparisonKey, text: undefined, error: String(error) });
    });
    return () => { cancelled = true; };
  }, [comparisonKey]);

  const currentDocument = verified?.documentKey === documentKey ? verified : null;
  const currentComparison = comparison?.key === comparisonKey ? comparison : null;
  const failure = currentDocument?.documentError || currentDocument?.directiveError || currentComparison?.error
    || (round.directive_binding?.status !== 'valid' ? round.directive_binding?.reason || 'The pinned document binding is unavailable.' : null);
  const ready = currentDocument !== null && currentDocument.directiveKey === directiveKey && currentComparison !== null && !failure;
  const contentGate = failure ?? (ready ? '' : null);
  const canInteract = canMutate && ready && !busy;
  useEffect(() => onContentGateChange?.(contentGate), [contentGate, onContentGateChange]);
  useEffect(() => onDocumentFailureChange?.(failure), [failure, onDocumentFailureChange]);
  useEffect(() => () => onDocumentFailureChange?.(null), [onDocumentFailureChange]);

  const inline = editor?.kind === 'suggest_replacement' ? editor : null;
  const source = document?.source ?? '';
  const prefix = inline ? source.slice(0, inline.start) : '';
  const suffix = inline ? source.slice(inline.end) : '';
  const previewSource = inline ? prefix + replacement + suffix : source;
  const mayReplace = source.length > 0 && !isLargeMarkdownDocument(source);
  const delta = inline ? replacement.length - inline.quote.length : 0;
  const workingRange = (range: MarkdownSourceRange): MarkdownSourceRange | null => {
    if (!inline || range.end <= inline.start) return range;
    if (range.start >= inline.end) return { start: range.start + delta, end: range.end + delta };
    return null;
  };
  const replacementRange = useRef({ start: 0, end: 0 });
  const editStart = inline?.start ?? 0;
  const tailLength = suffix.length;
  const inlineEditing = inline !== null;
  const editingExtension = useMemo(() => inlineEditing ? EditorState.changeFilter.of(transaction => {
    if (!transaction.docChanged || transaction.annotation(externalSourceUpdate)) return true;
    const state = transaction.startState;
    const { from, to } = markdownEditorRange(state, {
      start: editStart, end: markdownValue(state).length - tailLength,
    });
    let allowed = true;
    transaction.changes.iterChangedRanges((start, end) => { allowed &&= start >= from && end <= to; });
    return allowed;
  }) : undefined, [editStart, inlineEditing, tailLength]);

  useEffect(() => {
    onAnnotationEditChange?.(inlineEditing);
    return () => onAnnotationEditChange?.(false);
  }, [inlineEditing, onAnnotationEditChange]);

  useLayoutEffect(() => {
    const target = inlineEditing ? replacementRange.current : selectionToRestore.current;
    selectionToRestore.current = null;
    if (!target) return;
    const frame = requestAnimationFrame(() => documentRef.current?.select(target, inlineEditing));
    return () => cancelAnimationFrame(frame);
  }, [inlineEditing]);

  const closeEditor = () => {
    if (inline) selectionToRestore.current = inline;
    setEditor(null);
    setStatus(null);
  };
  const openEditor = (range: MarkdownSelection, annotation: BriefingAnnotation | null = null,
    kind: BriefingAnnotation['annotation_kind'] = annotation?.annotation_kind ?? 'comment', note = annotation?.body ?? '') => {
    if (!canInteract || (kind === 'suggest_replacement' && !mayReplace) || source.slice(range.start, range.end) !== range.quote) return;
    const proposed = annotation?.replacement_text ?? range.quote;
    replacementRange.current = { start: range.start, end: range.start + proposed.length };
    setEditor({ ...range, annotation, kind });
    setBody(note);
    setReplacement(proposed);
    setStatus(null);
  };

  const currentRange = (annotation: BriefingAnnotation) => ({
    start: annotation.start_offset, end: annotation.end_offset, quote: annotation.quote,
  });
  const openExisting = (annotation: BriefingAnnotation) => openEditor(currentRange(annotation), annotation);
  const openComment = (id: string) => {
    setSelectedCommentId(id);
    setCommentsOpen(true);
  };
  const viewAnchor = (range: MarkdownSourceRange, id: string) => {
    openComment(id);
    const visible = workingRange(range);
    if (visible) documentRef.current?.select(visible);
  };
  const describe = (entry: BriefingAnnotation) => entry.annotation_kind === 'suggest_replacement'
    ? <><del>{entry.quote}</del> <ins>{entry.replacement_text}</ins>{entry.body && <div>{entry.body}</div>}</>
    : entry.body;
  const standingRanges = useMemo(() => (standingNotes ?? []).map((note) => ({
    note,
    range: note.anchor.status === 'detached' ? null : { start: note.anchor.start_offset, end: note.anchor.end_offset },
  })), [standingNotes]);
  const comments: ReviewSidebarComment[] = [
    ...standingRanges.map(({ note, range }) => standingNoteSidebarEntry(note, range)),
    ...(round.annotations ?? []).map((annotation) => ({
      id: annotation.annotation_event_id, quote: annotation.quote,
      range: currentRange(annotation), author: annotationActor(annotation), content: describe(annotation),
      ...(canInteract && !inline && annotation.presentation?.source === 'current_draft' ? { edit: () => openExisting(annotation) } : {}),
    })),
    ...(round.carried_annotations ?? []).map((annotation) => ({
      id: annotation.annotation_event_id, quote: annotation.quote,
      range: annotation.anchor.status === 'detached' ? null : currentRange({
        ...annotation, start_offset: annotation.anchor.start_offset, end_offset: annotation.anchor.end_offset,
      }),
      status: annotation.anchor.status, author: annotationActor(annotation), content: describe(annotation),
    })),
  ];
  const decorations = useMemo(() => [
    ...standingRanges.flatMap(({ note, range }) => range ? [{ ...range, id: note.id, className: 'review-range' }] : []),
    ...(round.annotations ?? []).map((annotation) => ({
      ...currentRange(annotation), id: annotation.annotation_event_id, className: 'review-range',
    })),
    ...(round.carried_annotations ?? []).flatMap(({ annotation_event_id, anchor }) =>
      anchor.status === 'detached' ? [] : [{ start: anchor.start_offset, end: anchor.end_offset,
        id: annotation_event_id, className: 'review-range' }]),
  ], [round.annotations, round.carried_annotations, standingRanges]);
  const visibleDecorations = inline ? decorations.flatMap(decoration => {
    const range = workingRange(decoration);
    return range ? [{ ...decoration, ...range }] : [];
  }) : decorations;
  if (inline && replacement.length) visibleDecorations.push({
    start: inline.start, end: inline.start + replacement.length, id: 'briefing-inline-replacement', className: 'review-range',
  });
  const validSelection = selection && selection.start < selection.end
    && document?.source.slice(selection.start, selection.end) === selection.quote ? selection : null;

  const directiveItemsRef = useRef({ directives, workingRange, inlineEditing });
  directiveItemsRef.current = { directives, workingRange, inlineEditing };
  const directiveHosts = useRef(new Map<HTMLElement, string>());
  const [, setHostsRevision] = useState(0);
  const allowlist = useMemo(() => {
    const locate = (node: Parameters<MarkdownDirectiveRenderer>[0]) => {
      const { directives, workingRange } = directiveItemsRef.current;
      return directives.find(({ directive }) => {
        if (!directive || directive.key !== node.attributes.key) return false;
        const range = workingRange({ start: directive.start_offset, end: directive.end_offset });
        return range?.start === node.start && range.end === node.end;
      });
    };
    const render: MarkdownDirectiveRenderer = (node, owner) => {
      const element = owner.createElement('div');
      const item = locate(node);
      if (!item) {
        element.textContent = node.quote;
        return element;
      }
      directiveHosts.current.set(element, item.id);
      queueMicrotask(() => setHostsRevision((value) => value + 1));
      return { element, destroy: () => {
        directiveHosts.current.delete(element);
        queueMicrotask(() => setHostsRevision((value) => value + 1));
      } };
    };
    render.accepts = (node) => !directiveItemsRef.current.inlineEditing || Boolean(locate(node));
    return new Map([['spec-item', render]]);
  }, []);

  const mutate = async (operations: BriefingAnnotationOperation[]) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await postBriefingAnnotations(briefingId, roundId, operations);
      if (result.annotation_event_ids.length !== operations.length) {
        throw new Error('The annotation service returned an ambiguous event result.');
      }
      await onRefresh();
      closeEditor();
      setCommentsOpen(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editor || !canInteract || source.slice(editor.start, editor.end) !== editor.quote) return;
    const { kind } = editor;
    if (kind === 'comment' && !body.trim()) {
      setStatus('Comment text is required.');
      return;
    }
    const range = { operation: 'set' as const, start_offset: editor.start, end_offset: editor.end, quote: editor.quote };
    const annotation: BriefingAnnotationOperation = kind === 'comment'
      ? { ...range, annotation_kind: kind, body: body.trim() }
      : { ...range, annotation_kind: kind, replacement_text: replacement, ...(body.trim() ? { body: body.trim() } : {}) };
    const operations: BriefingAnnotationOperation[] = editor.annotation
      ? [{ operation: 'retract', annotation_event_id: editor.annotation.annotation_event_id }, annotation] : [annotation];
    await mutate(operations);
  };

  if (!document) return null;
  return (
    <section ref={contentRef} className="briefing-document__content" aria-label="Briefing document">
      {currentDocument && !currentDocument.documentError && (
        <>
          {inline ? (
            <form className="briefing-document__review-toolbar briefing-document__inline-replacement" aria-label="Text replacement"
              onSubmit={event => { event.preventDefault(); void save(); }}>
              <textarea aria-label="Note (optional)" placeholder="Add a note" rows={2} value={body} disabled={!canInteract}
                onInput={event => setBody(event.currentTarget.value)} />
              {inline.annotation && <ContextualAction presentation="compact" aria-label="Delete replacement" {...appTip('Delete replacement')}
                disabled={!canInteract} onClick={() => void mutate([{ operation: 'retract', annotation_event_id: inline.annotation!.annotation_event_id }])}>
                <Icon name="discard" />
              </ContextualAction>}
              <ContextualAction presentation="compact" aria-label="Cancel replacement" {...appTip('Cancel replacement')}
                disabled={busy} onClick={closeEditor}><Icon name="dismiss" /></ContextualAction>
              <ContextualAction presentation="compact" type="submit" aria-label="Save replacement" {...appTip('Save replacement')}
                disabled={!canInteract || (replacement === inline.quote && !body.trim())}><Icon name="keep" /></ContextualAction>
            </form>
          ) : (
            <div className="briefing-document__review-toolbar">
              <ContextualAction presentation="compact" aria-label="Comment on selection" {...appTip('Comment on selection')}
                disabled={!canInteract || !validSelection} onClick={() => validSelection && openEditor(validSelection)}>
                <Icon name="comment" />
              </ContextualAction>
              <ContextualAction presentation="compact" aria-label="Edit selected text" {...appTip('Edit selected text')}
                disabled={!canInteract || !mayReplace || !validSelection}
                onClick={() => validSelection && openEditor(validSelection, null, 'suggest_replacement')}>
                <Icon name="editAnnotation" />
              </ContextualAction>
            </div>
          )}
          {inline && status && <DetailPaneNotice severity="error" density="compact">{status}</DetailPaneNotice>}
          <div key="review-document" className={`briefing-document__review${commentsOpen ? ' briefing-document__review--with-comments' : ''}`}>
            <MarkdownDocument key={roundKey} documentRef={documentRef} value={previewSource}
              comparison={currentComparison ? currentComparison.text : comparison?.text} comparisonLayout="full-document"
              readOnly={!inline || !canInteract} ariaLabel="Pinned briefing document" editingExtension={editingExtension}
              directives={allowlist} previewPolicy={BRIEFING_MARKDOWN_PREVIEW} decorations={visibleDecorations}
              onChange={inline ? value => {
                if (value.startsWith(prefix) && value.endsWith(suffix)) setReplacement(value.slice(prefix.length, value.length - suffix.length));
              } : undefined}
              onSelectionChange={inline ? undefined : setSelection}
              onKeyDown={event => {
                if (!inline || busy || event.key !== 'Escape') return false;
                closeEditor();
                return true;
              }} onDecorationClick={openComment} />
            <ReviewCommentsSidebar comments={comments} open={commentsOpen} setOpen={setCommentsOpen}
              onNavigate={viewAnchor} selectedId={selectedCommentId} />
          </div>
          {Array.from(directiveHosts.current, ([element, itemId]) => {
            const item = directives.find((directive) => directive.id === itemId);
            if (!item?.directive) return null;
            const current = Object.hasOwn(draft, item.id) ? draft[item.id] ?? null : item.effective_response?.value ?? null;
            return createPortal(
              <BriefingDirectiveControls key={`${itemId}:${draftIdentity ?? ''}`} item={{ ...item, directive: item.directive }} source={document.source}
                current={current} canInteract={canInteract && !inline} validationError={validationErrors[item.id]} decorations={decorations}
                onDirectiveValue={onDirectiveValue} onSelect={setSelection} onComment={openEditor} onDecorationClick={openComment} />,
              element,
            );
          })}
        </>
      )}
      <DetailPaneModal open={editor?.kind === 'comment'} onClose={closeEditor}
        titleId="briefing-annotation-editor-title" title={editor?.annotation ? 'Edit annotation' : 'Add annotation'}
        headerActions={editor && !editor.annotation && mayReplace ? <ContextualAction presentation="compact" aria-label="Edit text" {...appTip('Edit text')}
          disabled={!canInteract} onClick={() => openEditor(editor, null, 'suggest_replacement', body)}><Icon name="editAnnotation" /></ContextualAction> : undefined}
        closeLabel="Close annotation editor" embeddedFallback={{ scrollOwnerRef: contentRef }}
        scrollLockClassName="detail-pane-shell__body--overlay-open"
        className="briefing-document__annotation-modal" panelClassName="briefing-document__popover">
        {editor && (
          <div className="briefing-document__popover-content">
            <blockquote>{editor.quote}</blockquote>
            <label>
              <span className="sr-only">Comment</span>
              <textarea value={body} onInput={(event) => setBody(event.currentTarget.value)} disabled={!canInteract} />
            </label>
            {status && <p className="briefing-document__popover-status" role="status">{status}</p>}
            <div className="briefing-document__popover-actions">
              <div>
                {editor.annotation?.presentation?.source === 'current_draft' && (
                  <button type="button" className="btn btn--ghost btn--sm" disabled={!canInteract}
                    onClick={() => void mutate([{ operation: 'retract', annotation_event_id: editor.annotation!.annotation_event_id }])}>Delete</button>
                )}
              </div>
              <div className="briefing-document__popover-primary-actions">
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={closeEditor}>Cancel</button>
                <button type="button" className="btn btn--primary" disabled={!canInteract} onClick={() => void save()}>Save</button>
              </div>
            </div>
          </div>
        )}
      </DetailPaneModal>
    </section>
  );
}
