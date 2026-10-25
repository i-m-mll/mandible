import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import {
  ApiError,
  getSidebarOrderPreference,
  isApiErrorStatus,
  updateSidebarOrderPreference,
  type SidebarOrderPreference,
  type SidebarOrderPreferenceValue,
} from '../api';
import { subscribeClientAccessState } from '../client-auth-token';

export const EMPTY_SIDEBAR_ORDER: SidebarOrderPreferenceValue = {
  pinnedConversationIds: null,
  briefingTopLevelIds: null,
};

export function useSidebarOrderPreference() {
  const [value, setValue] = useState<SidebarOrderPreferenceValue>(EMPTY_SIDEBAR_ORDER);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const durableRef = useRef(value);
  const valueRef = useRef(value);
  const queueRef = useRef(Promise.resolve());
  const requestRef = useRef(0);
  const intentRef = useRef(0);
  const authEpochRef = useRef(0);
  const pendingWritesRef = useRef(0);
  valueRef.current = value;

  const firstLoadRef = useRef(true);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const intent = intentRef.current;
    const authEpoch = authEpochRef.current;
    const warm = firstLoadRef.current;
    firstLoadRef.current = false;
    const show = (snapshot: SidebarOrderPreference) => {
      if (request !== requestRef.current
          || intent !== intentRef.current
          || authEpoch !== authEpochRef.current
          || pendingWritesRef.current > 0
          || snapshot.revision < revisionRef.current) return;
      const next = snapshot.value;
      revisionRef.current = snapshot.revision;
      durableRef.current = next;
      valueRef.current = next;
      setValue(next);
      setReady(true);
      setNotice(null);
    };
    try {
      show(await getSidebarOrderPreference({ warm, onCached: warm ? show : undefined }));
    } catch (error) {
      if (request !== requestRef.current || authEpoch !== authEpochRef.current || pendingWritesRef.current > 0) return;
      setReady(false);
      if (error instanceof ApiError && error.code === 'local_access_unavailable') {
        setNotice(null);
        return;
      }
      setNotice(isApiErrorStatus(error, 401) || isApiErrorStatus(error, 403)
        ? 'Sidebar order is unavailable until local access recovers.'
        : 'Sidebar order is unavailable. It will retry when Mandible reconnects.');
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const unsubscribe = subscribeClientAccessState((state) => {
      authEpochRef.current += 1;
      requestRef.current += 1;
      if (state.phase === 'ready') {
        void queueRef.current.finally(() => load());
        return;
      }
      // Recovery is not a reset. Retain both the last confirmed server order
      // and any optimistic intent until the pending write settles.
      setReady(false);
      setNotice(null);
    });
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const patch = useCallback((change: Partial<SidebarOrderPreferenceValue>) => {
    if (!ready) return;
    intentRef.current += 1;
    pendingWritesRef.current += 1;
    const authEpoch = authEpochRef.current;
    const optimistic = { ...valueRef.current, ...change };
    valueRef.current = optimistic;
    setValue(optimistic);
    queueRef.current = queueRef.current.catch(() => undefined).then(async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (authEpoch !== authEpochRef.current) return;
          const next = { ...valueRef.current, ...change };
          try {
            const snapshot = await updateSidebarOrderPreference(next, revisionRef.current);
            if (authEpoch !== authEpochRef.current) return;
            revisionRef.current = snapshot.revision;
            durableRef.current = snapshot.value;
            valueRef.current = snapshot.value;
            setValue(valueRef.current);
            setReady(true);
            setNotice(null);
            return;
          } catch (error) {
            if (!isApiErrorStatus(error, 409) || attempt > 0) {
              if (authEpoch !== authEpochRef.current) return;
              valueRef.current = durableRef.current;
              setValue(durableRef.current);
              setNotice(error instanceof ApiError && error.code === 'local_access_unavailable'
                ? null : 'Sidebar order was not saved. Reload to recover the durable order.');
              return;
            }
            try {
              const current = await getSidebarOrderPreference();
              if (authEpoch !== authEpochRef.current) return;
              revisionRef.current = current.revision;
              durableRef.current = current.value;
              valueRef.current = { ...current.value, ...change };
              setValue(valueRef.current);
            } catch {
              if (authEpoch !== authEpochRef.current) return;
              valueRef.current = durableRef.current;
              setValue(durableRef.current);
              setNotice('Sidebar order conflict recovery failed. Reload to retry.');
              return;
            }
          }
        }
      } finally {
        pendingWritesRef.current -= 1;
      }
    });
  }, [ready]);

  return { value, ready, notice, patch, reload: load };
}
