import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  postBriefingAnnotations,
  type BriefingAnnotation,
  type BriefingAnnotationOperation,
  type BriefingDirectiveItem,
  type BriefingResponseValue,
  type BriefingRoundProjection,
} from '../../api';
import { renderMarkdown } from '../../lib/markdown';
import { ContextualAction } from '../../components/shared/ContextualAction';

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
};

type AnnotationEditor = {
  annotation: BriefingAnnotation | null;
  directiveItemId?: string;
  sectionHeading?: string;
  start: number;
  end: number;
  quote: string;
  top: number;
  left: number;
};

export type MarkdownHeadingSection = {
  level: number;
  label: string;
  headingStart: number;
  headingEnd: number;
  sectionEnd: number;
};

type MarkdownHeading = Omit<MarkdownHeadingSection, 'sectionEnd'>;

export function findMarkdownHeadingSections(source: string): MarkdownHeadingSection[] {
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const headings: MarkdownHeading[] = [];
  let offset = 0;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let previous: { start: number; end: number; text: string; eligible: boolean } | null = null;
  for (const line of lines) {
    const start = offset;
    offset += line.length;
    const text = line.replace(/\r?\n$/, '');
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length
          && new RegExp(`^[ \\t]{0,3}\\${marker}{${fence.length},}[ \\t]*$`).test(text)) fence = null;
      previous = null;
      continue;
    }
    if (fence) {
      previous = null;
      continue;
    }
    const atx = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*#*[ \t]*|[ \t]*)$/.exec(text);
    if (atx) {
      headings.push({ level: atx[1].length, label: (atx[2] ?? '').trim(), headingStart: start, headingEnd: offset });
      previous = null;
      continue;
    }
    const setext = /^[ \t]{0,3}(=+|-+)[ \t]*$/.exec(text);
    if (setext && previous?.eligible) {
      headings.push({ level: setext[1][0] === '=' ? 1 : 2, label: previous.text.trim(), headingStart: previous.start, headingEnd: offset });
      previous = null;
      continue;
    }
    previous = {
      start,
      end: offset,
      text,
      eligible: Boolean(text.trim()) && !/^[ \t]{4}/.test(text),
    };
  }
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    return { ...heading, sectionEnd: next?.headingStart ?? source.length };
  });
}

// Radio `name` groups are document-global rather than component-local. A
// stable mount token prevents another live renderer of the same round from
// letting the browser overwrite this panel's controlled checked properties.
let radioGroupSequence = 0;

const DIRECTIVE_INTERACTIVE_SELECTOR = [
  'a[href]',
  'area[href]',
  'audio[controls]',
  'button',
  'embed',
  'iframe',
  'input',
  'label',
  'object',
  'select',
  'summary',
  'textarea',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',
].join(',');

function isInteractiveDirectiveTarget(target: EventTarget | null, directive: HTMLElement): boolean {
  if (!(target instanceof Element) || target === directive) return false;
  const interactive = target.closest(DIRECTIVE_INTERACTIVE_SELECTOR);
  return interactive !== null && interactive !== directive && directive.contains(interactive);
}

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

export function BriefingDocumentPanel({ briefingId, briefingTitle, roundId, round, canMutate, draftIdentity = null, onRefresh, draft = {}, validationErrors = {}, onDirectiveValue, onContentGateChange }: BriefingDocumentPanelProps): JSX.Element | null {
  const document = round.document;
  const documentKey = document
    ? `${document.artifact_version_id}\u0000${document.content_hash}\u0000${document.source}`
    : null;
  const [radioGroupScope] = useState(() => `briefing-radio-${++radioGroupSequence}`);
  const [verifiedDocumentKey, setVerifiedDocumentKey] = useState<string | null>(null);
  const [verifiedBindingKey, setVerifiedBindingKey] = useState<string | null>(null);
  const [contentError, setContentError] = useState<{ key: string; message: string } | null>(null);
  const [editor, setEditor] = useState<AnnotationEditor | null>(null);
  const [kind, setKind] = useState<BriefingAnnotation['annotation_kind']>('comment');
  const [body, setBody] = useState('');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [selectedDirectiveId, setSelectedDirectiveId] = useState<string | null>(null);
  const [textEdits, setTextEdits] = useState<Record<string, string>>({});
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setTextEdits({});
  }, [briefingId, roundId, document?.artifact_version_id, draftIdentity]);

  useEffect(() => {
    setSelectedDirectiveId(null);
  }, [briefingId, roundId, document?.artifact_version_id]);

  useEffect(() => {
    const dismissSelection = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const directive = event.target.closest('.briefing-directive');
      if (directive && contentRef.current?.contains(directive)) return;
      setSelectedDirectiveId(null);
    };
    globalThis.document.addEventListener('click', dismissSelection);
    return () => globalThis.document.removeEventListener('click', dismissSelection);
  }, []);

  useEffect(() => {
    if (!document) return undefined;
    let cancelled = false;
    setVerifiedDocumentKey(null);
    setVerifiedBindingKey(null);
    setContentError(null);
    onContentGateChange?.('Verifying exact pinned document…');
    void sha256(document.source)
      .then((digest) => {
        if (digest !== document.content_hash) throw new Error('The pinned document content does not match its verified hash.');
        if (!cancelled) setVerifiedDocumentKey(documentKey);
      })
      .catch((error) => {
        if (cancelled || !documentKey) return;
        const message = error instanceof Error ? error.message : String(error);
        setContentError({ key: documentKey, message });
        onContentGateChange?.(message);
      });
    return () => { cancelled = true; };
  }, [documentKey, onContentGateChange]);

  const source = documentKey && verifiedDocumentKey === documentKey ? document?.source ?? null : null;
  const currentContentError = documentKey && contentError?.key === documentKey ? contentError.message : null;
  const headingSections = useMemo(() => source === null ? [] : findMarkdownHeadingSections(source), [source]);

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
      if (item.revision.response_type === 'text_variant') {
        const variants = item.revision.variants ?? [];
        if (variants.some((variant) => variant.start_offset < directive.body_start_offset
            || variant.end_offset > directive.body_end_offset
            || source.slice(variant.body_start_offset, variant.body_end_offset) !== variant.body)) {
          return 'The pinned text-variant ranges are inconsistent.';
        }
      }
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
      if (item.revision.response_type !== 'text_variant' && body !== item.revision.prompt) throw new Error('Pinned directive text does not match its materialized prompt.');
      if (await sha256(source.slice(directive.start_offset, directive.end_offset)) !== directive.definition_digest) throw new Error('Pinned directive content does not match its binding.');
    })).then(() => {
      if (!cancelled) {
        setVerifiedBindingKey(documentKey);
        onContentGateChange?.('');
      }
    })
      .catch((error) => { if (!cancelled) onContentGateChange?.(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [directiveItems, documentIntegrityError, documentKey, onContentGateChange, source]);

  if (!document) return null;
  const canInteract = canMutate && verifiedBindingKey === documentKey;

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

  const openSectionComment = (section: MarkdownHeadingSection) => {
    if (source === null) return;
    openEditor({
      annotation: null,
      sectionHeading: section.label,
      start: section.headingStart,
      end: section.sectionEnd,
      quote: source.slice(section.headingStart, section.sectionEnd),
      top: 96,
      left: 24,
    });
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

  const responseControls = (item: BriefingDirectiveItem, current: BriefingResponseValue | null, promptId: string) => {
    const type = item.revision.response_type;
    const controlId = `briefing-directive-${item.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const errorId = `${controlId}-error`;
    const error = validationErrors[item.id];
    const describedBy = error ? errorId : undefined;
    const clear = current ? (
      <button type="button" className="briefing-directive__clear" aria-describedby={promptId} disabled={!canInteract} onClick={() => {
        setTextEdits((edits) => ({ ...edits, [item.id]: '' }));
        onDirectiveValue?.(item.id, null);
      }}>Clear answer</button>
    ) : null;
    let control: JSX.Element | null = null;
    if (type === 'verdict') {
      const verdict = current && 'verdict' in current ? current.verdict : null;
      control = (
        <div id={controlId} className="briefing-directive__verdict" role="group" aria-labelledby={promptId} aria-describedby={describedBy}>
          <button type="button" aria-label="Keep" title="Keep" aria-pressed={verdict === 'keep'} disabled={!canInteract} onClick={() => onDirectiveValue?.(item.id, { verdict: 'keep' })}><CheckIcon /></button>
          <button type="button" aria-label="Dismiss" title="Dismiss" aria-pressed={verdict === 'dismiss'} disabled={!canInteract} onClick={() => onDirectiveValue?.(item.id, { verdict: 'dismiss' })}><DismissIcon /></button>
        </div>
      );
    } else if (type === 'single_choice' || type === 'multi_choice') {
      const selected = type === 'single_choice'
        ? new Set(current && 'option_key' in current ? [current.option_key] : [])
        : new Set(current && 'option_keys' in current ? current.option_keys : []);
      control = (
        <fieldset id={controlId} className="briefing-directive__choices" aria-labelledby={promptId} aria-invalid={Boolean(error)} aria-describedby={describedBy}>
          <legend className="sr-only">{type === 'single_choice' ? 'Choose one answer' : 'Choose one or more answers'}</legend>
          {item.revision.options.map((option) => (
            <label key={option.key}>
              <input
                type={type === 'single_choice' ? 'radio' : 'checkbox'}
                name={type === 'single_choice' ? `${radioGroupScope}-${controlId}-choice` : undefined}
                value={option.key}
                checked={selected.has(option.key)}
                disabled={!canInteract}
                onInput={() => {
                  if (type === 'single_choice') onDirectiveValue?.(item.id, { option_key: option.key });
                  else {
                    const next = new Set(selected);
                    if (next.has(option.key)) next.delete(option.key); else next.add(option.key);
                    const optionKeys = item.revision.options.map((candidate) => candidate.key).filter((key) => next.has(key));
                    onDirectiveValue?.(item.id, optionKeys.length > 0 ? { option_keys: optionKeys } : null);
                  }
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      );
    } else if (type === 'short_text' || type === 'long_text') {
      const text = Object.prototype.hasOwnProperty.call(textEdits, item.id)
        ? textEdits[item.id]
        : current && 'text' in current ? current.text : '';
      const shared = {
        id: controlId,
        value: text,
        maxLength: type === 'short_text' ? 240 : 4000,
        disabled: !canInteract,
        'aria-labelledby': promptId,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy,
        onInput: (event: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
          const value = event.currentTarget.value;
          setTextEdits((edits) => ({ ...edits, [item.id]: value }));
          onDirectiveValue?.(item.id, value.trim() ? { text: value } : null);
        },
      };
      control = type === 'short_text' ? <input className="briefing-directive__text" type="text" {...shared} /> : <textarea className="briefing-directive__text" rows={4} {...shared} />;
    } else if (type === 'rating') {
      const rating = current && 'rating' in current ? current.rating : null;
      control = (
        <fieldset id={controlId} className="briefing-directive__rating" aria-labelledby={promptId} aria-invalid={Boolean(error)} aria-describedby={describedBy}>
          <legend className="sr-only">Rating from 1 to 5</legend>
          {[1, 2, 3, 4, 5].map((value) => (
            <label key={value}><input type="radio" name={`${radioGroupScope}-${controlId}-rating`} value={value} checked={rating === value} disabled={!canInteract} onClick={() => onDirectiveValue?.(item.id, { rating: value })} /><span>{value}</span></label>
          ))}
        </fieldset>
      );
    } else if (type === 'text_variant') {
      const variants = item.revision.variants ?? [];
      const selectedKey = current && 'option_key' in current ? current.option_key : null;
      const selectedIndex = Math.max(0, variants.findIndex((variant) => variant.key === selectedKey));
      const selectedVariant = variants[selectedIndex];
      control = selectedVariant ? (
        <div id={controlId} className="briefing-directive__variant-controls" role="group" aria-labelledby={promptId} aria-describedby={describedBy}>
          <button type="button" aria-label="Previous text variant" disabled={!canInteract || selectedIndex === 0}
            onClick={() => onDirectiveValue?.(item.id, { option_key: variants[selectedIndex - 1].key })}><PreviousIcon /></button>
          <span><strong>{selectedVariant.label}</strong><small>{selectedIndex + 1} of {variants.length}</small></span>
          <button type="button" aria-label="Next text variant" disabled={!canInteract || selectedIndex === variants.length - 1}
            onClick={() => onDirectiveValue?.(item.id, { option_key: variants[selectedIndex + 1].key })}><NextIcon /></button>
        </div>
      ) : null;
    }
    return (
      <div className="briefing-directive__response">
        {control}
        {clear}
        {error ? <span id={errorId} className="briefing-directive__error" role="alert" aria-describedby={promptId}>{error}</span> : null}
      </div>
    );
  };

  const renderProseRange = (start: number, end: number, first: boolean): JSX.Element[] => {
    if (source === null || start >= end) return [];
    const hiddenLeadingLength = first ? source.length - suppressRepeatedLeadingHeading(source, briefingTitle).length : 0;
    const visibleStart = Math.max(start, hiddenLeadingLength);
    const parts: JSX.Element[] = [];
    let cursor = visibleStart;
    const pushProse = (from: number, to: number) => {
      if (from >= to) return;
      const prose = source.slice(from, to);
      if (!prose.trim() && !annotations.some((annotation) => annotation.start_offset < to && annotation.end_offset > from)) return;
      parts.push(
        <div key={`prose-${from}-${to}`} className="briefing-document__passage">
          <div className="briefing-document__prose rendered-markdown" dangerouslySetInnerHTML={{ __html: renderBriefingProse(prose) }} />
          {inlineAnnotations(from, to)}
        </div>,
      );
    };
    for (const section of headingSections) {
      if (section.headingStart < visibleStart || section.headingEnd > end) continue;
      pushProse(cursor, section.headingStart);
      const headingSource = source.slice(section.headingStart, section.headingEnd);
      parts.push(
        <div key={`heading-${section.headingStart}`} className="briefing-document__heading contextual-action-owner">
          <div className="briefing-document__heading-content rendered-markdown" dangerouslySetInnerHTML={{ __html: renderBriefingProse(headingSource) }} />
          <div className="briefing-document__heading-actions contextual-action-group" aria-label={`Section controls for ${section.label}`}>
            <ContextualAction aria-label={`Comment on section ${section.label}`} title="Comment on whole section"
              aria-expanded={editor?.sectionHeading === section.label && editor.start === section.headingStart}
              disabled={!canInteract} onClick={() => openSectionComment(section)}><CommentIcon /></ContextualAction>
          </div>
          {inlineAnnotations(section.headingStart, section.headingEnd)}
        </div>,
      );
      cursor = section.headingEnd;
    }
    pushProse(cursor, end);
    return parts;
  };

  const renderProfileDocument = () => {
    if (source === null || documentIntegrityError) return null;
    const parts: JSX.Element[] = [];
    let cursor = 0;
    for (const item of directiveItems) {
      const directive = item.directive!;
      parts.push(...renderProseRange(cursor, directive.start_offset, cursor === 0));
      const body = source.slice(directive.body_start_offset, directive.body_end_offset);
      const current = Object.prototype.hasOwnProperty.call(draft, item.id) ? draft[item.id] ?? null : item.effective_response?.value ?? null;
      const variants = item.revision.variants ?? [];
      const selectedVariantKey = current && 'option_key' in current ? current.option_key : null;
      const selectedVariant = variants.find((variant) => variant.key === selectedVariantKey) ?? variants[0];
      const visibleBody = item.revision.response_type === 'text_variant' && selectedVariant ? selectedVariant.body : body;
      const promptId = `briefing-directive-prompt-${item.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
      const selected = selectedDirectiveId === item.id;
      parts.push(
        <section className={`briefing-directive${selected ? ' briefing-directive--selected' : ''}`} key={item.id} tabIndex={0}
          aria-labelledby={promptId}
          aria-current={selected ? 'true' : undefined}
          onClick={(event) => { if (!isInteractiveDirectiveTarget(event.target, event.currentTarget)) setSelectedDirectiveId(item.id); }}
          onKeyDown={(event) => { if (event.currentTarget === event.target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedDirectiveId(item.id); } }}>
          <div className="briefing-directive__interaction contextual-action-owner">
            <div className="briefing-directive__passage">
              <div id={promptId} className="briefing-directive__body rendered-markdown" dangerouslySetInnerHTML={{ __html: renderBriefingProse(visibleBody) }} />
              {item.revision.required ? <span className="briefing-directive__required" aria-label="Required">Required</span> : null}
              {inlineAnnotations(directive.start_offset, directive.end_offset)}
              {responseControls(item, current, promptId)}
            </div>
            <div className={`briefing-directive__actions contextual-action-group${selected ? ' contextual-action-group--persistent' : ''}`} aria-label={`Response controls for ${item.revision.title || directive.key}`}>
              <ContextualAction aria-label="Comment" title="Comment" aria-expanded={editor?.directiveItemId === item.id} disabled={!canInteract} onClick={() => openDirectiveComment(item.id)}><CommentIcon /></ContextualAction>
            </div>
          </div>
        </section>,
      );
      cursor = directive.end_offset;
    }
    parts.push(...renderProseRange(cursor, source.length, cursor === 0));
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
    if (!editor || !canInteract) return;
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
    if (!canInteract) return;
    await mutate(
      [{ operation: 'retract', annotation_event_id: annotation.annotation_event_id }],
      'Annotation deleted.',
    );
  };

  return (
    <section ref={contentRef} className="briefing-document__content" aria-label="Briefing document">
      {currentContentError ? <p className="briefing-error" role="alert">{currentContentError}</p> : null}
      {round.directive_binding?.status !== 'valid' ? <p className="briefing-error" role="alert">{round.directive_binding?.reason || 'The pinned directive binding is unavailable.'}</p> : null}
      {documentIntegrityError ? <p className="briefing-error" role="alert">{documentIntegrityError}</p> : null}
      {source === null && !currentContentError ? <p className="briefing-empty" role="status">Verifying document…</p> : null}
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
          {editor.sectionHeading
            ? <p className="briefing-document__section-intent">Whole section: <strong>{editor.sectionHeading}</strong></p>
            : <blockquote>{editor.quote}</blockquote>}
          {!editor.sectionHeading ? (
            <div className="briefing-document__tabs" role="tablist" aria-label="Annotation type">
              <button type="button" role="tab" aria-selected={kind === 'comment'} onClick={() => setKind('comment')}>Comment</button>
              <button type="button" role="tab" aria-selected={kind === 'suggest_replacement'} onClick={() => setKind('suggest_replacement')}>Suggest replacement</button>
            </div>
          ) : null}
          {kind === 'suggest_replacement' && !editor.sectionHeading ? (
            <label>
              Replacement
              <textarea value={replacement} onInput={(event) => setReplacement(event.currentTarget.value)} disabled={!canInteract || busy} />
            </label>
          ) : null}
          <label>
            {kind === 'comment' ? 'Comment' : 'Note (optional)'}
            <textarea value={body} onInput={(event) => setBody(event.currentTarget.value)} disabled={!canInteract || busy} />
          </label>
          <div className="briefing-document__popover-actions">
            {editor.annotation && canInteract ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void remove(editor.annotation!)} disabled={busy}>Delete</button>
            ) : null}
            {canInteract ? <button type="button" className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>Save</button> : null}
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

function PreviousIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m10 3-5 5 5 5" /></svg>;
}

function NextIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>;
}

export default BriefingDocumentPanel;
