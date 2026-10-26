import { useState } from 'preact/hooks';
import {
  CHROME_SHADOW_DEFAULTS, CHROME_SHADOW_PREVIEW_DEFAULTS, chromeShadowPreviewKey,
  effectiveChromeShadows, normalizeChromeShadow, normalizeChromeShadowPreview,
  type ChromeShadowParameters, type ChromeShadowTheme, type ChromeShadowThemes,
} from '../chrome-shadow';
import { usePersistedViewState } from './usePersistedViewState';

export type ChromeShadowPreviewController = {
  theme: ChromeShadowTheme;
  themes: ChromeShadowThemes;
  persistenceError: string | null;
  selectTheme(theme: ChromeShadowTheme): void;
  update(parameters: ChromeShadowParameters): void;
  reset(): void;
};

export function useChromeShadowPreview(instance: { role: string; instance_id: string } | null, resolvedTheme: ChromeShadowTheme) {
  const key = chromeShadowPreviewKey(instance);
  const [persistenceResult, setPersistenceResult] = useState<{ key: string; saved: boolean } | null>(null);
  const [state, setState] = usePersistedViewState(key, normalizeChromeShadowPreview, CHROME_SHADOW_PREVIEW_DEFAULTS, undefined,
    (saved) => setPersistenceResult({ key, saved }));
  const active = Boolean(key);
  const themes = active ? effectiveChromeShadows(state) : CHROME_SHADOW_DEFAULTS;
  const theme = active ? state.theme ?? resolvedTheme : resolvedTheme;
  const controller: ChromeShadowPreviewController | null = active ? {
    themes,
    theme,
    persistenceError: persistenceResult?.key === key && !persistenceResult.saved ? 'Changes could not be saved in this browser.' : null,
    selectTheme: (next) => setState((current) => ({ ...current, theme: next })),
    update: (parameters) => setState((current) => ({ ...current, overrides: { ...current.overrides, [theme]: normalizeChromeShadow(parameters, CHROME_SHADOW_DEFAULTS[theme]) } })),
    reset: () => setState((current) => {
      const overrides = { ...current.overrides };
      delete overrides[theme];
      return { ...current, overrides };
    }),
  } : null;
  return { themes, themeOverride: active ? state.theme : undefined, controller };
}
