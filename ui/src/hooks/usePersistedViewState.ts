import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Dispatch, StateUpdater } from 'preact/hooks';

export type PersistedViewStateNormalizer<T> = (
  value: unknown,
  defaults: Readonly<T>,
) => T;

type LoadedState<T> = {
  storageKey: string;
  value: T;
  serialized: string | null;
};

type KeyedState<T> = {
  storageKey: string;
  value: T;
};

function serialize(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function normalizeOrDefault<T>(
  value: unknown,
  normalize: PersistedViewStateNormalizer<T>,
  defaults: T,
): T {
  try {
    return normalize(value, defaults);
  } catch {
    try {
      return normalize(defaults, defaults);
    } catch {
      return defaults;
    }
  }
}

function loadState<T>(
  storageKey: string,
  normalize: PersistedViewStateNormalizer<T>,
  defaults: T,
): LoadedState<T> {
  const fallback = () => normalizeOrDefault(defaults, normalize, defaults);
  let value: T;

  try {
    if (!storageKey || typeof window === 'undefined') {
      value = fallback();
    } else {
      const stored = window.localStorage.getItem(storageKey);
      value = stored === null
        ? fallback()
        : normalizeOrDefault(JSON.parse(stored), normalize, defaults);
    }
  } catch {
    value = fallback();
  }

  return { storageKey, value, serialized: serialize(value) };
}

/** Synchronously flush browser-local intent, including before page navigation. */
export function writePersistedViewState(storageKey: string, value: unknown): boolean {
  const serialized = serialize(value);
  if (!storageKey || typeof window === 'undefined' || serialized === null) return false;
  try {
    window.localStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}

/** Read the same normalized browser-local state used by the hook without writing it back. */
export function readPersistedViewState<T>(
  storageKey: string,
  normalize: PersistedViewStateNormalizer<T>,
  defaults: T,
): T {
  return loadState(storageKey, normalize, defaults).value;
}

/**
 * Persist browser-local view state without coupling it to backend data flow.
 *
 * Stored JSON is treated as untrusted and passed through `normalize`. The
 * normalizer receives `defaults` so it can fill missing or invalid fields. A
 * storage key is read only when it becomes active, and initialization never
 * rewrites storage merely to persist the normalized/default value.
 */
export function usePersistedViewState<T>(
  storageKey: string,
  normalize: PersistedViewStateNormalizer<T>,
  defaults: T,
): [T, Dispatch<StateUpdater<T>>] {
  const normalizeRef = useRef(normalize);
  const defaultsRef = useRef(defaults);
  normalizeRef.current = normalize;
  defaultsRef.current = defaults;

  const loadedRef = useRef<LoadedState<T> | null>(null);
  if (loadedRef.current?.storageKey !== storageKey) {
    loadedRef.current = loadState(
      storageKey,
      normalizeRef.current,
      defaultsRef.current,
    );
  }
  const loaded = loadedRef.current;

  const [keyedState, setKeyedState] = useState<KeyedState<T>>(() => ({
    storageKey,
    value: loaded.value,
  }));

  const persistedRef = useRef({
    storageKey,
    serialized: loaded.serialized,
  });
  if (persistedRef.current.storageKey !== storageKey) {
    persistedRef.current = {
      storageKey,
      serialized: loaded.serialized,
    };
  }

  // Synchronize the keyed state after render. Until then, return the newly
  // loaded value below so callers never observe state belonging to another key.
  useEffect(() => {
    setKeyedState((current) => (
      current.storageKey === storageKey
        ? current
        : { storageKey, value: loadedRef.current!.value }
    ));
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || keyedState.storageKey !== storageKey) return;

    const serialized = serialize(keyedState.value);
    if (serialized === null || serialized === persistedRef.current.serialized) return;

    if (writePersistedViewState(storageKey, keyedState.value)) {
      persistedRef.current = { storageKey, serialized };
    }
  }, [keyedState, storageKey]);

  const setState = useCallback<Dispatch<StateUpdater<T>>>((next) => {
    setKeyedState((current) => {
      const base = current.storageKey === storageKey
        ? current.value
        : loadedRef.current!.value;
      const value = typeof next === 'function'
        ? (next as (previous: T) => T)(base)
        : next;
      return { storageKey, value };
    });
  }, [storageKey]);

  const value = keyedState.storageKey === storageKey
    ? keyedState.value
    : loaded.value;
  return [value, setState];
}
