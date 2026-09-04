import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

export type AppRightSidebarState = { open: boolean; width: number };
const storageKey = (scope: string) => `mandible_app_right_sidebar:${scope}:v1`;

function normalize(value: unknown, fallback: AppRightSidebarState, minWidth: number, maxWidth: number): AppRightSidebarState {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    open: typeof record.open === 'boolean' ? record.open : fallback.open,
    width: typeof record.width === 'number' && Number.isFinite(record.width)
      ? Math.max(minWidth, Math.min(maxWidth, Math.trunc(record.width)))
      : fallback.width,
  };
}

export function useAppRightSidebarState(
  scope: string,
  fallback: AppRightSidebarState = { open: true, width: 360 },
  options: { minWidth?: number; maxWidth?: number; migrate?: () => Partial<AppRightSidebarState> | null; removeKeys?: readonly string[] } = {},
): [AppRightSidebarState, (patch: Partial<AppRightSidebarState>) => void] {
  const minWidth = options.minWidth ?? 280;
  const maxWidth = options.maxWidth ?? 720;
  const fallbackOpen = fallback.open;
  const fallbackWidth = fallback.width;
  const inputsRef = useRef({ fallback, migrate: options.migrate });
  inputsRef.current = { fallback, migrate: options.migrate };
  const read = useCallback((): AppRightSidebarState => {
    const current = inputsRef.current;
    if (typeof window === 'undefined' || typeof window.localStorage?.getItem !== 'function') return current.fallback;
    try {
      const stored = window.localStorage.getItem(storageKey(scope));
      if (stored !== null) return normalize(JSON.parse(stored), current.fallback, minWidth, maxWidth);
      return normalize(current.migrate?.(), current.fallback, minWidth, maxWidth);
    } catch {
      return current.fallback;
    }
  }, [maxWidth, minWidth, scope]);
  const [stored, setStored] = useState<{ scope: string; value: AppRightSidebarState }>(() => ({ scope, value: read() }));
  const state = useMemo(() => stored.scope === scope ? stored.value : read(), [read, scope, stored]);
  useEffect(() => {
    if (stored.scope !== scope) setStored({ scope, value: state });
  }, [scope, state, stored.scope]);
  useEffect(() => {
    if (stored.scope !== scope) return;
    if (typeof window === 'undefined' || typeof window.localStorage?.setItem !== 'function') return;
    window.localStorage.setItem(storageKey(scope), JSON.stringify(state));
    if (typeof window.localStorage.removeItem === 'function') {
      options.removeKeys?.forEach((key) => window.localStorage.removeItem(key));
    }
  }, [options.removeKeys, scope, state, stored.scope]);
  const update = useCallback((patch: Partial<AppRightSidebarState>) => {
    setStored((current) => {
      const value = current.scope === scope ? current.value : read();
      return { scope, value: normalize({ ...value, ...patch }, { open: fallbackOpen, width: fallbackWidth }, minWidth, maxWidth) };
    });
  }, [fallbackOpen, fallbackWidth, maxWidth, minWidth, read, scope]);
  return [state, update];
}
