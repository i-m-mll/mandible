import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { beginDetailRequest, isDetailRequestCurrent, isPersistedDetailFresh, readPersistedDetail, writePersistedDetail, type LiveDetailNamespace } from '../detail-cache';

type DetailState<T> = {
  key: string | null;
  data: T | null;
  loading: boolean;
  revalidating: boolean;
  error: string | null;
  failure: unknown;
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
  accept,
}: {
  requestKey: string | null;
  namespace: LiveDetailNamespace;
  load: (signal: AbortSignal) => Promise<T>;
  accept?: (data: T) => boolean;
}): KeyedAsyncDetail<T> {
  const hydrated = useMemo(
    () => {
      const cached = requestKey ? readPersistedDetail<T>(namespace, requestKey) : null;
      return cached && (!accept || accept(cached)) ? cached : null;
    },
    [accept, namespace, requestKey],
  );
  const hydratedState = (): DetailState<T> => {
    const fresh = Boolean(requestKey && hydrated && isPersistedDetailFresh(namespace, requestKey));
    return {
      key: requestKey,
      data: hydrated,
      loading: Boolean(requestKey) && !hydrated,
      revalidating: Boolean(requestKey && hydrated) && !fresh,
      error: null,
      failure: null,
      stale: Boolean(hydrated) && !fresh,
    };
  };
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<DetailState<T>>(hydratedState);
  const generationRef = useRef(0);
  const loadedNonceRef = useRef(nonce);

  useLayoutEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!requestKey) {
      setState({ key: null, data: null, loading: false, revalidating: false, error: null, failure: null, stale: false });
      return undefined;
    }
    const persisted = readPersistedDetail<T>(namespace, requestKey);
    const cached = persisted && (!accept || accept(persisted)) ? persisted : null;
    const refreshRequested = loadedNonceRef.current !== nonce;
    loadedNonceRef.current = nonce;
    if (cached && !refreshRequested && isPersistedDetailFresh(namespace, requestKey)) {
      setState({ key: requestKey, data: cached, loading: false, revalidating: false, error: null, failure: null, stale: false });
      return undefined;
    }
    setState((current) => {
      const sameKeyData = current.key === requestKey ? current.data : null;
      const data = sameKeyData ?? cached;
      return {
        key: requestKey,
        data,
        loading: !data,
        revalidating: Boolean(data),
        error: null,
        failure: null,
        stale: current.key === requestKey
          ? current.stale || Boolean(cached)
          : Boolean(cached),
      };
    });
    const controller = new AbortController();
    const requestStarted = beginDetailRequest();
    load(controller.signal)
      .then((data) => {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        if (accept && !accept(data)) {
          setState((current) => ({ ...current, loading: false, revalidating: false }));
          return;
        }
        if (!isDetailRequestCurrent(namespace, requestKey, requestStarted)) {
          const current = readPersistedDetail<T>(namespace, requestKey);
          if (current && (!accept || accept(current)) && isPersistedDetailFresh(namespace, requestKey)) {
            setState({ key: requestKey, data: current, loading: false, revalidating: false, error: null, failure: null, stale: false });
          } else {
            setNonce((current) => current + 1);
          }
          return;
        }
        writePersistedDetail(namespace, requestKey, data, undefined, requestStarted);
        setState({ key: requestKey, data, loading: false, revalidating: false, error: null, failure: null, stale: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        setState((current) => ({
          ...current,
          loading: false,
          revalidating: false,
          error: error instanceof Error ? error.message : String(error),
          failure: error,
        }));
      });
    return () => controller.abort();
  }, [accept, load, namespace, nonce, requestKey]);

  const coherentState = state.key === requestKey ? state : hydratedState();

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
