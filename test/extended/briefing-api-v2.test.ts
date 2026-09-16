import { describe, expect, it } from 'vitest';

import { normalizeBriefingRoundProjection, normalizeInstanceInfo } from '../../ui/src/api';

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
    document: {
      artifact_version_id: 'artifact-version-1', content_hash: 'b'.repeat(64), previous_round_id: null,
      profile: 'mandible-briefing.v2', source: 'Exact verified source',
    },
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
  it('normalizes the typed instance effect ceiling and fails missing or malformed values closed', () => {
    const base = {
      role: 'preview', instance_id: 'preview-test', installation_id: 'test-installation',
      public_origin: 'https://preview-test.mandible.localhost:19421', backend_generation: 'test',
      writable_roots: ['/tmp/preview'],
      db_path: '/tmp/copy.db', db_path_source: 'start_options',
      source_db_path: '/tmp/source.db', source_db_path_source: 'start_options',
    };
    expect(normalizeInstanceInfo({ ...base, allowed_effects: ['ledger:read', 'ledger:write', 'files:preview'] })?.allowed_effects)
      .toEqual(['ledger:read', 'ledger:write', 'files:preview']);
    expect(normalizeInstanceInfo(base)).toBeNull();
    expect(normalizeInstanceInfo({ ...base, allowed_effects: ['ledger:read', 42] })).toBeNull();
  });

  it('accepts the active profile, all six exact values, and backend option order', () => {
    const projection = normalizeBriefingRoundProjection(payload());
    expect(projection.valid).toBe(true);
    expect(projection.document).toMatchObject({
      profile: 'mandible-briefing.v2', source: 'Exact verified source', content_hash: 'b'.repeat(64),
    });
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

  it.each([
    ['missing source', (document: any) => { delete document.source; }],
    ['non-string source', (document: any) => { document.source = 42; }],
    ['missing hash', (document: any) => { delete document.content_hash; }],
    ['malformed hash', (document: any) => { document.content_hash = 'not-a-sha256'; }],
    ['extra document field', (document: any) => { document.local_only = true; }],
  ])('fails closed on %s', (_label, mutate) => {
    const invalid = payload() as any;
    mutate(invalid.document);
    const projection = normalizeBriefingRoundProjection(invalid);
    expect(projection.valid).toBe(false);
    expect(projection.document).toBeNull();
  });
});
