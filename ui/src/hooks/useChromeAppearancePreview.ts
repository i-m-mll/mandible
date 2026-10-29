import { useEffect, useRef, useState } from 'preact/hooks';
import {
  CHROME_APPEARANCE_DEFAULTS, CHROME_APPEARANCE_PREVIEW_DEFAULTS, chromeAppearancePreviewKey,
  effectiveChromeAppearances, normalizeChromeAppearance, normalizeChromeAppearancePreview,
  type ChromeAppearanceParameters, type ChromeAppearanceTheme, type ChromeAppearanceThemes,
} from '../chrome-appearance';
import { usePersistedViewState } from './usePersistedViewState';

export type ChromeAppearancePreviewController = {
  theme: ChromeAppearanceTheme;
  themes: ChromeAppearanceThemes;
  persistenceError: string | null;
  liquidGlassAvailable: boolean;
  selectTheme(theme: ChromeAppearanceTheme): void;
  update(parameters: ChromeAppearanceParameters): void;
  reset(): void;
};

export function useChromeAppearancePreview(instance: { role: string; instance_id: string } | null, resolvedTheme: ChromeAppearanceTheme, liquidGlassAvailable = false) {
  const key = chromeAppearancePreviewKey(instance);
  const legacyStorageKey = useRef('');
  const [persistenceResult, setPersistenceResult] = useState<{ key: string; saved: boolean } | null>(null);
  const [state, setState] = usePersistedViewState(key, (value: unknown) => {
    if (key && value && typeof value === 'object' && 'version' in value && value.version === 1) legacyStorageKey.current = key;
    return normalizeChromeAppearancePreview(value);
  }, CHROME_APPEARANCE_PREVIEW_DEFAULTS, undefined,
    (saved) => setPersistenceResult({ key, saved }));
  useEffect(() => {
    if (legacyStorageKey.current !== key || !key) return;
    legacyStorageKey.current = '';
    setState(current => current);
  }, [key]);
  const active = Boolean(key);
  const themes = active ? effectiveChromeAppearances(state) : CHROME_APPEARANCE_DEFAULTS;
  const theme = active ? state.theme ?? resolvedTheme : resolvedTheme;
  const controller: ChromeAppearancePreviewController | null = active ? {
    themes,
    theme,
    liquidGlassAvailable,
    persistenceError: persistenceResult?.key === key && !persistenceResult.saved ? 'Changes could not be saved in this browser.' : null,
    selectTheme: (next) => setState((current) => ({ ...current, theme: next })),
    update: (parameters) => setState((current) => ({ ...current, overrides: { ...current.overrides, [theme]: normalizeChromeAppearance(parameters, CHROME_APPEARANCE_DEFAULTS[theme]) } })),
    reset: () => setState((current) => {
      const overrides = { ...current.overrides };
      delete overrides[theme];
      return { ...current, overrides };
    }),
  } : null;
  return { themes, themeOverride: active ? state.theme : undefined, controller };
}
