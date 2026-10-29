// Shared chip-based issue-predicate filter editor (umbrella de56ffa, child
// 27a5026), extracted from `TimelineFilterComposer` in
// `ui/src/views/timeline.tsx` so the Timeline row-add UI and the Spaces seed
// dialog edit predicates with the same component and emit identical AST shapes.
//
// Behavior is preserved from the Timeline composer: a chip list (click to
// remove), a token input (Enter / "Add chip" to append, Backspace on an empty
// input removes the last chip), a datalist of `field:value` suggestions, a live
// preview, and Cancel / Save actions.
//
// Styling: the component is class-prefix configurable so the Timeline can keep
// its existing global `.timeline-filter-composer*` rules (in `ui/src/style.css`)
// byte-for-byte while the Spaces seed dialog uses the locally-owned
// `./issue-predicate-filter.css`. The shell never edits the global stylesheet.

import { useCallback, useMemo, useState } from 'preact/hooks';

import {
  FILTER_FIELD_PREFIXES,
  chipLabel,
  uniqueFilterValues,
  type TimelineFilterChip,
} from './issue-predicate-filter';
import './issue-predicate-filter.css';

export type IssuePredicateFilterProps = {
  /** Current chips (controlled by the parent). */
  chips: TimelineFilterChip[];
  draftToken?: string;
  onDraftTokenChange?: (token: string) => void;
  /** Are we editing an existing row (changes the Save button label / aria). */
  editing?: boolean;
  /** Does the current chip set yield a predicate (drives preview copy)? */
  projecting: boolean;
  /** Preview title for the current chip set. */
  previewTitle: string;
  /** Autocomplete suggestions. */
  labelOptions?: string[];
  kindOptions?: string[];
  issueOptions?: string[];
  /** Append a `field:value` token. Returns true when accepted (clears the input). */
  onAddToken: (token: string) => boolean;
  /** Remove the chip at `index`. */
  onRemoveChip: (index: number) => void;
  onCancel: () => void;
  onSave: () => void;
  canSave: boolean;
  /** Save button label override; defaults to "Save row" / "Add as row". */
  saveLabel?: string;
  /**
   * BEM-ish class prefix. The Timeline passes `timeline-filter-composer` to keep
   * its existing global styles; everything else uses the owned default class.
   */
  classPrefix?: string;
  /** aria-label for the form; falls back to an edit/add default. */
  ariaLabel?: string;
  /** Placeholder for the token input. */
  placeholder?: string;
  /** Auto-focus the token input on mount (Timeline default true). */
  autoFocusInput?: boolean;
  /**
   * Optional extra preview line (rendered as the `<em>` detail). The Timeline
   * supplies its existing projection copy so its preview is unchanged; the seed
   * dialog omits it.
   */
  previewDetail?: string;
  /** Preview status line when a predicate is/ isn't produced (override defaults). */
  projectingLabel?: string;
  emptyLabel?: string;
};

const DEFAULT_PREFIX = 'issue-predicate-filter';

export function IssuePredicateFilter({
  chips,
  draftToken: controlledToken,
  onDraftTokenChange,
  editing = false,
  projecting,
  previewTitle,
  labelOptions = [],
  kindOptions = [],
  issueOptions = [],
  onAddToken,
  onRemoveChip,
  onCancel,
  onSave,
  canSave,
  saveLabel,
  classPrefix = DEFAULT_PREFIX,
  ariaLabel,
  placeholder = 'label:auth -kind:unknown',
  autoFocusInput = true,
  previewDetail,
  projectingLabel = 'Matches issues',
  emptyLabel = 'Add at least one chip',
}: IssuePredicateFilterProps): JSX.Element {
  const [localToken, setLocalToken] = useState('');
  const draftToken = controlledToken ?? localToken;
  const setDraftToken = onDraftTokenChange ?? setLocalToken;
  const datalistId = `${classPrefix}-token-options`;

  const optionValues = useMemo(() => {
    const labels = labelOptions.map((value) => `label:${value}`);
    const kinds = kindOptions.map((value) => `kind:${value}`);
    const refs = issueOptions.map((value) => `referenced-by:${value}`);
    const subtrees = issueOptions.map((value) => `subtree:${value}`);
    return uniqueFilterValues([...FILTER_FIELD_PREFIXES, ...labels, ...kinds, ...refs, ...subtrees]);
  }, [issueOptions, kindOptions, labelOptions]);

  const submitToken = useCallback(() => {
    if (onAddToken(draftToken)) {
      setDraftToken('');
    }
  }, [draftToken, onAddToken]);

  const resolvedSaveLabel = saveLabel ?? (editing ? 'Save row' : 'Add as row');
  const resolvedAriaLabel = ariaLabel ?? (editing ? 'Edit issue filter' : 'Add issue filter');

  return (
    <form
      className={classPrefix}
      aria-label={resolvedAriaLabel}
      onSubmit={(event) => {
        event.preventDefault();
        if (draftToken.trim()) {
          submitToken();
          return;
        }
        if (canSave) onSave();
      }}
    >
      <div className={`${classPrefix}__chips`} aria-label="Filter chips">
        {chips.length === 0 ? (
          <span>No filters</span>
        ) : (
          chips.map((chip, index) => (
            <button
              key={`${chipLabel(chip)}:${index}`}
              type="button"
              className={`${classPrefix}__chip`}
              onClick={() => onRemoveChip(index)}
              aria-label={`Remove ${chipLabel(chip)}`}
            >
              {chipLabel(chip)}
            </button>
          ))
        )}
      </div>
      <label className={`${classPrefix}__input`}>
        <span>Filter</span>
        <input
          value={draftToken}
          onInput={(event) => setDraftToken((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draftToken.trim()) {
              event.preventDefault();
              submitToken();
            } else if (event.key === 'Backspace' && !draftToken && chips.length > 0) {
              onRemoveChip(chips.length - 1);
            }
          }}
          list={datalistId}
          placeholder={placeholder}
          autoFocus={autoFocusInput}
        />
      </label>
      <datalist id={datalistId}>
        {optionValues.map((value) => <option key={value} value={value} />)}
      </datalist>
      <div className={`${classPrefix}__preview`} aria-live="polite">
        <strong>{previewTitle}</strong>
        <span>{projecting ? projectingLabel : emptyLabel}</span>
        {previewDetail ? <em>{previewDetail}</em> : null}
      </div>
      <div className={`${classPrefix}__actions`}>
        <button type="button" onClick={submitToken} disabled={!draftToken.trim()}>Add chip</button>
        <button type="button" onClick={onSave} disabled={!canSave}>{resolvedSaveLabel}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default IssuePredicateFilter;
