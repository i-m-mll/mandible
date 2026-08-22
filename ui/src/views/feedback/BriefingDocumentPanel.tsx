import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

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
import { DetailPaneModal } from '../../components/shared/DetailPaneModal';
import {
  buildBriefingMarkdownModel,
  type BriefingMarkdownEntityKind,
  type BriefingMarkdownModel,
} from './briefingMarkdownModel';

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
  displayQuote?: string;
};

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

function semanticElements(document: Document, kind: BriefingMarkdownEntityKind): HTMLElement[] {
  const selector = kind === 'heading' ? 'h1, h2, h3, h4, h5, h6'
    : kind === 'paragraph' ? 'p'
      : kind === 'list-item' ? 'li'
        : kind === 'table' ? 'table'
          : kind === 'block-quote' ? 'blockquote'
            : 'pre';
  return Array.from(document.body.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    if (kind === 'paragraph' || kind === 'fenced-code') return !element.parentElement?.closest('li, blockquote');
    if (kind === 'block-quote') return !element.parentElement?.closest('blockquote');
    return true;
  });
}

function actionHost(document: Document, element: HTMLElement, slot: string, index: number): HTMLElement {
  let host: HTMLElement;
  if (element.tagName === 'TABLE') {
    host = element.querySelector(':scope > caption') as HTMLElement | null ?? document.createElement('caption');
    if (!host.parentElement) element.prepend(host);
  } else {
    host = document.createElement('span');
    element.prepend(host);
  }
  host.classList.add('briefing-markdown__action-rail', 'contextual-action-group');
  if (slot === 'briefingDirectiveAction') host.classList.add('briefing-directive__actions');
  host.dataset[slot] = String(index);
  return host;
}

function usesCompactResponseRail(type: BriefingDirectiveItem['revision']['response_type']): boolean {
  return type === 'verdict' || type === 'text_variant';
}

function renderSourceMappedMarkdown(model: BriefingMarkdownModel, annotations: BriefingAnnotation[]): string {
  const document = new DOMParser().parseFromString(renderBriefingProse(model.markdown), 'text/html');
  const elementsByKind = new Map<BriefingMarkdownEntityKind, HTMLElement[]>();
  const kindCursors = new Map<BriefingMarkdownEntityKind, number>();
  const blockElements = model.blocks.map((block) => {
    let elements = elementsByKind.get(block.kind);
    if (!elements) {
      elements = semanticElements(document, block.kind);
      elementsByKind.set(block.kind, elements);
    }
    const index = kindCursors.get(block.kind) ?? 0;
    kindCursors.set(block.kind, index + 1);
    return elements[index] ?? null;
  });

  model.entities.forEach((entity, entityIndex) => {
    const blockIndex = model.blocks.findIndex((block) => block.kind === entity.kind
      && block.displayStart === entity.displayStart && block.displayEnd === entity.displayEnd);
    const element = blockElements[blockIndex];
    if (!element) return;
    element.classList.add('briefing-markdown__entity', 'contextual-action-owner');
    actionHost(document, element, 'briefingEntityAction', entityIndex);
    if (annotations.some((annotation) => annotation.start_offset < entity.end && annotation.end_offset > entity.start)) {
      const annotationHost = document.createElement('div');
      annotationHost.dataset.briefingEntityAnnotations = String(entityIndex);
      if (element.tagName === 'LI') element.append(annotationHost);
      else element.after(annotationHost);
    }
  });

  model.directives.forEach((directive, directiveIndex) => {
    const matches = model.blocks
      .map((block, index) => ({ block, element: blockElements[index] }))
      .filter(({ block, element }) => element && block.displayStart < directive.displayEnd && block.displayEnd > directive.displayStart);
    if (matches.length === 0) return;
    for (const { element } of matches) {
      element!.classList.add('briefing-directive');
      element!.dataset.briefingDirectiveIndex = String(directiveIndex);
    }
    const first = matches[0].element!;
    first.classList.add('briefing-directive--owner', 'contextual-action-owner');
    first.tabIndex = 0;
    first.id = `briefing-directive-prompt-${directive.itemId}`.replace(/[^A-Za-z0-9_-]/g, '-');
    actionHost(document, first, 'briefingDirectiveAction', directiveIndex);
    const responseHost = document.createElement('div');
    const compact = usesCompactResponseRail(directive.responseType);
    responseHost.className = `briefing-directive__response-host briefing-directive__response-host--${compact ? 'rail' : 'flow'}`;
    responseHost.dataset.briefingDirectiveIndex = String(directiveIndex);
    responseHost.dataset.briefingDirectiveResponse = String(directiveIndex);
    if (compact) document.body.append(responseHost);
    else {
      const last = matches.at(-1)!.element!;
      if (last.tagName === 'LI') last.append(responseHost);
      else last.after(responseHost);
    }
  });
  return document.body.innerHTML;
}

const DIRECTIVE_RAIL_GUTTER_OFFSET = 10;

function alignBriefingRails(sourceTree: HTMLElement): void {
  const sourceRect = sourceTree.getBoundingClientRect();
  const gutterX = sourceRect.left - DIRECTIVE_RAIL_GUTTER_OFFSET;
  const styles = globalThis.getComputedStyle(sourceTree);
  const contentRight = sourceRect.right - Number.parseFloat(styles.paddingRight || '0');
  let responseRailBottom = 0;
  sourceTree.querySelectorAll<HTMLElement>('.briefing-directive--owner').forEach((owner) => {
    const ownerRect = owner.getBoundingClientRect();
    owner.style.setProperty('--briefing-directive-rail-offset', `${gutterX - ownerRect.left}px`);
    const responseHost = sourceTree.querySelector<HTMLElement>(
      `[data-briefing-directive-response="${owner.dataset.briefingDirectiveIndex}"].briefing-directive__response-host--rail`,
    );
    if (responseHost) {
      const responseRect = responseHost.getBoundingClientRect();
      const responseTop = ownerRect.top - sourceRect.top;
      responseHost.style.setProperty('--briefing-right-rail-top', `${responseTop}px`);
      responseRailBottom = Math.max(responseRailBottom, responseTop + responseRect.height);
    }
  });
  const baseHeight = sourceRect.height - Number.parseFloat(styles.paddingBottom || '0');
  sourceTree.style.setProperty('--briefing-right-rail-overflow', `${Math.max(0, responseRailBottom - baseHeight)}px`);
  sourceTree.querySelectorAll<HTMLElement>('[data-briefing-entity-action], [data-briefing-directive-action]').forEach((host) => {
    const owner = host.parentElement;
    const ownerRect = owner?.getBoundingClientRect();
    if (owner && ownerRect) {
      host.style.setProperty('--briefing-right-rail-action-offset', `${contentRight + 8 - ownerRect.left}px`);
      host.style.setProperty('--briefing-right-rail-top', '0px');
      owner.style.setProperty(
        '--briefing-right-rail-hover-width',
        `calc(${Math.max(0, contentRight + 8 - ownerRect.right)}px + 1.3em)`,
      );
    }
  });
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
  const [portalRevision, setPortalRevision] = useState(0);
  const contentRef = useRef<HTMLElement>(null);
  const renderedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTextEdits({});
  }, [briefingId, roundId, document?.artifact_version_id, draftIdentity]);

  useEffect(() => {
    setSelectedDirectiveId(null);
  }, [briefingId, roundId, document?.artifact_version_id]);

  useEffect(() => {
    const dismissSelection = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const directive = event.target.closest('[data-briefing-directive-index]');
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

  const annotations = useMemo(() => round.annotations ?? [], [round.annotations]);
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
  const selectedVariantKeys = useMemo(() => Object.fromEntries(directiveItems.map((item) => {
    const current = Object.prototype.hasOwnProperty.call(draft, item.id) ? draft[item.id] ?? null : item.effective_response?.value ?? null;
    return [item.id, current && 'option_key' in current ? current.option_key : null];
  })), [directiveItems, draft]);
  const markdownModel = useMemo(() => source === null ? null : buildBriefingMarkdownModel(
    source,
    directiveItems,
    selectedVariantKeys,
    source.length - suppressRepeatedLeadingHeading(source, briefingTitle).length,
  ), [briefingTitle, directiveItems, selectedVariantKeys, source]);
  const renderedMarkdown = useMemo(() => markdownModel
    ? renderSourceMappedMarkdown(markdownModel, annotations)
    : '', [annotations, markdownModel]);
  useLayoutEffect(() => {
    if (renderedMarkdown) setPortalRevision((revision) => revision + 1);
  }, [renderedMarkdown]);
  useLayoutEffect(() => {
    if (!markdownModel || !renderedRef.current) return;
    renderedRef.current.querySelectorAll<HTMLElement>('[data-briefing-directive-index]').forEach((element) => {
      const directive = markdownModel.directives[Number(element.dataset.briefingDirectiveIndex)];
      const selected = directive?.itemId === selectedDirectiveId;
      element.classList.toggle('briefing-directive--selected', selected);
      if (element.tabIndex === 0) element.setAttribute('aria-current', selected ? 'true' : 'false');
    });
    renderedRef.current.querySelectorAll<HTMLElement>('[data-briefing-directive-action]').forEach((element) => {
      const directive = markdownModel.directives[Number(element.dataset.briefingDirectiveAction)];
      element.classList.toggle('contextual-action-group--persistent', directive?.itemId === selectedDirectiveId);
    });
  }, [markdownModel, portalRevision, selectedDirectiveId]);
  useLayoutEffect(() => {
    const sourceTree = renderedRef.current;
    if (!sourceTree) return undefined;
    const updateRails = () => alignBriefingRails(sourceTree);
    const owners = Array.from(sourceTree.querySelectorAll<HTMLElement>('.briefing-directive--owner'));
    const responseHosts = Array.from(sourceTree.querySelectorAll<HTMLElement>('.briefing-directive__response-host--rail'));
    updateRails();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateRails);
    observer?.observe(sourceTree);
    owners.forEach((owner) => observer?.observe(owner));
    responseHosts.forEach((host) => observer?.observe(host));
    globalThis.addEventListener('resize', updateRails);
    globalThis.document.fonts?.addEventListener('loadingdone', updateRails);
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener('resize', updateRails);
      globalThis.document.fonts?.removeEventListener('loadingdone', updateRails);
    };
  }, [portalRevision, renderedMarkdown]);
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
    displayQuote: markdownModel?.directives.find((directive) => (
      annotation.start_offset < directive.containerEnd && annotation.end_offset > directive.containerStart
    ))?.quote,
  });

  const openDirectiveComment = (itemId: string) => {
    const item = round.items.find((candidate) => candidate.id === itemId);
    const directive = markdownModel?.directives.find((candidate) => candidate.itemId === itemId);
    if (!item || !directive || source === null) return;
    openEditor({ annotation: null, directiveItemId: itemId, start: directive.start, end: directive.end, quote: directive.quote });
  };

  const openEntityComment = (entityIndex: number) => {
    const entity = markdownModel?.entities[entityIndex];
    if (!entity || source === null) return;
    if (entity.kind === 'heading' && entity.sectionEnd) {
      const rawQuote = source.slice(entity.start, entity.sectionEnd);
      const quote = rawQuote.trim();
      const start = entity.start + rawQuote.indexOf(quote);
      openEditor({ annotation: null, sectionHeading: entity.label, start, end: start + quote.length, quote });
      return;
    }
    openEditor({ annotation: null, start: entity.start, end: entity.end, quote: entity.quote });
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
        <div id={controlId} className="briefing-directive__compact-controls briefing-directive__verdict" role="group" aria-labelledby={promptId} aria-required={item.revision.required} aria-describedby={describedBy}>
          <ContextualAction presentation="compact" aria-label="Keep" title="Keep" aria-pressed={verdict === 'keep'} disabled={!canInteract} onClick={() => onDirectiveValue?.(item.id, { verdict: 'keep' })}><CheckIcon /></ContextualAction>
          <ContextualAction presentation="compact" aria-label="Dismiss" title="Dismiss" aria-pressed={verdict === 'dismiss'} disabled={!canInteract} onClick={() => onDirectiveValue?.(item.id, { verdict: 'dismiss' })}><DismissIcon /></ContextualAction>
        </div>
      );
    } else if (type === 'single_choice' || type === 'multi_choice') {
      const selected = type === 'single_choice'
        ? new Set(current && 'option_key' in current ? [current.option_key] : [])
        : new Set(current && 'option_keys' in current ? current.option_keys : []);
      control = (
        <fieldset id={controlId} className="briefing-directive__choices" aria-labelledby={promptId} aria-required={item.revision.required} aria-invalid={Boolean(error)} aria-describedby={describedBy}>
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
        'aria-required': item.revision.required,
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
        <fieldset id={controlId} className="briefing-directive__rating" aria-labelledby={promptId} aria-required={item.revision.required} aria-invalid={Boolean(error)} aria-describedby={describedBy}>
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
        <div id={controlId} className="briefing-directive__compact-controls briefing-directive__variant-controls" role="group" aria-label={`Text variant: ${selectedVariant.label}`} aria-required={item.revision.required} aria-describedby={describedBy}>
          <ContextualAction presentation="compact" aria-label="Previous text variant" disabled={!canInteract || selectedIndex === 0}
            onClick={() => onDirectiveValue?.(item.id, { option_key: variants[selectedIndex - 1].key })}><PreviousIcon /></ContextualAction>
          <span><small>{selectedIndex + 1} of {variants.length}</small></span>
          <ContextualAction presentation="compact" aria-label="Next text variant" disabled={!canInteract || selectedIndex === variants.length - 1}
            onClick={() => onDirectiveValue?.(item.id, { option_key: variants[selectedIndex + 1].key })}><NextIcon /></ContextualAction>
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

  const renderProfileDocument = () => {
    if (source === null || documentIntegrityError || !markdownModel) return null;
    void portalRevision;
    const entityHosts = renderedRef.current?.querySelectorAll<HTMLElement>('[data-briefing-entity-action]') ?? [];
    const entityAnnotationHosts = renderedRef.current?.querySelectorAll<HTMLElement>('[data-briefing-entity-annotations]') ?? [];
    const directiveActionHosts = renderedRef.current?.querySelectorAll<HTMLElement>('[data-briefing-directive-action]') ?? [];
    const directiveResponseHosts = renderedRef.current?.querySelectorAll<HTMLElement>('[data-briefing-directive-response]') ?? [];
    return (
      <div className="briefing-document__rendered rendered-markdown" aria-label="Pinned briefing document"
        onClick={(event) => {
          if (!(event.target instanceof Element)) return;
          const directiveElement = event.target.closest<HTMLElement>('[data-briefing-directive-index]');
          if (!directiveElement || !renderedRef.current?.contains(directiveElement) || isInteractiveDirectiveTarget(event.target, directiveElement)) return;
          const directive = markdownModel.directives[Number(directiveElement.dataset.briefingDirectiveIndex)];
          if (directive) setSelectedDirectiveId(directive.itemId);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-briefing-directive-index]')) return;
          event.preventDefault();
          const directive = markdownModel.directives[Number(event.target.dataset.briefingDirectiveIndex)];
          if (directive) setSelectedDirectiveId(directive.itemId);
        }}>
        <div ref={renderedRef} className="briefing-document__source-tree briefing-document__prose rendered-markdown" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
        {markdownModel.entities.map((entity, index) => {
          const host = Array.from(entityHosts).find((candidate) => candidate.dataset.briefingEntityAction === String(index));
          const annotationHost = Array.from(entityAnnotationHosts).find((candidate) => candidate.dataset.briefingEntityAnnotations === String(index));
          const heading = entity.kind === 'heading';
          return [host ? createPortal(
            <ContextualAction aria-label={heading ? `Comment on section ${entity.label}` : `Comment on ${entity.kind}: ${entity.label}`}
              title={heading ? 'Comment on whole section' : 'Comment on this Markdown block'}
              aria-expanded={editor?.start === entity.start}
              disabled={!canInteract} onClick={() => openEntityComment(index)}><CommentIcon /></ContextualAction>,
            host,
          ) : null, annotationHost ? createPortal(inlineAnnotations(entity.start, entity.end), annotationHost) : null];
        })}
        {directiveItems.map((item) => {
          const directiveIndex = markdownModel.directives.findIndex((directive) => directive.itemId === item.id);
          const actionHost = Array.from(directiveActionHosts).find((candidate) => candidate.dataset.briefingDirectiveAction === String(directiveIndex));
          const responseHost = Array.from(directiveResponseHosts).find((candidate) => candidate.dataset.briefingDirectiveResponse === String(directiveIndex));
          const current = Object.prototype.hasOwnProperty.call(draft, item.id) ? draft[item.id] ?? null : item.effective_response?.value ?? null;
          const promptId = `briefing-directive-prompt-${item.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
          return [
            actionHost ? createPortal(
              <ContextualAction aria-label="Comment" title="Comment" aria-expanded={editor?.directiveItemId === item.id}
                disabled={!canInteract} onClick={() => openDirectiveComment(item.id)}><CommentIcon /></ContextualAction>, actionHost,
            ) : null,
            responseHost ? createPortal(<>
              {inlineAnnotations(item.directive!.start_offset, item.directive!.end_offset)}
              {responseControls(item, current, promptId)}
            </>, responseHost) : null,
          ];
        })}
      </div>
    );
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

      <DetailPaneModal
        open={editor !== null}
        onClose={() => setEditor(null)}
        titleId="briefing-annotation-editor-title"
        title={editor?.annotation ? 'Edit annotation' : 'Add annotation'}
        closeLabel="Close annotation editor"
        embeddedFallback={{ scrollOwnerRef: contentRef }}
        scrollLockClassName="detail-pane-shell__body--overlay-open"
        className="briefing-document__annotation-modal"
        panelClassName="briefing-document__popover"
      >
        {editor ? (
          <>
          {editor.sectionHeading
            ? <p className="briefing-document__section-intent">Whole section: <strong>{editor.sectionHeading}</strong></p>
            : <blockquote>{editor.displayQuote ?? editor.quote}</blockquote>}
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
          </>
        ) : <></>}
      </DetailPaneModal>

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
