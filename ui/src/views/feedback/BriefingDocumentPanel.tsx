import { createPortal } from 'preact/compat';
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  postBriefingAnnotations, type BriefingAnnotation, type BriefingAnnotationOperation,
  type BriefingDirectiveItem, type BriefingResponseValue, type BriefingRoundProjection,
} from '../../api';
import {
  isLargeMarkdownDocument, MarkdownDocument, type MarkdownChangePosition, type MarkdownDirectiveRenderer,
  type MarkdownDocumentHandle, type MarkdownSelection, type MarkdownSourceRange,
} from '../../components/MarkdownDocument';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import { DocumentCommentSurface, type DocumentCommentThread, type useDocumentComments } from '../../components/shared/DocumentComments';
import { BriefingDirectiveControls, BRIEFING_MARKDOWN_PREVIEW } from './BriefingDirectiveControls';
import { briefingSuggestionDocument, briefingSuggestionOperations, suggestionEdits, suggestionRangeMap } from './briefing-suggestions';

type BriefingDocumentPanelProps = {
  briefingId: string;
  roundId: string;
  round: BriefingRoundProjection;
  canMutate: boolean;
  draftIdentity: string | null;
  comments: ReturnType<typeof useDocumentComments>;
  documentRef: RefObject<MarkdownDocumentHandle>;
  showChanges: boolean;
  showSource: boolean;
  suggesting: boolean;
  onSuggest(): void;
  onChangePosition(position: MarkdownChangePosition): void;
  onRefresh(): Promise<BriefingRoundProjection | null>;
  draft?: Record<string, BriefingResponseValue | null>;
  validationErrors?: Record<string, string>;
  onDirectiveValue?(itemId: string, value: BriefingResponseValue | null): void;
  onContentGateChange(reason: string | null): void;
  onDocumentFailureChange(message: string | null): void;
  onPendingSuggestionChange(pending: boolean): void;
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

export function BriefingDocumentPanel({
  briefingId, roundId, round, canMutate, draftIdentity, comments, documentRef, showChanges, showSource, suggesting,
  onSuggest, onChangePosition, onRefresh, draft = EMPTY_VALUES, validationErrors = EMPTY_VALUES,
  onDirectiveValue, onContentGateChange, onDocumentFailureChange, onPendingSuggestionChange,
}: BriefingDocumentPanelProps): JSX.Element | null {
  const document = round.document;
  const standingNotes = round.standing_notes;
  const [verified, setVerified] = useState<{ documentKey: string; directiveKey: string; documentError: string | null;
    directiveError: string | null } | null>(null);
  const [comparison, setComparison] = useState<{ key: string; text: string | undefined; error: string | null } | null>(null);
  const [selection, setSelection] = useState<MarkdownSelection | null>(null);
  const [working, setWorking] = useState<ReturnType<typeof briefingSuggestionDocument> | null>(null);
  const [failedWorking, setFailedWorking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);
  const selectionToEdit = useRef<MarkdownSourceRange | null>(null);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

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
  const canInteract = canMutate && ready;
  useEffect(() => onContentGateChange?.(contentGate), [contentGate, onContentGateChange]);
  useEffect(() => onDocumentFailureChange?.(failure), [failure, onDocumentFailureChange]);


  const source = document?.source ?? '';
  const annotations = round.annotations ?? [];
  const replacements = useMemo(() => annotations.filter(annotation => annotation.annotation_kind === 'suggest_replacement'),
    [round.annotations]);
  const persisted = useMemo(() => briefingSuggestionDocument(source, replacements), [source, replacements]);
  const persistedText = persisted.text;
  const workingText = working?.text ?? persistedText;
  const dirty = workingText !== persistedText;
  const maySuggest = canInteract && source.length > 0 && !isLargeMarkdownDocument(source);
  const editing = maySuggest && suggesting;
  useEffect(() => setFailedWorking(null), [suggesting]);
  const toWorking = useMemo(() => suggestionRangeMap(source, workingText), [source, workingText]);
  const fromPersisted = useMemo(() => suggestionRangeMap(persistedText, workingText), [persistedText, workingText]);
  const toSource = useMemo(() => suggestionRangeMap(workingText, source), [source, workingText]);

  useLayoutEffect(() => {
    setWorking(current => current?.text === persistedText ? null : current);
  }, [persistedText]);

  useLayoutEffect(() => {
    onPendingSuggestionChange(dirty || busy);
  }, [dirty, busy, onPendingSuggestionChange]);

  useLayoutEffect(() => {
    if (editing && selectionToEdit.current) {
      documentRef.current?.select(selectionToEdit.current);
      selectionToEdit.current = null;
    }
  }, [editing, documentRef]);

  const mutate = async (operations: readonly BriefingAnnotationOperation[]) => {
    if (operations.length === 0) return;
    if (inFlight.current) throw new Error('Wait for the current edit to finish saving.');
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await postBriefingAnnotations(briefingId, roundId, operations);
      if (!await refresh.current()) throw new Error('Reopen this round to recover the saved edit.');
      if (result.annotation_event_ids.length !== operations.length) {
        throw new Error('The annotation service returned an incomplete event result.');
      }
      return result;
    } catch (error) {
      await refresh.current();
      throw error;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const autosave = useRef(mutate);
  autosave.current = mutate;
  useEffect(() => {
    if (!canInteract || busy || !dirty || !working || workingText === failedWorking) return;
    const timer = window.setTimeout(() => {
      const operations = briefingSuggestionOperations(source, workingText, replacements, working.changes);
      void autosave.current(operations).then(() => {
        setStatus(null);
      }, error => {
        setFailedWorking(workingText);
        setStatus(error instanceof Error ? error.message : String(error));
      });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [dirty, canInteract, busy, source, working, workingText, failedWorking, replacements]);

  const editSelection = (range: MarkdownSourceRange) => {
    if (!maySuggest) return;
    if (editing) documentRef.current?.select(range);
    else {
      selectionToEdit.current = range;
      onSuggest();
    }
  };
  const select = (annotation: BriefingAnnotation, range: MarkdownSourceRange | null, draftAnnotation: boolean): DocumentCommentThread => ({
    id: annotation.annotation_event_id,
    quote: annotation.quote,
    range,
    author: annotation.presentation?.actor?.display_name || annotation.presentation?.actor?.slug
      || (draftAnnotation ? 'You' : null),
    body: annotation.annotation_kind === 'suggest_replacement'
      ? [annotation.replacement_text || annotation.quote, annotation.body].filter(Boolean).join('\n') : annotation.body,
    createdAt: annotation.created_at,
    draft: draftAnnotation,
    onDelete: draftAnnotation && canInteract && !dirty ? async () => {
      setWorking(null);
      await mutate([{ operation: 'retract', annotation_event_id: annotation.annotation_event_id }]);
    } : undefined,
    onEdit: draftAnnotation && canInteract && !dirty && annotation.annotation_kind === 'comment' ? async body => {
      await mutate([
        { operation: 'retract', annotation_event_id: annotation.annotation_event_id },
        { operation: 'set', annotation_kind: 'comment', start_offset: annotation.start_offset,
          end_offset: annotation.end_offset, quote: annotation.quote, body },
      ]);
    } : undefined,
  });
  const workingReplacements = useMemo(() => {
    const ranges = new Map<string, MarkdownSourceRange>();
    let replacementEnd = 0;
    let delta = 0;
    for (const annotation of [...replacements].sort((a, b) => a.start_offset - b.start_offset)) {
      if (annotation.start_offset < replacementEnd || annotation.replacement_text === null) continue;
      const start = annotation.start_offset + delta;
      const end = start + annotation.replacement_text.length;
      const range = fromPersisted({ start, end });
      if (range) ranges.set(annotation.annotation_event_id, range);
      delta += annotation.replacement_text.length - annotation.quote.length;
      replacementEnd = annotation.end_offset;
    }
    return ranges;
  }, [replacements, fromPersisted]);
  const operatorAnnotations = useMemo(() => Array.from(workingReplacements, ([id, range]) => ({ ...range, id })), [workingReplacements]);
  const threads: DocumentCommentThread[] = [
    ...(standingNotes ?? []).map(note => ({
      id: note.id, quote: note.quote, body: note.body, author: note.author,
      resolved: note.resolved, range: note.anchor.status === 'detached' ? null
        : toWorking({ start: note.anchor.start_offset, end: note.anchor.end_offset }),
    })),
    ...annotations.map(annotation => select(annotation,
      annotation.annotation_kind === 'suggest_replacement'
        ? workingReplacements.get(annotation.annotation_event_id) ?? null
        : toWorking({ start: annotation.start_offset, end: annotation.end_offset }),
      annotation.presentation?.source === 'current_draft')),
    ...(round.carried_annotations ?? []).map(annotation => select(annotation,
      annotation.anchor.status === 'detached' ? null
        : toWorking({ start: annotation.anchor.start_offset, end: annotation.anchor.end_offset }), false)),
  ];
  const decorations = threads.flatMap(thread => thread.range
    ? [{ ...thread.range, id: thread.id, className: workingReplacements.has(thread.id) ? 'suggestion-range' : 'review-range' }]
    : []);
  const selectionRange = selection && workingText.slice(selection.start, selection.end) === selection.quote ? selection : null;
  const selectedSource = selectionRange ? toSource(selectionRange) : null;

  const latestDirectives = useRef({ directives, toWorking });
  latestDirectives.current = { directives, toWorking };
  const directiveHosts = useRef(new Map<HTMLElement, string>());
  const directiveRefs = useRef(new Map<string, { view: MarkdownDocumentHandle; start: number; end: number }>()).current;
  const directiveRefCallbacks = useRef(new Map<string, (view: MarkdownDocumentHandle | null) => void>()).current;
  const [, setHostsRevision] = useState(0);
  const allowlist = useMemo(() => {
    const locate = (node: Parameters<MarkdownDirectiveRenderer>[0]) => {
      const { directives, toWorking } = latestDirectives.current;
      return directives.find(({ directive }) => {
        if (!directive || directive.key !== node.attributes.key) return false;
        const range = toWorking({ start: directive.start_offset, end: directive.end_offset });
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
    render.accepts = (node) => Boolean(locate(node));
    return new Map([['spec-item', render]]);
  }, []);

  if (!document) return null;
  return (
    <section className="briefing-document__content" aria-label="Briefing document">
      {dirty && status && <DetailPaneNotice severity="error" density="compact">{status}</DetailPaneNotice>}
      {currentDocument && !currentDocument.documentError && <DocumentCommentSurface
        controller={comments} documentRef={documentRef} readingMeasure="document" navigationKey={`${briefingId}:${roundId}`}
        threads={threads}
        position={range => {
          for (const { view, start, end } of directiveRefs.values()) {
            if (range.start >= start && range.end <= end) return view.bounds({ start: range.start - start, end: range.end - start });
          }
          return null;
        }}
        onNavigate={range => {
          for (const { view, start, end } of directiveRefs.values()) {
            if (range.start >= start && range.end <= end) {
              view.reveal({ start: range.start - start, end: range.end - start });
              return;
            }
          }
          documentRef.current?.reveal(range);
        }}
        selection={selectionRange && selectionRange.start < selectionRange.end && !editing ? {
          range: selectionRange,
          onEdit: maySuggest ? () => editSelection(selectionRange) : undefined,
          onComment: canInteract && selectedSource && !dirty ? async body => {
            const result = await mutate([{
              operation: 'set', annotation_kind: 'comment', body,
              start_offset: selectedSource.start, end_offset: selectedSource.end,
              quote: source.slice(selectedSource.start, selectedSource.end),
            }]);
            if (result?.annotation_event_ids[0]) comments.select(result.annotation_event_ids[0]);
            setSelection(null);
          } : undefined,
        } : null}>
        <MarkdownDocument value={workingText} documentRef={documentRef}
          comparison={showChanges ? currentComparison?.text : undefined}
          operatorComparison={workingText === source ? undefined : source} operatorAnnotations={operatorAnnotations}
          showSource={showSource} readOnly={!editing} ariaLabel="Pinned briefing document"
          directives={allowlist} previewPolicy={BRIEFING_MARKDOWN_PREVIEW} decorations={decorations}
          onChange={(text, edits) => {
            setWorking(previous => {
              const base = previous && previous.text !== persistedText ? previous : persisted;
              return { text, changes: base.changes.compose(suggestionEdits(base.text.length, edits)) };
            });
            setFailedWorking(null);
          }}
          onSelectionChange={setSelection} onDecorationClick={id => comments.select(id)}
          onChangePosition={onChangePosition} />
        {Array.from(directiveHosts.current, ([element, itemId]) => {
          const item = directives.find(directive => directive.id === itemId);
          if (!item?.directive) return null;
          const current = Object.hasOwn(draft, item.id) ? draft[item.id] ?? null : item.effective_response?.value ?? null;
          const responseKey = current && 'option_key' in current ? current.option_key : null;
          const variants = item.revision.variants ?? [];
          const body = variants.find(variant => variant.key === responseKey) ?? variants[0] ?? item.directive;
          const range = toWorking({ start: body.body_start_offset, end: body.body_end_offset });
          const refKey = JSON.stringify([itemId, range?.start, range?.end]);
          if (range && !directiveRefCallbacks.has(refKey)) {
            directiveRefCallbacks.set(refKey, view => {
              if (view) directiveRefs.set(refKey, { view, ...range });
              else {
                directiveRefs.delete(refKey);
                directiveRefCallbacks.delete(refKey);
              }
            });
          }
          return createPortal(
            <BriefingDirectiveControls key={`${itemId}:${draftIdentity ?? ''}`} item={{ ...item, directive: item.directive }}
              source={document.source} current={current} canInteract={canInteract && !editing}
              validationError={validationErrors[item.id]} documentRef={directiveRefCallbacks.get(refKey)}
              decorations={decorations.flatMap(decoration => {
                const range = toSource(decoration);
                return range ? [{ ...decoration, ...range }] : [];
              })}
              onDirectiveValue={onDirectiveValue} onSelect={range => {
                const mapped = toWorking(range);
                setSelection(mapped ? { ...mapped, quote: range.quote } : null);
              }} onDecorationClick={comments.select} />,
            element,
          );
        })}
      </DocumentCommentSurface>}
    </section>
  );
}
