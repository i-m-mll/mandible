import { useId, useState } from 'preact/hooks';
import type { Ref } from 'preact';
import { Icon } from '../../components/icons/Icon';
import { ContextualAction } from '../../components/shared/ContextualAction';
import { appTip } from '../../components/shared/AppHoverTips';
import {
  MarkdownDocument, type MarkdownDocumentHandle, type MarkdownRangeDecoration, type MarkdownSelection,
} from '../../components/MarkdownDocument';
import type { BriefingDirectiveItem, BriefingResponseValue } from '../../api';

type DirectiveControlsItem = { id: string; directive: NonNullable<BriefingDirectiveItem['directive']>;
  revision: Pick<BriefingDirectiveItem['revision'], 'response_type' | 'required' | 'options' | 'variants'> };

export const BRIEFING_MARKDOWN_PREVIEW = { images: 'omit', directivePreview: 'on-changed-text' } as const;

export function BriefingDirectiveControls({ item, source, current, canInteract, validationError, decorations, documentRef,
  onDirectiveValue, onTextBlur, onSelect, onComment, onDecorationClick }: {
  item: DirectiveControlsItem;
  source: string;
  current: BriefingResponseValue | null;
  canInteract: boolean;
  validationError?: string;
  decorations: readonly MarkdownRangeDecoration[];
  documentRef?: Ref<MarkdownDocumentHandle>;
  onDirectiveValue?(itemId: string, value: BriefingResponseValue | null): void;
  onTextBlur?(itemId: string, value: BriefingResponseValue | null): void;
  onSelect(selection: MarkdownSelection): void;
  onComment?(selection: MarkdownSelection): void;
  onDecorationClick(id: string): void;
}) {
  const radioGroupScope = useId();
  const promptId = `${radioGroupScope}-prompt`;
  const [textEdit, setTextEdit] = useState<string | null>(null);
  const responseControls = (item: DirectiveControlsItem, current: BriefingResponseValue | null, promptId: string) => {
    const type = item.revision.response_type;
    const controlId = `briefing-directive-${item.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const errorId = `${controlId}-error`;
    const error = validationError;
    const describedBy = error ? errorId : undefined;
    let control: JSX.Element | null = null;
    if (type === 'verdict') {
      const verdict = current && 'verdict' in current ? current.verdict : null;
      control = (
        <div id={controlId} className="briefing-directive__compact-controls briefing-directive__verdict" role="group" aria-labelledby={promptId} aria-required={item.revision.required} aria-describedby={describedBy}>
          <ContextualAction presentation="compact" aria-label="Keep" title="Keep" aria-pressed={verdict === 'keep'} disabled={!canInteract} onClick={() => onDirectiveValue?.(item.id, { verdict: 'keep' })}><Icon name="keep" /></ContextualAction>
          <ContextualAction presentation="compact" aria-label="Dismiss" title="Dismiss" aria-pressed={verdict === 'dismiss'} disabled={!canInteract} onClick={() => onDirectiveValue?.(item.id, { verdict: 'dismiss' })}><Icon name="discard" /></ContextualAction>
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
      const text = textEdit !== null
        ? textEdit
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
          setTextEdit(value);
          if (!onTextBlur) onDirectiveValue?.(item.id, value.trim() ? { text: value } : null);
        },
        onBlur: () => {
          const saved = current && 'text' in current ? current.text : '';
          if (onTextBlur && textEdit !== null && textEdit !== saved) {
            onTextBlur(item.id, textEdit.trim() ? { text: textEdit } : null);
          }
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
            onClick={() => onDirectiveValue?.(item.id, { option_key: variants[selectedIndex - 1].key })}><Icon name="previousChange" /></ContextualAction>
          <span><small>{selectedIndex + 1} of {variants.length}</small></span>
          <ContextualAction presentation="compact" aria-label="Next text variant" disabled={!canInteract || selectedIndex === variants.length - 1}
            onClick={() => onDirectiveValue?.(item.id, { option_key: variants[selectedIndex + 1].key })}><Icon name="nextChange" /></ContextualAction>
        </div>
      ) : null;
    }
    return (
      <div className="briefing-directive__response">
        {control}
        {error ? <span id={errorId} className="briefing-directive__error" role="alert" aria-describedby={promptId}>{error}</span> : null}
      </div>
    );
  };

  const clearResponseAction = (item: DirectiveControlsItem, current: BriefingResponseValue | null, promptId: string) => (
    <span className="briefing-directive__clear-slot">
      {current ? (
        <ContextualAction className="briefing-directive__clear" aria-label="Clear response" title="Clear response"
          aria-describedby={promptId} disabled={!canInteract} onClick={() => {
            setTextEdit('');
            onDirectiveValue?.(item.id, null);
          }}><Icon name="clearVerdict" /></ContextualAction>
      ) : null}
    </span>
  );


  const directive = item.directive;
  const variants = item.revision.variants ?? [];
  const value = current && 'option_key' in current ? current.option_key : null;
  const span = variants.find((variant) => variant.key === value) ?? variants[0] ?? directive;
  const start = span.body_start_offset;
  const end = span.body_end_offset;
  const quote = source.slice(start, end);
  const relativeDecorations = decorations.flatMap((range) => range.start < end && range.end > start
    ? [{ ...range, start: Math.max(range.start, start) - start, end: Math.min(range.end, end) - start }]
    : []);
  return (
    <section className="briefing-directive" aria-labelledby={promptId}>
      <div id={promptId}>
        <MarkdownDocument value={quote} readOnly ariaLabel="Directive text" previewPolicy={BRIEFING_MARKDOWN_PREVIEW}
          documentRef={documentRef} decorations={relativeDecorations} onDecorationClick={onDecorationClick}
          onSelectionChange={(selection) => onSelect({ ...selection, start: selection.start + start, end: selection.end + start })} />
      </div>
      <div className="briefing-directive__controls">
        {responseControls(item, current, promptId)}
        {clearResponseAction(item, current, promptId)}
        {onComment && <ContextualAction aria-label="Comment on directive" {...appTip('Comment')} disabled={!canInteract}
          onClick={() => onComment({ start, end, quote })}><Icon name="comment" /></ContextualAction>}
      </div>
    </section>
  );
}
