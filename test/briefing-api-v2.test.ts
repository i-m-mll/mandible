import { describe, expect, it } from 'vitest';

import { normalizeBriefingRoundProjection, normalizeInstanceInfo } from '../ui/src/api';

const definitions = [
  ['verdict', 'verdict', [], { verdict: 'keep' }],
  ['single', 'single_choice', [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }], { option_key: 'b' }],
  ['multi', 'multi_choice', [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }, { key: 'c', label: 'Gamma' }], { option_keys: ['a', 'c'] }],
  ['short', 'short_text', [], { text: '  exact short  ' }],
  ['long', 'long_text', [], { text: 'exact long' }],
  ['rating', 'rating', [], { rating: 5 }],
] as const;

function payload() {
  return {
    round_id: 'round-1', state: 'open', briefing_key: 'typed', binding_digest: 'binding', created_at: 1,
    latest_submission_for_actor: null,
    document: { artifact_version_id: 'artifact-version-1', previous_round_id: null, profile: 'mandible-briefing.v2' },
    directive_binding: { status: 'valid' }, latest_frozen_membership: null, annotations: [],
    items: definitions.map(([key, responseType, options, value], index) => ({
      id: `item-${key}`, client_item_key: key, parent_item_id: null, item_kind: 'item',
      revision: { id: `revision-${key}`, ordinal: 1, title: key, prompt: `Prompt ${key}`, description: null, response_type: responseType, required: true, position: index, options },
      effective_response: { response_event_id: `event-${key}`, value },
      directive: { key, definition_digest: 'a'.repeat(64), start_offset: index * 10, body_start_offset: index * 10 + 1, body_end_offset: index * 10 + 2, end_offset: index * 10 + 3 },
    })),
  };
}

describe('Briefing v2 UI projection', () => {
  it('normalizes the explicit response capability and fails missing or malformed values closed', () => {
    const base = {
      role: 'preview', operational_mutations: 'reject', operational_mutations_overridden: true,
      db_path: '/tmp/copy.db', db_path_source: 'start_options',
      source_db_path: '/tmp/source.db', source_db_path_source: 'start_options',
    };
    expect(normalizeInstanceInfo({ ...base, briefing_response_mutations: 'allow' })?.briefing_response_mutations).toBe('allow');
    expect(normalizeInstanceInfo({ ...base, briefing_response_mutations: 'reject' })?.briefing_response_mutations).toBe('reject');
    expect(normalizeInstanceInfo(base)?.briefing_response_mutations).toBe('reject');
    expect(normalizeInstanceInfo({ ...base, briefing_response_mutations: 'sometimes' })?.briefing_response_mutations).toBe('reject');
    expect(normalizeInstanceInfo({ ...base, operational_mutations: 'sometimes', briefing_response_mutations: 'allow' })).toBeNull();
  });

  it('accepts the active profile, all six exact values, and backend option order', () => {
    const projection = normalizeBriefingRoundProjection(payload());
    expect(projection.valid).toBe(true);
    expect(projection.document?.profile).toBe('mandible-briefing.v2');
    expect(projection.items.map((item) => item.revision.response_type)).toEqual(definitions.map((entry) => entry[1]));
    expect(projection.items[1].revision.options).toEqual([{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]);
    expect(projection.items.map((item) => item.effective_response?.value)).toEqual(definitions.map((entry) => entry[3]));
  });

  it('fails closed on aliases, invalid values, malformed options, and choice counts outside 2-12', () => {
    const legacy = payload() as any;
    legacy.document.profile = 'mandible-briefing.v1';
    expect(normalizeBriefingRoundProjection(legacy).valid).toBe(false);
    const alias = payload() as any;
    alias.items[3].revision.response_type = 'free_text';
    expect(normalizeBriefingRoundProjection(alias).valid).toBe(false);
    const blank = payload() as any;
    blank.items[3].effective_response.value = { text: ' ' };
    expect(normalizeBriefingRoundProjection(blank).valid).toBe(false);
    const emptyMulti = payload() as any;
    emptyMulti.items[2].effective_response.value = { option_keys: [] };
    expect(normalizeBriefingRoundProjection(emptyMulti).valid).toBe(false);
    const fractional = payload() as any;
    fractional.items[5].effective_response.value = { rating: 1.5 };
    expect(normalizeBriefingRoundProjection(fractional).valid).toBe(false);
    const extraOptionField = payload() as any;
    extraOptionField.items[1].revision.options[0].position = 0;
    expect(normalizeBriefingRoundProjection(extraOptionField).valid).toBe(false);
    const tooFew = payload() as any;
    tooFew.items[1].revision.options = [{ key: 'a', label: 'Alpha' }];
    expect(normalizeBriefingRoundProjection(tooFew).valid).toBe(false);
    const tooMany = payload() as any;
    tooMany.items[1].revision.options = Array.from({ length: 13 }, (_, index) => ({ key: `k${index}`, label: `Option ${index}` }));
    tooMany.items[1].effective_response.value = { option_key: 'k0' };
    expect(normalizeBriefingRoundProjection(tooMany).valid).toBe(false);
  });
});
