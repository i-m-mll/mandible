import { describe, expect, it } from 'vitest';

import {
  APP_RAIL_ORDER_SETTING_KEY,
  DEFAULT_APP_RAIL_ORDER,
  moveAppRailItem,
  normalizeAppRailOrderPreference,
  parseAppRailOrderSetting,
  reconcileAppRailOrder,
  serializeAppRailOrderSetting,
} from '../ui/src/app-rail-order';

describe('app rail order preference', () => {
  it('uses a versioned canonical settings value rather than browser storage', () => {
    expect(APP_RAIL_ORDER_SETTING_KEY).toBe('app_rail_order');
    expect(serializeAppRailOrderSetting({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: ['graph'] },
    })).toBe('{"version":1,"groups":{"primary":["issues","console"],"secondary":["graph"]}}');
  });

  it.each([
    undefined,
    '',
    '{',
    JSON.stringify({ version: 0, groups: { primary: ['issues'], secondary: [] } }),
    JSON.stringify({ version: 1, groups: { primary: 'issues', secondary: [] } }),
    JSON.stringify({ version: 1, groups: { primary: [null], secondary: [] } }),
  ])('fails malformed or old settings closed to canonical order: %s', (raw) => {
    expect(parseAppRailOrderSetting(raw)).toEqual(DEFAULT_APP_RAIL_ORDER);
  });

  it('copies valid values so callers cannot mutate the parsed authority', () => {
    const raw = { version: 1, groups: { primary: ['issues'], secondary: ['graph'] } } as const;
    const normalized = normalizeAppRailOrderPreference(raw);
    normalized.groups.primary.push('console');
    expect(raw.groups.primary).toEqual(['issues']);
  });

  it('preserves saved relative order in canonical slots and ignores unknown or duplicate IDs', () => {
    expect(reconcileAppRailOrder(
      ['console', 'timeline', 'auth', 'issues', 'briefing'],
      ['retired', 'issues', 'console', 'issues'],
    )).toEqual(['issues', 'timeline', 'auth', 'console', 'briefing']);
  });

  it('places a newly added or conditionally returning item in its canonical fallback slot', () => {
    expect(reconcileAppRailOrder(
      ['session', 'console', 'timeline', 'issues'],
      ['issues', 'console', 'unknown'],
    )).toEqual(['session', 'issues', 'timeline', 'console']);
  });

  it('moves only the requested item and leaves missing targets unchanged', () => {
    expect(moveAppRailItem(['console', 'issues', 'briefing'], 'briefing', 'console'))
      .toEqual(['briefing', 'console', 'issues']);
    expect(moveAppRailItem(['console', 'issues'], 'missing', 'console'))
      .toEqual(['console', 'issues']);
  });
});
