import { useEffect, useMemo, useState } from 'preact/hooks';

import {
  getArtifactContent,
  postBriefingAnnotations,
  type BriefingAnnotation,
  type BriefingAnnotationOperation,
  type BriefingRoundProjection,
} from '../../api';
import { renderMarkdown } from '../../lib/markdown';

export type BriefingDocumentPanelProps = {
  briefingId: string;
  briefingTitle: string;
  roundId: string;
  round: BriefingRoundProjection;
  canMutate: boolean;
  onRefresh(): Promise<BriefingRoundProjection | null>;
  draft?: Record<string, { verdict: 'keep' | 'dismiss' } | null>;
  onDirectiveVerdict?(itemId: string, value: 'keep' | 'dismiss'): void;
  onContentGateChange?(reason: string): void;
};

type AnnotationEditor = {
  annotation: BriefingAnnotation | null;
  directiveItemId?: string;
  start: number;
  end: number;
  quote: string;
  top: number;
  left: number;
};

function annotationKindLabel(kind: BriefingAnnotation['annotation_kind']): string {
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
  const document = new DOMParser().parseFromString(renderMarkdown(value), 'text/html');
  document.querySelectorAll('img, picture, source').forEach((node) => node.remove());
  return document.body.innerHTML;
}

function semanticHeading(value: string): string {
  const document = new DOMParser().parseFromString(renderMarkdown(value), 'text/html');
  return (document.body.textContent ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function suppressRepeatedLeadingHeading(value: string, title: string): string {
  const atx = /^(?:[ \t]*\r?\n)*[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(value);
  if (atx && semanticHeading(atx[1]) === semanticHeading(title)) return value.slice(atx[0].length);
  const setext = /^(?:[ \t]*\r?\n)*([^\r\n]+)\r?\n[ \t]{0,3}(?:=+|-+)[ \t]*(?:\r?\n|$)/.exec(value);
  if (setext && semanticHeading(setext[1]) === semanticHeading(title)) return value.slice(setext[0].length);
  return value;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function BriefingDocumentPanel({ briefingId, briefingTitle, roundId, round, canMutate, onRefresh, draft = {}, onDirectiveVerdict, onContentGateChange }: BriefingDocumentPanelProps): JSX.Element | null {
  const document = round.document;
  const [source, setSource] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [editor, setEditor] = useState<AnnotationEditor | null>(null);
  const [kind, setKind] = useState<BriefingAnnotation['annotation_kind']>('comment');
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [selectedDirectiveId, setSelectedDirectiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!document) return undefined;
    const controller = new AbortController();
    setSource(null);
    setContentError(null);
    onContentGateChange?.('Loading pinned document…');
    void getArtifactContent(document.artifact_version_id, { signal: controller.signal })
      .then((content) => {
        if (content.status !== 'available' || !content.preview) {
          throw new Error(content.reason || 'The pinned document content is unavailable.');
        }
        if (content.preview.truncated) {
          throw new Error('The pinned document content was truncated and cannot be annotated safely.');
        }
        const next = content.preview.raw_text ?? content.preview.text;
        if (new TextEncoder().encode(next).byteLength !== content.size_bytes) throw new Error('The pinned document content is incomplete.');
        setSource(next);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setContentError(error instanceof Error ? error.message : String(error));
        onContentGateChange?.(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [document?.artifact_version_id, onContentGateChange]);

  const annotations = round.annotations ?? [];
  const directiveItems = useMemo(() => round.items
    .filter((item) => item.directive)
    .sort((left, right) => left.directive!.start_offset - right.directive!.start_offset), [round.items]);
  const documentIntegrityError = useMemo(() => {
    if (source === null) return null;
    let cursor = 0;
    for (const item of directiveItems) {
      const directive = item.directive!;
      if (directive.start_offset < cursor || directive.end_offset > source.length
          || directive.body_start_offset < directive.start_offset || directive.body_end_offset > directive.end_offset
          || directive.body_start_offset >= directive.body_end_offset) return 'The pinned directive ranges are inconsistent.';
      cursor = directive.end_offset;
    }
    return directiveItems.length === 0 ? 'The pinned document has no valid response directives.' : null;
  }, [directiveItems, source]);
  useEffect(() => {
    let cancelled = false;
    if (source === null) return undefined;
    if (documentIntegrityError) { onContentGateChange?.(documentIntegrityError); return undefined; }
    onContentGateChange?.('Verifying pinned document…');
    void Promise.all(directiveItems.map(async (item) => {
      const directive = item.directive!;
      const body = source.slice(directive.body_start_offset, directive.body_end_offset);
      if (body !== item.revision.prompt) throw new Error('Pinned directive text does not match its materialized prompt.');
      if (await sha256(source.slice(directive.start_offset, directive.end_offset)) !== directive.definition_digest) throw new Error('Pinned directive content does not match its binding.');
    })).then(() => { if (!cancelled) onContentGateChange?.(''); })
      .catch((error) => { if (!cancelled) onContentGateChange?.(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [directiveItems, documentIntegrityError, onContentGateChange, source]);

  if (!document) return null;

  const openEditor = (next: AnnotationEditor) => {
    setEditor(next);
    setKind(next.annotation?.annotation_kind ?? 'comment');
    setBody(next.annotation?.body ?? '');
    setReplacement(next.annotation?.replacement_text ?? next.quote);
    setStatus(null);
  };

  const openExisting = (annotation: BriefingAnnotation) => openEditor({
    annotation,
    start: annotation.start_offset,
    end: annotation.end_offset,
    quote: annotation.quote,
    top: 96,
    left: 24,
  });

  const openDirectiveComment = (itemId: string) => {
    const item = round.items.find((candidate) => candidate.id === itemId);
    const directive = item?.directive;
    if (!item || !directive || source === null) return;
    const quote = source.slice(directive.body_start_offset, directive.body_end_offset);
    openEditor({ annotation: null, directiveItemId: itemId, start: directive.body_start_offset, end: directive.body_end_offset, quote, top: 96, left: 24 });
  };

  const inlineAnnotations = (start: number, end: number) => {
    const matches = annotations.filter((annotation) => annotation.start_offset < end && annotation.end_offset > start);
    return matches.length > 0 ? (
      <div className="briefing-document__inline-annotations" aria-label="Annotations for this passage">
        {matches.map((annotation) => (
          <button type="button" key={annotation.annotation_event_id} onClick={() => openExisting(annotation)}>
            <strong>“{excerpt(annotation.quote)}”</strong>
            <span>{annotationKindLabel(annotation.annotation_kind)}{annotation.body ? ` · ${excerpt(annotation.body, 80)}` : ''}</span>
          </button>
        ))}
      </div>
    ) : null;
  };

  const renderProfileDocument = () => {
    if (source === null || documentIntegrityError) return null;
    const parts: JSX.Element[] = [];
    let cursor = 0;
    for (const item of directiveItems) {
      const directive = item.directive!;
      const authoritativeProse = source.slice(cursor, directive.start_offset);
      const prose = cursor === 0 ? suppressRepeatedLeadingHeading(authoritativeProse, briefingTitle) : authoritativeProse;
      if (prose.trim() || annotations.some((annotation) => annotation.start_offset < directive.start_offset && annotation.end_offset > cursor)) parts.push(
        <div key={`prose-${parts.length}`} className="briefing-document__passage">
          <div className="briefing-document__prose" dangerouslySetInnerHTML={{ __html: renderBriefingProse(prose) }} />
          {inlineAnnotations(cursor, directive.start_offset)}
        </div>,
      );
      const body = source.slice(directive.body_start_offset, directive.body_end_offset);
      const current = draft[item.id] ?? (item.effective_response?.value && 'verdict' in item.effective_response.value ? item.effective_response.value : null);
      parts.push(
        <section className={`briefing-directive${current || selectedDirectiveId === item.id ? ' briefing-directive--selected' : ''}`} key={item.id} tabIndex={0}
          onClick={() => setSelectedDirectiveId(item.id)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedDirectiveId((currentId) => currentId === item.id ? null : item.id); } }}>
          <div className="briefing-directive__interaction">
            <div className="briefing-directive__passage">
              <div className="briefing-directive__body" dangerouslySetInnerHTML={{ __html: renderBriefingProse(body) }} />
              {inlineAnnotations(directive.start_offset, directive.end_offset)}
            </div>
            <div className="briefing-directive__actions" aria-label={`Response controls for ${item.revision.title || directive.key}`}>
              <button type="button" aria-label="Keep" title="Keep" aria-pressed={current?.verdict === 'keep'} disabled={!canMutate} onClick={() => onDirectiveVerdict?.(item.id, 'keep')}><CheckIcon /></button>
              <button type="button" aria-label="Dismiss" title="Dismiss" aria-pressed={current?.verdict === 'dismiss'} disabled={!canMutate} onClick={() => onDirectiveVerdict?.(item.id, 'dismiss')}><DismissIcon /></button>
              <button type="button" aria-label="Comment" title="Comment" aria-expanded={editor?.directiveItemId === item.id} disabled={!canMutate} onClick={() => openDirectiveComment(item.id)}><CommentIcon /></button>
            </div>
          </div>
        </section>,
      );
      cursor = directive.end_offset;
    }
    const tail = source.slice(cursor);
    if (tail.trim() || annotations.some((annotation) => annotation.start_offset < source.length && annotation.end_offset > cursor)) parts.push(
      <div key={`prose-${parts.length}`} className="briefing-document__passage">
        <div className="briefing-document__prose" dangerouslySetInnerHTML={{ __html: renderBriefingProse(tail) }} />
        {inlineAnnotations(cursor, source.length)}
      </div>,
    );
    return <div className="briefing-document__rendered" aria-label="Pinned briefing document">{parts}</div>;
  };

  const mutate = async (operations: BriefingAnnotationOperation[], success: string) => {
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
    const setOperation: BriefingAnnotationOperation = kind === 'comment'
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
    const operations: BriefingAnnotationOperation[] = editor.annotation
      ? [{ operation: 'retract', annotation_event_id: editor.annotation.annotation_event_id }, setOperation]
      : [setOperation];
    await mutate(operations, editor.annotation ? 'Annotation updated.' : 'Annotation saved.');
  };

  const remove = async (annotation: BriefingAnnotation) => {
    if (!canMutate) return;
    await mutate(
      [{ operation: 'retract', annotation_event_id: annotation.annotation_event_id }],
      'Annotation deleted.',
    );
  };

  return (
    <section className="briefing-document__content" aria-label="Briefing document">
      {contentError ? <p className="briefing-error" role="alert">{contentError}</p> : null}
      {round.directive_binding?.status !== 'valid' ? <p className="briefing-error" role="alert">{round.directive_binding?.reason || 'The pinned directive binding is unavailable.'}</p> : null}
      {documentIntegrityError ? <p className="briefing-error" role="alert">{documentIntegrityError}</p> : null}
      {source === null && !contentError ? <p className="briefing-empty" role="status">Loading document…</p> : null}
      {renderProfileDocument()}

      {editor ? (
        <div
          className="briefing-document__popover"
          role="dialog"
          aria-modal="false"
          aria-label={editor.annotation ? 'Edit annotation' : 'Add annotation'}
          style={{ position: 'fixed', top: `${Math.max(8, editor.top + 40)}px`, left: `${Math.max(8, editor.left)}px` }}
        >
          <div className="briefing-document__popover-header">
            <strong>{editor.annotation ? 'Edit annotation' : 'Add annotation'}</strong>
            <button type="button" aria-label="Close annotation editor" onClick={() => setEditor(null)}>×</button>
          </div>
          <blockquote>{editor.quote}</blockquote>
          <div className="briefing-document__tabs" role="tablist" aria-label="Annotation type">
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
          <div className="briefing-document__popover-actions">
            {editor.annotation && canMutate ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void remove(editor.annotation!)} disabled={busy}>Delete</button>
            ) : null}
            {canMutate ? <button type="button" className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>Save</button> : null}
          </div>
        </div>
      ) : null}

      <div className="briefing-document__status" role="status" aria-live="polite">{status}</div>
    </section>
  );
}

function CheckIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m3 8.5 3 3 7-7" /></svg>;
}

function DismissIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg>;
}

function CommentIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 3.5h10v7H7l-3.5 2.5v-2.5H3z" /></svg>;
}

export default BriefingDocumentPanel;
