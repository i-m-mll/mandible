import { useEffect, useMemo, useState } from 'preact/hooks';

import {
  getArtifactContent,
  postAskAnnotations,
  type AskAnnotation,
  type AskAnnotationOperation,
  type AskProjection,
} from '../../api';
import { renderMarkdown } from '../../lib/markdown';
import {
  MarkdownSourceEditor,
  type MarkdownSourceSelection,
} from '../spaces/MarkdownSourceEditor';

export type AskDocumentPanelProps = {
  ask: AskProjection;
  canMutate: boolean;
  onRefresh(): Promise<AskProjection | null>;
  draft?: Record<string, { verdict: 'keep' | 'dismiss' } | null>;
  onDirectiveVerdict?(itemId: string, value: 'keep' | 'dismiss'): void;
};

type AnnotationEditor = {
  annotation: AskAnnotation | null;
  start: number;
  end: number;
  quote: string;
  top: number;
  left: number;
};

function annotationKindLabel(kind: AskAnnotation['annotation_kind']): string {
  return kind === 'comment' ? 'Comment' : 'Suggested replacement';
}

function excerpt(value: string, limit = 140): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

// Briefing documents are prose-only. `renderMarkdown` remains the sanitizer
// boundary, while this narrow prefilter deliberately omits image syntax rather
// than treating a sanitized image as an allowed document capability.
function renderBriefingProse(value: string): string {
  return renderMarkdown(value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, ''));
}

export function AskDocumentPanel({ ask, canMutate, onRefresh, draft = {}, onDirectiveVerdict }: AskDocumentPanelProps): JSX.Element | null {
  const document = ask.document;
  const [source, setSource] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [selection, setSelection] = useState<MarkdownSourceSelection | null>(null);
  const [editor, setEditor] = useState<AnnotationEditor | null>(null);
  const [kind, setKind] = useState<AskAnnotation['annotation_kind']>('comment');
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!document) return undefined;
    const controller = new AbortController();
    setSource(null);
    setContentError(null);
    void getArtifactContent(document.artifact_version_id, { signal: controller.signal })
      .then((content) => {
        if (content.status !== 'available' || !content.preview) {
          throw new Error(content.reason || 'The pinned document content is unavailable.');
        }
        if (content.preview.truncated) {
          throw new Error('The pinned document content was truncated and cannot be annotated safely.');
        }
        setSource(content.preview.raw_text ?? content.preview.text);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setContentError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [document?.artifact_version_id]);

  const annotations = ask.annotations ?? [];
  const profile = document?.profile === 'mandible-briefing.v1';
  const directiveItems = useMemo(() => ask.items
    .filter((item) => item.directive)
    .sort((left, right) => left.directive!.start_offset - right.directive!.start_offset), [ask.items]);
  const documentIntegrityError = useMemo(() => {
    if (!profile || source === null) return null;
    let cursor = 0;
    for (const item of directiveItems) {
      const directive = item.directive!;
      if (directive.start_offset < cursor || directive.end_offset > source.length
          || directive.body_start_offset < directive.start_offset || directive.body_end_offset > directive.end_offset
          || directive.body_start_offset >= directive.body_end_offset) return 'The pinned directive ranges are inconsistent; this document is read-only.';
      cursor = directive.end_offset;
    }
    return directiveItems.length === 0 ? 'The pinned document has no valid response directives.' : null;
  }, [directiveItems, profile, source]);
  const decorations = useMemo(() => annotations.map((annotation) => ({
    id: annotation.annotation_event_id,
    start: annotation.start_offset,
    end: annotation.end_offset,
    className: `ask-annotation${annotation.annotation_kind === 'suggest_replacement' ? ' ask-annotation--suggestion' : ''}`,
  })), [annotations]);

  if (!document) return null;

  const openEditor = (next: AnnotationEditor) => {
    setEditor(next);
    setKind(next.annotation?.annotation_kind ?? 'comment');
    setBody(next.annotation?.body ?? '');
    setReplacement(next.annotation?.replacement_text ?? next.quote);
    setStatus(null);
  };

  const openExisting = (annotation: AskAnnotation) => openEditor({
    annotation,
    start: annotation.start_offset,
    end: annotation.end_offset,
    quote: annotation.quote,
    top: 96,
    left: 24,
  });

  const openDirectiveComment = (itemId: string) => {
    const item = ask.items.find((candidate) => candidate.id === itemId);
    const directive = item?.directive;
    if (!item || !directive || source === null) return;
    const quote = source.slice(directive.body_start_offset, directive.body_end_offset);
    openEditor({ annotation: null, start: directive.body_start_offset, end: directive.body_end_offset, quote, top: 96, left: 24 });
  };

  const renderProfileDocument = () => {
    if (source === null || documentIntegrityError) return null;
    const parts: JSX.Element[] = [];
    let cursor = 0;
    for (const item of directiveItems) {
      const directive = item.directive!;
      const prose = source.slice(cursor, directive.start_offset);
      if (prose.trim()) parts.push(<div className="ask-document__prose" dangerouslySetInnerHTML={{ __html: renderBriefingProse(prose) }} />);
      const body = source.slice(directive.body_start_offset, directive.body_end_offset);
      const current = draft[item.id] ?? (item.effective_response?.value && 'verdict' in item.effective_response.value ? item.effective_response.value : null);
      parts.push(
        <section className={`briefing-directive${current ? ' briefing-directive--selected' : ''}`} key={item.id} tabIndex={0} onClick={() => undefined}>
          <div className="briefing-directive__body" dangerouslySetInnerHTML={{ __html: renderBriefingProse(body) }} />
          <div className="briefing-directive__actions" aria-label={`Response controls for ${item.revision.title || directive.key}`}>
            <button type="button" aria-pressed={current?.verdict === 'keep'} disabled={!canMutate} onClick={() => onDirectiveVerdict?.(item.id, 'keep')}>Keep</button>
            <button type="button" aria-pressed={current?.verdict === 'dismiss'} disabled={!canMutate} onClick={() => onDirectiveVerdict?.(item.id, 'dismiss')}>Dismiss</button>
            <button type="button" disabled={!canMutate} onClick={() => openDirectiveComment(item.id)}>Comment</button>
          </div>
        </section>,
      );
      cursor = directive.end_offset;
    }
    const tail = source.slice(cursor);
    if (tail.trim()) parts.push(<div className="ask-document__prose" dangerouslySetInnerHTML={{ __html: renderBriefingProse(tail) }} />);
    return <div className="ask-document__rendered" aria-label="Pinned briefing document">{parts}</div>;
  };

  const mutate = async (operations: AskAnnotationOperation[], success: string) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await postAskAnnotations(ask.ask_id, operations);
      if (result.annotation_event_ids.length !== operations.length) {
        throw new Error('The annotation service returned an ambiguous event result.');
      }
      await onRefresh();
      setEditor(null);
      setSelection(null);
      setStatus(success);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editor || !canMutate) return;
    const setOperation: AskAnnotationOperation = kind === 'comment'
      ? {
        operation: 'set',
        annotation_kind: 'comment',
        start_offset: editor.start,
        end_offset: editor.end,
        quote: editor.quote,
        body: body.trim(),
      }
      : {
        operation: 'set',
        annotation_kind: 'suggest_replacement',
        start_offset: editor.start,
        end_offset: editor.end,
        quote: editor.quote,
        replacement_text: replacement,
        ...(body.trim() ? { body: body.trim() } : {}),
      };
    if (kind === 'comment' && !body.trim()) {
      setStatus('Comment text is required.');
      return;
    }
    const operations: AskAnnotationOperation[] = editor.annotation
      ? [{ operation: 'retract', annotation_event_id: editor.annotation.annotation_event_id }, setOperation]
      : [setOperation];
    await mutate(operations, editor.annotation ? 'Annotation updated.' : 'Annotation saved.');
  };

  const remove = async (annotation: AskAnnotation) => {
    if (!canMutate) return;
    await mutate(
      [{ operation: 'retract', annotation_event_id: annotation.annotation_event_id }],
      'Annotation deleted.',
    );
  };

  return (
    <section className="ask-document" aria-labelledby="ask-document-title">
      <header className="ask-document__header">
        <div>
          <span className="briefing-eyebrow">Pinned document</span>
          <h3 id="ask-document-title">Review source</h3>
        </div>
        <code>{document.artifact_version_id}</code>
      </header>

      {contentError ? <p className="briefing-error" role="alert">{contentError}</p> : null}
      {profile && ask.directive_binding?.status !== 'valid' ? <p className="briefing-error" role="alert">{ask.directive_binding?.reason || 'The directive binding is unavailable; this document is read-only.'}</p> : null}
      {documentIntegrityError ? <p className="briefing-error" role="alert">{documentIntegrityError}</p> : null}
      {source === null && !contentError ? <p className="briefing-empty" role="status">Loading document…</p> : null}
      {profile ? renderProfileDocument() : null}
      {source !== null && !profile ? (
        <div className="ask-document__source">
          <MarkdownSourceEditor
            blockId={`ask-document:${ask.ask_id}`}
            value={source}
            ariaLabel="Pinned briefing document source"
            readOnly
            decorations={decorations}
            onDecorationClick={(id) => {
              const annotation = annotations.find((entry) => entry.annotation_event_id === id);
              if (annotation) openExisting(annotation);
            }}
            onChange={() => undefined}
            onBlur={() => undefined}
            onCaretChange={() => undefined}
            onSelectionChange={(nextSelection) => setSelection(canMutate ? nextSelection : null)}
            onItemCommand={() => undefined}
            onOpenReference={() => undefined}
            onBoundaryArrow={() => false}
          />
        </div>
      ) : null}

      {!profile && selection && source !== null && canMutate ? (
        <div
          className="ask-document__selection-toolbar"
          role="toolbar"
          aria-label="Document annotation"
          style={{ position: 'fixed', top: `${selection.top}px`, left: `${selection.left}px` }}
        >
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openEditor({
              annotation: null,
              start: selection.start,
              end: selection.end,
              quote: source.slice(selection.start, selection.end),
              top: selection.top,
              left: selection.left,
            })}
          >
            Annotate
          </button>
        </div>
      ) : null}

      {editor ? (
        <div
          className="ask-document__popover"
          role="dialog"
          aria-modal="false"
          aria-label={editor.annotation ? 'Edit annotation' : 'Add annotation'}
          style={{ position: 'fixed', top: `${Math.max(8, editor.top + 40)}px`, left: `${Math.max(8, editor.left)}px` }}
        >
          <div className="ask-document__popover-header">
            <strong>{editor.annotation ? 'Edit annotation' : 'Annotate selection'}</strong>
            <button type="button" aria-label="Close annotation editor" onClick={() => setEditor(null)}>×</button>
          </div>
          <blockquote>{editor.quote}</blockquote>
          <div className="ask-document__tabs" role="tablist" aria-label="Annotation type">
            <button type="button" role="tab" aria-selected={kind === 'comment'} onClick={() => setKind('comment')}>Comment</button>
            <button type="button" role="tab" aria-selected={kind === 'suggest_replacement'} onClick={() => setKind('suggest_replacement')}>Suggest replacement</button>
          </div>
          {kind === 'suggest_replacement' ? (
            <label>
              Replacement
              <textarea value={replacement} onInput={(event) => setReplacement(event.currentTarget.value)} disabled={!canMutate || busy} />
            </label>
          ) : null}
          <label>
            {kind === 'comment' ? 'Comment' : 'Note (optional)'}
            <textarea value={body} onInput={(event) => setBody(event.currentTarget.value)} disabled={!canMutate || busy} />
          </label>
          <div className="ask-document__popover-actions">
            {editor.annotation && canMutate ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void remove(editor.annotation!)} disabled={busy}>Delete</button>
            ) : null}
            {canMutate ? <button type="button" className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>Save</button> : null}
          </div>
        </div>
      ) : null}

      {profile && source !== null ? (
        <details className="ask-document__source-disclosure">
          <summary>Source and existing annotations</summary>
          <div className="ask-document__source"><MarkdownSourceEditor blockId={`ask-document:${ask.ask_id}`} value={source} ariaLabel="Pinned briefing document source" readOnly decorations={decorations} onDecorationClick={(id) => { const annotation = annotations.find((entry) => entry.annotation_event_id === id); if (annotation) openExisting(annotation); }} onChange={() => undefined} onBlur={() => undefined} onCaretChange={() => undefined} onSelectionChange={() => undefined} onItemCommand={() => undefined} onOpenReference={() => undefined} onBoundaryArrow={() => false} /></div>
        </details>
      ) : null}
      {annotations.length > 0 ? (
        <section className="ask-document__annotations" aria-labelledby="ask-annotations-title">
          <h4 id="ask-annotations-title">Annotations</h4>
          <ul>
            {annotations.map((annotation) => (
              <li key={annotation.annotation_event_id}>
                <button type="button" className="ask-document__annotation-row" onClick={() => openExisting(annotation)}>
                  <strong>“{excerpt(annotation.quote)}”</strong>
                  <span>{annotationKindLabel(annotation.annotation_kind)}</span>
                  {annotation.replacement_text !== null ? <span>Replace with “{excerpt(annotation.replacement_text)}”</span> : null}
                  {annotation.body ? <span>{annotation.body}</span> : null}
                </button>
                {canMutate ? (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void remove(annotation)} disabled={busy}>
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ask.previous_round ? (
        <details className="ask-document__history">
          <summary>Round history</summary>
          {ask.previous_round.annotations.length > 0 ? (
            <ul>
              {ask.previous_round.annotations.map((annotation) => (
                <li key={`${annotation.annotation_event_id}:${annotation.submission_ordinal}`}>
                  <a href={`/#/briefing?ask=${encodeURIComponent(ask.previous_round!.ask_id)}`}>
                    <strong>“{excerpt(annotation.quote)}”</strong>
                    <span>{annotationKindLabel(annotation.annotation_kind)}</span>
                    {annotation.replacement_text !== null ? <span>Replace with “{excerpt(annotation.replacement_text)}”</span> : null}
                    {annotation.body ? <span>{annotation.body}</span> : null}
                    <small>Responder {annotation.actor_user_id} · submission {annotation.submission_ordinal}</small>
                  </a>
                </li>
              ))}
            </ul>
          ) : <p className="briefing-empty">No frozen annotations in the previous round.</p>}
        </details>
      ) : null}

      <div className="ask-document__status" role="status" aria-live="polite">{status}</div>
    </section>
  );
}

export default AskDocumentPanel;
