import { describe, expect, it } from 'vitest';

import {
  APP_RAIL_ORDER_SETTING_KEY,
  APP_RAIL_PREVIEW_ORDER_STORAGE_KEY,
  DEFAULT_APP_RAIL_ORDER,
  moveAppRailItem,
  normalizeAppRailOrderPreference,
  parseAppRailOrderSetting,
  readAppRailPreviewOrder,
  reconcileAppRailOrder,
  serializeAppRailOrderSetting,
  writeAppRailPreviewOrder,
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

  it('round-trips the canonical preview override envelope through browser-local storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(writeAppRailPreviewOrder(storage, {
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: ['graph'] },
    })).toBe(true);
    expect(values.get(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY))
      .toBe('{"version":1,"groups":{"primary":["issues","console"],"secondary":["graph"]}}');
    expect(readAppRailPreviewOrder(storage)).toEqual({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: ['graph'] },
    });
  });

  it.each([
    '{',
    JSON.stringify({ version: 0, groups: { primary: ['issues'], secondary: [] } }),
    JSON.stringify({ version: 1, groups: { primary: 'issues', secondary: [] } }),
  ])('rejects malformed preview override bytes instead of manufacturing authority: %s', (value) => {
    expect(readAppRailPreviewOrder({ getItem: () => value })).toBeNull();
  });

  it('preserves surviving saved order, filters invalid duplicates, and appends missing IDs', () => {
    expect(reconcileAppRailOrder(
      ['console', 'timeline', 'auth', 'issues', 'briefing'],
      ['retired', 'issues', 'console', 'issues'],
    )).toEqual(['issues', 'console', 'timeline', 'auth', 'briefing']);
  });

  it('appends newly added or conditionally returning items in canonical order', () => {
    expect(reconcileAppRailOrder(
      ['session', 'console', 'timeline', 'issues'],
      ['issues', 'console', 'unknown'],
    )).toEqual(['issues', 'console', 'session', 'timeline']);
  });

  it('filters legacy fixed and unknown IDs without resetting surviving upper order', () => {
    expect(reconcileAppRailOrder(
      ['console', 'timeline', 'work', 'graph', 'tasks'],
      ['logs', 'graph', 'settings', 'console', 'graph', 'unknown'],
    )).toEqual(['graph', 'console', 'timeline', 'work', 'tasks']);
  });

  it('moves only the requested item and leaves missing targets unchanged', () => {
    expect(moveAppRailItem(['console', 'issues', 'briefing'], 'briefing', 'console'))
      .toEqual(['briefing', 'console', 'issues']);
    expect(moveAppRailItem(['console', 'issues'], 'missing', 'console'))
      .toEqual(['console', 'issues']);
  });
});
