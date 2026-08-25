import { describe, expect, it } from 'vitest';

import type { BriefingDirectiveItem, BriefingResponseType } from '../../ui/src/api';
import {
  BRIEFING_DRAFT_KEY_PREFIX,
  briefingDraftStorageKey,
  loadBriefingDraft,
  normalizeBriefingDraft,
  saveBriefingDraft,
  type BriefingDraftScope,
} from '../../ui/src/views/feedback/briefing-round-view-state';

function item(id: string, responseType: BriefingResponseType, options: Array<{ key: string; label: string }> = []): BriefingDirectiveItem {
  return {
    id, client_item_key: id, parent_item_id: null, item_kind: 'item',
    revision: { id: `revision-${id}`, ordinal: 1, title: id, prompt: id, description: null, response_type: responseType, required: false, position: 0, options },
    effective_response: null, responseVisible: true,
  };
}

const items = [
  item('verdict', 'verdict'),
  item('single', 'single_choice', [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]),
  item('multi', 'multi_choice', [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }, { key: 'c', label: 'Gamma' }]),
  item('short', 'short_text'),
  item('long', 'long_text'),
  item('rating', 'rating'),
];

const scope: BriefingDraftScope = {
  briefingId: 'briefing-1', roundId: 'round-1', artifactVersionId: 'artifact-version-1', profile: 'mandible-briefing.v2',
};

describe('Briefing v2 round draft state', () => {
  it('normalizes all six exact value shapes and canonicalizes multi-choice order', () => {
    expect(normalizeBriefingDraft({ version: 2, answers: {
      verdict: { verdict: 'keep' }, single: { option_key: 'b' }, multi: { option_keys: ['c', 'a'] },
      short: { text: '  exact short  ' }, long: { text: 'exact long' }, rating: { rating: 5 },
    } }, items)).toEqual({
      verdict: { verdict: 'keep' }, single: { option_key: 'b' }, multi: { option_keys: ['a', 'c'] },
      short: { text: '  exact short  ' }, long: { text: 'exact long' }, rating: { rating: 5 },
    });
  });

  it('rejects v1, aliases, empty/duplicate choices, blank or overlong text, unsafe ratings, and extra keys', () => {
    expect(normalizeBriefingDraft({ version: 1, answers: { verdict: { verdict: 'keep' } } }, items)).toEqual({});
    expect(normalizeBriefingDraft({ version: 2, answers: {
      verdict: { verdict: 'keep', extra: true }, single: { option_key: 'missing' }, multi: { option_keys: ['a', 'a'] },
      short: { text: ' '.repeat(2) }, long: { text: 'x'.repeat(4001) }, rating: { rating: 1.5 },
      free: { text: 'legacy alias' },
    } }, items)).toEqual({});
    expect(normalizeBriefingDraft({ version: 2, answers: { short: { text: 'x'.repeat(240) }, long: { text: 'x'.repeat(4000) }, rating: { rating: 1 } } }, items))
      .toMatchObject({ short: { text: expect.stringMatching(/^x{240}$/) }, long: { text: expect.stringMatching(/^x{4000}$/) }, rating: { rating: 1 } });
  });

  it('partitions persisted drafts by actor, briefing, round, artifact version, and profile without carry-forward', () => {
    const rows = new Map<string, string>();
    const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value), removeItem: (key: string) => rows.delete(key) };
    saveBriefingDraft(storage, 'actor-a', scope, { rating: { rating: 4 } });
    expect(briefingDraftStorageKey('actor-a', scope)).toContain(BRIEFING_DRAFT_KEY_PREFIX);
    expect(loadBriefingDraft(storage, 'actor-a', scope, items)).toEqual({ rating: { rating: 4 } });
    expect(loadBriefingDraft(storage, 'actor-b', scope, items)).toEqual({});
    expect(loadBriefingDraft(storage, 'actor-a', { ...scope, roundId: 'round-2' }, items)).toEqual({});
    expect(loadBriefingDraft(storage, 'actor-a', { ...scope, artifactVersionId: 'artifact-version-2' }, items)).toEqual({});
  });
});
