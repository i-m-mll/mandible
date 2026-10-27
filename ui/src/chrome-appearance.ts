export type ChromeAppearanceTheme = 'light' | 'dark';
export type ChromeAppearanceParameters = { widthPx: number; profile: number; maxDarkness: number; glassTransparency: number };
export type ChromeShadowParameters = Pick<ChromeAppearanceParameters, 'widthPx' | 'profile' | 'maxDarkness'>;
export type ChromeAppearanceThemes = Record<ChromeAppearanceTheme, ChromeAppearanceParameters>;
export type ChromeAppearancePreviewState = {
  version: 1;
  overrides: Partial<ChromeAppearanceThemes>;
  theme?: ChromeAppearanceTheme;
};

export const CHROME_APPEARANCE_DEFAULTS: Readonly<ChromeAppearanceThemes> = {
  light: { widthPx: 16, profile: 0.25, maxDarkness: 0.04, glassTransparency: 0.12 },
  dark: { widthPx: 5, profile: 0.5, maxDarkness: 0, glassTransparency: 0.12 },
};
export const CHROME_APPEARANCE_PREVIEW_DEFAULTS: ChromeAppearancePreviewState = { version: 1, overrides: {} };
export const CHROME_APPEARANCE_LIMITS = {
  widthPx: { min: 1, max: 32, step: 0.25 },
  profile: { min: 0, max: 1, step: 0.01 },
  maxDarkness: { min: 0, max: 1, step: 0.001 },
  glassTransparency: { min: 0, max: 1, step: 0.01 },
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeChromeAppearance(value: unknown, defaults: ChromeAppearanceParameters): ChromeAppearanceParameters {
  const source = record(value);
  const result = { ...defaults };
  for (const key of Object.keys(CHROME_APPEARANCE_LIMITS) as (keyof ChromeAppearanceParameters)[]) {
    const input = source?.[key];
    if (typeof input !== 'number' || !Number.isFinite(input)) continue;
    const { min, max, step } = CHROME_APPEARANCE_LIMITS[key];
    result[key] = Number((Math.round(Math.min(max, Math.max(min, input)) / step) * step).toFixed(6));
  }
  return result;
}

export function normalizeChromeAppearancePreview(value: unknown): ChromeAppearancePreviewState {
  const source = record(value);
  if (source?.version !== 1) return CHROME_APPEARANCE_PREVIEW_DEFAULTS;
  const overrides = record(source.overrides);
  const result: ChromeAppearancePreviewState = { version: 1, overrides: {} };
  for (const theme of ['light', 'dark'] as const) {
    if (record(overrides?.[theme])) result.overrides[theme] = normalizeChromeAppearance(overrides![theme], CHROME_APPEARANCE_DEFAULTS[theme]);
  }
  if (source.theme === 'light' || source.theme === 'dark') result.theme = source.theme;
  return result;
}

export function effectiveChromeAppearances(state: ChromeAppearancePreviewState): ChromeAppearanceThemes {
  return { light: state.overrides.light ?? CHROME_APPEARANCE_DEFAULTS.light, dark: state.overrides.dark ?? CHROME_APPEARANCE_DEFAULTS.dark };
}

export function chromeAppearancePreviewKey(instance: { role: string; instance_id: string } | null): string {
  return instance?.role === 'preview' && instance.instance_id ? `mandible.chrome-shadow-preview.v1:${instance.instance_id}` : '';
}

export type ChromeShadowSample = { distancePx: number; alpha: number };
const BASELINE = [[0, 1], [0.41, 0.416], [0.76, 0.144], [1, 0]] as const;

function baselineFactor(position: number): number {
  const knot = BASELINE.find(([distance]) => distance === position);
  if (knot) return knot[1];
  for (let i = 1; i < BASELINE.length; i++) {
    const [end, endAlpha] = BASELINE[i]!;
    const [start, startAlpha] = BASELINE[i - 1]!;
    if (position <= end) return startAlpha + (endAlpha - startAlpha) * (position - start) / (end - start);
  }
  return 0;
}

/** Outward distance from the workspace wall, shared by straight and curved paint. */
export function chromeShadowSamples(parameters: ChromeShadowParameters): ChromeShadowSample[] {
  const { widthPx: width, profile, maxDarkness } = parameters;
  const contactWeight = Math.max(0, 1 - 2 * profile);
  const linearWeight = Math.max(0, 2 * profile - 1);
  const baselineWeight = 1 - contactWeight - linearWeight;
  const positions = new Set([0, width]);
  if (baselineWeight > 0) for (const [position] of BASELINE) positions.add(position * width);
  if (contactWeight > 0) positions.add(1);
  const samples: ChromeShadowSample[] = [];
  for (const distancePx of [...positions].sort((a, b) => a - b)) {
    const factor = baselineWeight * baselineFactor(distancePx / width) + linearWeight * (1 - distancePx / width);
    const alpha = maxDarkness * (factor + (distancePx <= 1 ? contactWeight : 0));
    samples.push({ distancePx, alpha });
    if (distancePx === 1 && contactWeight > 0) samples.push({ distancePx, alpha: maxDarkness * factor });
  }
  return samples;
}

const number = (value: number) => String(Number(value.toFixed(8)));
const color = (alpha: number) => `rgba(0, 0, 0, ${number(alpha)})`;

export function chromeAppearanceFrameStyles(themes: Readonly<ChromeAppearanceThemes> = CHROME_APPEARANCE_DEFAULTS): Record<string, string> {
  const styles: Record<string, string> = {};
  for (const theme of ['light', 'dark'] as const) {
    const parameters = themes[theme];
    const samples = chromeShadowSamples(parameters);
    styles[`--app-chrome-${theme}-tint-percentage`] = `${number((1 - parameters.glassTransparency) * 100)}%`;
    styles[`--app-shadow-${theme}-width`] = `${number(parameters.widthPx)}px`;
    styles[`--app-shadow-${theme}-linear`] = [...samples].reverse().map(({ distancePx, alpha }) => `${color(alpha)} ${number(parameters.widthPx - distancePx)}px`).join(', ');
    styles[`--app-shadow-${theme}-radial`] = `transparent var(--radius-chat-surface), ${samples.map(({ distancePx, alpha }) => `${color(alpha)} calc(var(--radius-chat-surface) + ${number(distancePx)}px)`).join(', ')}`;
  }
  return styles;
}

export function exportChromeAppearances(themes: ChromeAppearanceThemes): string {
  return JSON.stringify({ version: 1, ...themes });
}
