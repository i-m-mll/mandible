// Shared issue-predicate / filter logic (umbrella de56ffa, child 27a5026).
//
// This module is the *single source of truth* for turning the chip-based filter
// UI into the canonical `TimelineIssuePredicate` AST, extracted verbatim from
// `ui/src/views/timeline.tsx` so that both surfaces — the Timeline row-add UI
// and the Spaces seed dialog — produce predicates of the exact same shape.
//
// Hard requirement (umbrella §6.1): the predicate field on a filter row is
// named `scope` (a `TimelineIssuePredicate` AST), and the chip shape is
// `{ field, values[], negated }`. Both must round-trip with the Timeline
// unchanged. The Timeline consumes these helpers directly, so any change here
// changes both surfaces in lockstep — there is no second copy to drift.
//
// This file is pure logic only (no Preact/DOM); the chip-editing UI lives in
// `./IssuePredicateFilter.tsx`. Keeping the AST-building logic framework-free
// makes it trivially unit-testable for the round-trip assertion.

import type {
  LedgerIssueKind,
  TimelineFilterChip,
  TimelineFilterField,
  TimelineFilterRowSpec,
  TimelineIssuePredicate,
} from '../../types/timeline';

export type {
  TimelineFilterChip,
  TimelineFilterField,
  TimelineFilterRowSpec,
  TimelineIssuePredicate,
} from '../../types/timeline';

/** The four supported filter fields, in canonical order. */
export const FILTER_FIELDS: TimelineFilterField[] = ['label', 'kind', 'referenced-by', 'subtree'];

/** `field:` token prefixes used to seed the chip-composer datalist. */
export const FILTER_FIELD_PREFIXES = ['label:', 'kind:', 'referenced-by:', 'subtree:'];

/** Dedupe + trim a list of string values, dropping empties. */
export function uniqueFilterValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function isFilterField(value: string): value is TimelineFilterField {
  return FILTER_FIELDS.includes(value as TimelineFilterField);
}

export function cleanFilterValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Drop unsupported fields / empty values and canonicalize each chip. */
export function normalizeFilterChips(chips: TimelineFilterChip[]): TimelineFilterChip[] {
  return chips
    .map((chip) => ({
      field: chip.field,
      negated: chip.negated === true,
      values: uniqueFilterValues(chip.values.map(cleanFilterValue)),
    }))
    .filter((chip) => isFilterField(chip.field) && chip.values.length > 0);
}

/** Build the predicate AST for a single chip (an `or` across its values; `not` when negated). */
export function predicateForChip(chip: TimelineFilterChip): TimelineIssuePredicate | null {
  const predicates = chip.values.map<TimelineIssuePredicate | null>((value) => {
    if (chip.field === 'label') return { type: 'label', name: value };
    if (chip.field === 'kind') return { type: 'kind', kind: value as LedgerIssueKind };
    if (chip.field === 'referenced-by') return { type: 'referenced_by', issue_id: value };
    if (chip.field === 'subtree') return { type: 'parent_subtree', issue_id: value };
    return null;
  }).filter((predicate): predicate is TimelineIssuePredicate => Boolean(predicate));
  if (predicates.length === 0) return null;
  const predicate = predicates.length === 1 ? predicates[0] : { type: 'or' as const, predicates };
  return chip.negated ? { type: 'not', predicate } : predicate;
}

/** Combine all chips into one predicate (an `and` across chips). */
export function predicateForChips(chips: TimelineFilterChip[]): TimelineIssuePredicate | null {
  const predicates = normalizeFilterChips(chips)
    .map(predicateForChip)
    .filter((predicate): predicate is TimelineIssuePredicate => Boolean(predicate));
  if (predicates.length === 0) return null;
  return predicates.length === 1 ? predicates[0] : { type: 'and', predicates };
}

/** Human-readable token form of a chip, e.g. `-label:auth,security`. */
export function chipLabel(chip: TimelineFilterChip): string {
  const prefix = chip.negated ? '-' : '';
  return `${prefix}${chip.field}:${chip.values.join(',')}`;
}

export function filterRowTitle(chips: TimelineFilterChip[]): string {
  const label = normalizeFilterChips(chips).map(chipLabel).join(' ');
  return label || 'Custom filter';
}

export function filterRowId(
  chips: TimelineFilterChip[],
  existing: readonly TimelineFilterRowSpec[] = [],
): string {
  const base = filterRowTitle(chips)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'filter';
  const used = new Set(existing.map((row) => row.id));
  let candidate = `local-${base}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `local-${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Build a `TimelineFilterRowSpec` (chips + `scope` predicate) from raw chips.
 * Returns null when no chip yields a predicate. The `scope` field name and AST
 * shape are the frozen round-trip contract with the Timeline.
 */
export function rowSpecFromChips(
  chips: TimelineFilterChip[],
  existing: readonly TimelineFilterRowSpec[] = [],
  id?: string,
): TimelineFilterRowSpec | null {
  const normalized = normalizeFilterChips(chips);
  const scope = predicateForChips(normalized);
  if (!scope) return null;
  return {
    id: id ?? filterRowId(normalized, existing),
    title: filterRowTitle(normalized),
    chips: normalized,
    scope,
  };
}

/** Parse a single `field:value[,value]` (optionally `-`-negated) token into a chip. */
export function parseFilterToken(rawToken: string): TimelineFilterChip | null {
  const raw = rawToken.trim();
  if (!raw) return null;
  const negated = raw.startsWith('-');
  const token = negated ? raw.slice(1) : raw;
  const separator = token.indexOf(':');
  if (separator <= 0) return null;
  const field = token.slice(0, separator);
  if (!isFilterField(field)) return null;
  const values = uniqueFilterValues(token.slice(separator + 1).split(',').map(cleanFilterValue));
  return values.length > 0 ? { field, values, negated } : null;
}
