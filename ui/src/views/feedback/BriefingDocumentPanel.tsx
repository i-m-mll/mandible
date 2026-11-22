import { standingNoteSidebarEntry } from '../../components/shared/StandingNoteReview';
import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  postBriefingAnnotations, type BriefingAnnotation, type BriefingAnnotationOperation,
  type BriefingDirectiveItem, type BriefingResponseValue, type BriefingRoundProjection,
} from '../../api';
import { Icon } from '../../components/icons/Icon';
import {
  MarkdownDocument, type MarkdownDirectiveRenderer, type MarkdownDocumentHandle, type MarkdownSelection,
  type MarkdownSourceRange,
} from '../../components/MarkdownDocument';
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
  onContentGateChange?(reason: string): void;
  onDocumentFailureChange?(message: string | null): void;
};

type AnnotationEditor = MarkdownSelection & { annotation: BriefingAnnotation | null };
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
    || (annotation.presentation?.source === 'current_draft' ? 'You' : 'Unknown user');
}

export function BriefingDocumentPanel({ briefingId, roundId, round, canMutate, draftIdentity, onRefresh,
  draft = EMPTY_VALUES, validationErrors = EMPTY_VALUES, onDirectiveValue, onContentGateChange, onDocumentFailureChange,
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
  const [kind, setKind] = useState<BriefingAnnotation['annotation_kind']>('comment');
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const documentRef = useRef<MarkdownDocumentHandle>(null);

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
  }, [roundKey]);

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
  const contentGate = failure ?? (ready ? '' : 'Verifying pinned document…');
  const canInteract = canMutate && ready && !busy;
  useEffect(() => onContentGateChange?.(contentGate), [contentGate, onContentGateChange]);
  useEffect(() => onDocumentFailureChange?.(failure), [failure, onDocumentFailureChange]);
  useEffect(() => () => onDocumentFailureChange?.(null), [onDocumentFailureChange]);

  const openEditor = (range: MarkdownSelection, annotation: BriefingAnnotation | null = null) => {
    setEditor({ ...range, annotation });
    setKind(annotation?.annotation_kind ?? 'comment');
    setBody(annotation?.body ?? '');
    setReplacement(annotation?.replacement_text ?? range.quote);
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
    documentRef.current?.select(range);
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
      ...(canInteract && annotation.presentation?.source === 'current_draft' ? { edit: () => openExisting(annotation) } : {}),
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
  const validSelection = selection && selection.start < selection.end
    && document?.source.slice(selection.start, selection.end) === selection.quote ? selection : null;

  const directiveItemsRef = useRef(directives);
  directiveItemsRef.current = directives;
  const directiveHosts = useRef(new Map<HTMLElement, string>());
  const [, setHostsRevision] = useState(0);
  const allowlist = useMemo(() => {
    const render: MarkdownDirectiveRenderer = (node, owner) => {
      const element = owner.createElement('div');
      const item = directiveItemsRef.current.find((candidate) => candidate.directive && candidate.directive.key === node.attributes.key
        && candidate.directive.start_offset === node.start && candidate.directive.end_offset === node.end);
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
      setEditor(null);
      setCommentsOpen(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editor || !canInteract) return;
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
          <div className="briefing-document__review-toolbar">
            <ContextualAction aria-label="Comment on selection" title="Comment on selection"
              disabled={!canInteract || !validSelection} onClick={() => validSelection && openEditor(validSelection)}>
              <Icon name="comment" />
            </ContextualAction>
          </div>
          <div className={`briefing-document__review${commentsOpen ? ' briefing-document__review--with-comments' : ''}`}>
            <MarkdownDocument key={roundKey} documentRef={documentRef} value={document.source}
              comparison={currentComparison ? currentComparison.text : comparison?.text} comparisonLayout="full-document" readOnly ariaLabel="Pinned briefing document"
              directives={allowlist} previewPolicy={BRIEFING_MARKDOWN_PREVIEW} decorations={decorations}
              onSelectionChange={setSelection} onDecorationClick={openComment} />
            <ReviewCommentsSidebar comments={comments} open={commentsOpen} setOpen={setCommentsOpen}
              onNavigate={viewAnchor} selectedId={selectedCommentId} />
          </div>
          {Array.from(directiveHosts.current, ([element, itemId]) => {
            const item = directives.find((directive) => directive.id === itemId);
            if (!item?.directive) return null;
            const current = Object.hasOwn(draft, item.id) ? draft[item.id] ?? null : item.effective_response?.value ?? null;
            return createPortal(
              <BriefingDirectiveControls key={`${itemId}:${draftIdentity ?? ''}`} item={{ ...item, directive: item.directive }} source={document.source}
                current={current} canInteract={canInteract} validationError={validationErrors[item.id]} decorations={decorations}
                onDirectiveValue={onDirectiveValue} onSelect={setSelection} onComment={openEditor} onDecorationClick={openComment} />,
              element,
            );
          })}
        </>
      )}
      <DetailPaneModal open={editor !== null} onClose={() => setEditor(null)}
        titleId="briefing-annotation-editor-title" title={editor?.annotation ? 'Edit annotation' : 'Add annotation'}
        closeLabel="Close annotation editor" embeddedFallback={{ scrollOwnerRef: contentRef }}
        scrollLockClassName="detail-pane-shell__body--overlay-open"
        className="briefing-document__annotation-modal" panelClassName="briefing-document__popover">
        {editor && (
          <div className="briefing-document__popover-content">
            <blockquote>{editor.quote}</blockquote>
            <div className="briefing-document__tabs" role="tablist" aria-label="Text review action">
              {(['comment', 'suggest_replacement'] as const).map((option) => (
                <button key={option} type="button" role="tab" data-annotation-kind={option}
                  aria-selected={kind === option} tabIndex={kind === option ? 0 : -1} onClick={() => setKind(option)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'comment' : 'suggest_replacement';
                    setKind(next);
                    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-annotation-kind="${next}"]`)?.focus();
                  }}>{option === 'comment' ? 'Comment' : 'Edit text'}</button>
              ))}
            </div>
            {kind === 'suggest_replacement' && <label><span>Replacement</span>
              <textarea value={replacement} onInput={(event) => setReplacement(event.currentTarget.value)} disabled={!canInteract} />
            </label>}
            <label>
              <span className={kind === 'comment' ? 'sr-only' : ''}>{kind === 'comment' ? 'Comment' : 'Note (optional)'}</span>
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
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setEditor(null)}>Cancel</button>
                <button type="button" className="btn btn--primary" disabled={!canInteract} onClick={() => void save()}>Save</button>
              </div>
            </div>
          </div>
        )}
      </DetailPaneModal>
    </section>
  );
}
