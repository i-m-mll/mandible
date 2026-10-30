import { describe, expect, it } from 'vitest';
import {
  CHROME_APPEARANCE_DEFAULTS, chromeAppearancePreviewKey, chromeShadowSamples,
  effectiveChromeAppearances, exportChromeAppearances, normalizeChromeAppearance, normalizeChromeAppearancePreview,
} from '../ui/src/chrome-appearance';

describe('chrome shadow contract', () => {
  it('bounds finite stored parameters and rejects incompatible records', () => {
    expect(normalizeChromeAppearance({ widthPx: 99, profile: -1, maxDarkness: NaN }, CHROME_APPEARANCE_DEFAULTS.light))
      .toMatchObject({ widthPx: 32, profile: 0 });
    expect(normalizeChromeAppearance({ widthPx: 0, profile: Infinity, maxDarkness: 0.12345 }, CHROME_APPEARANCE_DEFAULTS.dark))
      .toMatchObject({ widthPx: 1, maxDarkness: 0.123 });
    expect(normalizeChromeAppearancePreview({ version: 3, theme: 'light', overrides: { light: { widthPx: 9 } } }))
      .toEqual({ version: 2, overrides: {} });
    const state = normalizeChromeAppearancePreview({ version: 1, theme: 'invalid', overrides: { light: { widthPx: 8.3 } } });
    expect(effectiveChromeAppearances(state)).toEqual({ light: { ...CHROME_APPEARANCE_DEFAULTS.light, widthPx: 8.25 }, dark: CHROME_APPEARANCE_DEFAULTS.dark });
    expect(JSON.parse(exportChromeAppearances(effectiveChromeAppearances(state)))).toEqual({ version: 2, ...effectiveChromeAppearances(state) });
    const priorRecord = normalizeChromeAppearancePreview({ version: 1, theme: 'dark', overrides: { dark: { widthPx: 12, profile: 1, maxDarkness: 0.42 } } });
    expect(priorRecord).toMatchObject({ version: 2, theme: 'dark', overrides: { dark: { widthPx: 12, profile: 1, maxDarkness: 0.42 } } });
    expect(normalizeChromeAppearancePreview({ version: 1, overrides: { light: { glassTransparency: 0.28 } } }).overrides.light?.glassTransparency).toBe(0.28);
    expect(normalizeChromeAppearance({ glassTransparency: Infinity }, CHROME_APPEARANCE_DEFAULTS.light).glassTransparency).toBe(0.12);
    expect(normalizeChromeAppearance({ glassTransparency: 2 }, CHROME_APPEARANCE_DEFAULTS.light).glassTransparency).toBe(1);
    expect(normalizeChromeAppearance({ glassTransparency: -1 }, CHROME_APPEARANCE_DEFAULTS.light).glassTransparency).toBe(0);
    expect(normalizeChromeAppearance({ glassTransparency: 0.456 }, CHROME_APPEARANCE_DEFAULTS.light).glassTransparency).toBe(0.46);
  });

  it('keeps shadow opacity finite, monotone, and bounded by its endpoints', () => {
    for (const widthPx of [1, 5, 32]) for (const profile of [0, 0.25, 0.5, 0.75, 1]) {
      const samples = chromeShadowSamples({ widthPx, profile, maxDarkness: 0.7 });
      expect(samples[0]).toEqual({ distancePx: 0, alpha: 0.7 });
      expect(samples.at(-1)).toEqual({ distancePx: widthPx, alpha: 0 });
      for (let index = 1; index < samples.length; index++) expect(samples[index]!.alpha).toBeLessThanOrEqual(samples[index - 1]!.alpha);
    }
  });

  it('requires the daemon preview role and a stable instance identity', () => {
    for (const role of ['main', 'dev', 'test', 'unknown', '']) expect(chromeAppearancePreviewKey({ role, instance_id: 'preview-test' })).toBe('');
    expect(chromeAppearancePreviewKey(null)).toBe('');
    expect(chromeAppearancePreviewKey({ role: 'preview', instance_id: '' })).toBe('');
    expect(chromeAppearancePreviewKey({ role: 'preview', instance_id: 'preview-test' })).toBeTruthy();
  });
});
