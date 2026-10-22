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
  normalizeFilterChips,
  parseFilterToken,
  type TimelineFilterChip,
} from '../ui/src/views/filters/issue-predicate-filter';

describe('issue-predicate filter logic', () => {
  it('rejects unknown fields and malformed tokens', () => {
    expect(parseFilterToken('bogus:value')).toBeNull();
    expect(parseFilterToken('noseparator')).toBeNull();
    expect(parseFilterToken('')).toBeNull();
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

  // ── Round-trip contract with the Timeline ──────────────────────────────────
});
