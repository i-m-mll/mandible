import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { readPersistedDetail, writePersistedDetail } from '../detail-cache';

type DetailState<T> = {
  key: string | null;
  data: T | null;
  loading: boolean;
  revalidating: boolean;
  error: string | null;
  stale: boolean;
};

export type KeyedAsyncDetail<T> = DetailState<T> & {
  refresh: () => void;
  setData: (next: T | null | ((current: T | null) => T | null)) => void;
};

export function useKeyedAsyncDetail<T>({
  requestKey,
  namespace,
  load,
}: {
  requestKey: string | null;
  namespace: string;
  load: (signal: AbortSignal) => Promise<T>;
}): KeyedAsyncDetail<T> {
  const hydrated = useMemo(
    () => requestKey ? readPersistedDetail<T>(namespace, requestKey) : null,
    [namespace, requestKey],
  );
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<DetailState<T>>(() => ({
    key: requestKey,
    data: hydrated,
    loading: Boolean(requestKey) && !hydrated,
    revalidating: Boolean(requestKey && hydrated),
    error: null,
    stale: Boolean(hydrated),
  }));
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!requestKey) {
      setState({ key: null, data: null, loading: false, revalidating: false, error: null, stale: false });
      return undefined;
    }
    const cached = readPersistedDetail<T>(namespace, requestKey);
    setState((current) => {
      const sameKeyData = current.key === requestKey ? current.data : null;
      const data = sameKeyData ?? cached;
      return {
        key: requestKey,
        data,
        loading: !data,
        revalidating: Boolean(data),
        error: null,
        stale: current.key === requestKey
          ? current.stale || Boolean(cached)
          : Boolean(cached),
      };
    });
    const controller = new AbortController();
    load(controller.signal)
      .then((data) => {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        writePersistedDetail(namespace, requestKey, data);
        setState({ key: requestKey, data, loading: false, revalidating: false, error: null, stale: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        setState((current) => ({
          ...current,
          loading: false,
          revalidating: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => controller.abort();
  }, [load, namespace, nonce, requestKey]);

  const coherentState = state.key === requestKey
    ? state
    : {
        key: requestKey,
        data: hydrated,
        loading: Boolean(requestKey) && !hydrated,
        revalidating: Boolean(requestKey && hydrated),
        error: null,
        stale: Boolean(hydrated),
      };

  const setData = useCallback((next: T | null | ((current: T | null) => T | null)) => {
    setState((current) => {
      if (current.key !== requestKey) return current;
      const data = typeof next === 'function'
        ? (next as (current: T | null) => T | null)(current.data)
        : next;
      if (requestKey && data) writePersistedDetail(namespace, requestKey, data);
      return { ...current, data, stale: false };
    });
  }, [namespace, requestKey]);

  return {
    ...coherentState,
    refresh: () => setNonce((current) => current + 1),
    setData,
  };
}
