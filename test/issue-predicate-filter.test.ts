// Tests for the shared issue-predicate / filter logic module (child 27a5026).
//
// The key acceptance criterion: the extracted module is consumed by BOTH the
// Timeline and the Spaces seed dialog, and the predicate shape it produces
// round-trips with the Timeline unchanged (field name `scope`, AST shape). The
// round-trip case below pins the exact AST the Timeline relied on before the
// extraction, so any drift in the shared module that would change Timeline
// semantics fails here.

import { describe, expect, it } from 'vitest';

import {
  chipLabel,
  filterRowTitle,
  normalizeFilterChips,
  parseFilterToken,
  predicateForChip,
  predicateForChips,
  rowSpecFromChips,
  type TimelineFilterChip,
  type TimelineFilterRowSpec,
} from '../ui/src/views/filters/issue-predicate-filter';
import type { TimelineIssuePredicate } from '../ui/src/types/timeline';

describe('issue-predicate filter logic', () => {
  it('parses field:value tokens, including negation and multi-value', () => {
    expect(parseFilterToken('label:auth')).toEqual({
      field: 'label',
      values: ['auth'],
      negated: false,
    });
    expect(parseFilterToken('-kind:unknown')).toEqual({
      field: 'kind',
      values: ['unknown'],
      negated: true,
    });
    expect(parseFilterToken('label:auth,security')).toEqual({
      field: 'label',
      values: ['auth', 'security'],
      negated: false,
    });
  });

  it('rejects unknown fields and malformed tokens', () => {
    expect(parseFilterToken('bogus:value')).toBeNull();
    expect(parseFilterToken('noseparator')).toBeNull();
    expect(parseFilterToken('')).toBeNull();
  });

  it('maps each field to the matching predicate node', () => {
    expect(predicateForChip({ field: 'label', values: ['auth'], negated: false }))
      .toEqual({ type: 'label', name: 'auth' });
    expect(predicateForChip({ field: 'kind', values: ['feature'], negated: false }))
      .toEqual({ type: 'kind', kind: 'feature' });
    expect(predicateForChip({ field: 'referenced-by', values: ['abc'], negated: false }))
      .toEqual({ type: 'referenced_by', issue_id: 'abc' });
    expect(predicateForChip({ field: 'subtree', values: ['root'], negated: false }))
      .toEqual({ type: 'parent_subtree', issue_id: 'root' });
  });

  it('builds an or across multi-value chips and wraps negation in not', () => {
    expect(predicateForChip({ field: 'label', values: ['a', 'b'], negated: false })).toEqual({
      type: 'or',
      predicates: [
        { type: 'label', name: 'a' },
        { type: 'label', name: 'b' },
      ],
    });
    expect(predicateForChip({ field: 'label', values: ['a'], negated: true })).toEqual({
      type: 'not',
      predicate: { type: 'label', name: 'a' },
    });
  });

  it('combines multiple chips into an and predicate', () => {
    const chips: TimelineFilterChip[] = [
      { field: 'label', values: ['auth'], negated: false },
      { field: 'kind', values: ['feature'], negated: false },
    ];
    expect(predicateForChips(chips)).toEqual({
      type: 'and',
      predicates: [
        { type: 'label', name: 'auth' },
        { type: 'kind', kind: 'feature' },
      ],
    });
  });

  it('normalizes chips (dedupe, trim, drop empty/unknown)', () => {
    const chips: TimelineFilterChip[] = [
      { field: 'label', values: [' auth ', 'auth', ''], negated: false },
      { field: 'bogus' as TimelineFilterChip['field'], values: ['x'], negated: false },
      { field: 'kind', values: [], negated: false },
    ];
    expect(normalizeFilterChips(chips)).toEqual([
      { field: 'label', values: ['auth'], negated: false },
    ]);
  });

  it('produces a stable, unique row id and human title', () => {
    const existing: TimelineFilterRowSpec[] = [
      { id: 'local-label-auth', title: 'label:auth', chips: [], scope: { type: 'residual' } },
    ];
    const chips: TimelineFilterChip[] = [{ field: 'label', values: ['auth'], negated: false }];
    const row = rowSpecFromChips(chips, existing);
    expect(row?.id).toBe('local-label-auth-2');
    expect(row?.title).toBe('label:auth');
    expect(filterRowTitle(chips)).toBe('label:auth');
    expect(chipLabel(chips[0])).toBe('label:auth');
  });

  // ── Round-trip contract with the Timeline ──────────────────────────────────
  it('round-trips the Timeline filter-row shape unchanged (scope AST, field name)', () => {
    // This is the exact chip set / predicate the Timeline produced before the
    // shared module was extracted. The seed dialog now uses the same helpers, so
    // both surfaces emit this identical shape.
    const chips: TimelineFilterChip[] = [
      { field: 'label', values: ['auth', 'security'], negated: false },
      { field: 'kind', values: ['unknown'], negated: true },
    ];
    const row = rowSpecFromChips(chips);
    expect(row).not.toBeNull();

    // The predicate field is named `scope` (NOT `predicate`) and is the AST.
    const expectedScope: TimelineIssuePredicate = {
      type: 'and',
      predicates: [
        {
          type: 'or',
          predicates: [
            { type: 'label', name: 'auth' },
            { type: 'label', name: 'security' },
          ],
        },
        { type: 'not', predicate: { type: 'kind', kind: 'unknown' } },
      ],
    };
    expect(row?.scope).toEqual(expectedScope);

    // The row spec carries the canonical fields the Timeline depends on.
    expect(Object.keys(row!).sort()).toEqual(['chips', 'id', 'scope', 'title']);
    expect(row?.chips).toEqual(chips);
  });

  it('serializing chips and re-deriving yields an identical scope (idempotent)', () => {
    const chips: TimelineFilterChip[] = [
      { field: 'subtree', values: ['root-issue'], negated: false },
    ];
    const first = rowSpecFromChips(chips);
    const second = rowSpecFromChips(first!.chips);
    expect(second?.scope).toEqual(first?.scope);
  });
});
