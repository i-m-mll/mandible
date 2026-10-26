import { describe, expect, it } from 'vitest';
import {
  CHROME_SHADOW_DEFAULTS, chromeShadowFrameStyles, chromeShadowPreviewKey, chromeShadowSamples,
  effectiveChromeShadows, exportChromeShadows, normalizeChromeShadow, normalizeChromeShadowPreview,
} from '../ui/src/chrome-shadow';

describe('chrome shadow contract', () => {
  it('preserves the measured baseline and the contact and linear endpoints', () => {
    const parameters = { widthPx: 5, profile: 0.5, maxDarkness: 1 };
    expect(chromeShadowSamples(parameters)).toEqual([
      { distancePx: 0, alpha: 1 }, { distancePx: 2.05, alpha: 0.416 },
      { distancePx: 3.8, alpha: 0.144 }, { distancePx: 5, alpha: 0 },
    ]);
    expect(chromeShadowSamples({ ...parameters, profile: 0 })).toEqual([
      { distancePx: 0, alpha: 1 }, { distancePx: 1, alpha: 1 }, { distancePx: 1, alpha: 0 }, { distancePx: 5, alpha: 0 },
    ]);
    expect(chromeShadowSamples({ ...parameters, profile: 1 })).toEqual([{ distancePx: 0, alpha: 1 }, { distancePx: 5, alpha: 0 }]);
    const midpoint = chromeShadowSamples({ ...parameters, profile: 0.25 });
    expect(midpoint.filter(sample => sample.distancePx === 1)).toHaveLength(2);
    expect(midpoint[1]!.alpha - midpoint[2]!.alpha).toBeCloseTo(0.5);
    expect(chromeShadowSamples({ ...parameters, widthPx: 1, profile: 0 })).toEqual([
      { distancePx: 0, alpha: 1 }, { distancePx: 1, alpha: 1 }, { distancePx: 1, alpha: 0 },
    ]);
  });

  it('bounds finite stored parameters and rejects incompatible records', () => {
    expect(normalizeChromeShadow({ widthPx: 99, profile: -1, maxDarkness: NaN }, CHROME_SHADOW_DEFAULTS.light))
      .toEqual({ widthPx: 32, profile: 0, maxDarkness: 0.03 });
    expect(normalizeChromeShadow({ widthPx: 0, profile: Infinity, maxDarkness: 0.12345 }, CHROME_SHADOW_DEFAULTS.dark))
      .toEqual({ widthPx: 1, profile: 0.5, maxDarkness: 0.123 });
    expect(normalizeChromeShadowPreview({ version: 2, theme: 'light', overrides: { light: { widthPx: 9 } } }))
      .toEqual({ version: 1, overrides: {} });
    const state = normalizeChromeShadowPreview({ version: 1, theme: 'invalid', overrides: { light: { widthPx: 8.3 } } });
    expect(effectiveChromeShadows(state)).toEqual({ light: { ...CHROME_SHADOW_DEFAULTS.light, widthPx: 8.25 }, dark: CHROME_SHADOW_DEFAULTS.dark });
    expect(JSON.parse(exportChromeShadows(effectiveChromeShadows(state)))).toEqual({ version: 1, ...effectiveChromeShadows(state) });
  });

  it('uses one outward alpha profile for straight and curved stops', () => {
    const styles = chromeShadowFrameStyles();
    expect(styles['--app-shadow-light-linear']).toBe('rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0.00432) 1.2px, rgba(0, 0, 0, 0.01248) 2.95px, rgba(0, 0, 0, 0.03) 5px');
    expect(styles['--app-shadow-light-radial']).toContain('rgba(0, 0, 0, 0.01248) calc(var(--radius-chat-surface) + 2.05px)');
    expect(styles['--app-shadow-dark-radial']).not.toMatch(/rgba\(0, 0, 0, (?!0\))/);
    for (const widthPx of [1, 5, 32]) for (const profile of [0, 0.25, 0.5, 0.75, 1]) {
      const samples = chromeShadowSamples({ widthPx, profile, maxDarkness: 0.7 });
      expect(samples[0]).toEqual({ distancePx: 0, alpha: 0.7 });
      expect(samples.at(-1)).toEqual({ distancePx: widthPx, alpha: 0 });
      for (let index = 1; index < samples.length; index++) expect(samples[index]!.alpha).toBeLessThanOrEqual(samples[index - 1]!.alpha);
    }
  });

  it('requires the daemon preview role and a stable instance identity', () => {
    for (const role of ['main', 'dev', 'test', 'unknown', '']) expect(chromeShadowPreviewKey({ role, instance_id: 'preview-test' })).toBe('');
    expect(chromeShadowPreviewKey(null)).toBe('');
    expect(chromeShadowPreviewKey({ role: 'preview', instance_id: '' })).toBe('');
    expect(chromeShadowPreviewKey({ role: 'preview', instance_id: 'preview-test' })).toBe('mandible.chrome-shadow-preview.v1:preview-test');
  });
});
