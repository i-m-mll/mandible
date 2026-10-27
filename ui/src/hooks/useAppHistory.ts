import { useLayoutEffect, useState } from 'preact/hooks';
import { appHistory, type AppHistoryNavigation } from '../app-history';

export function useAppHistory(): AppHistoryNavigation {
  const history = appHistory();
  const [, setSnapshot] = useState(history.snapshot);
  useLayoutEffect(() => {
    const refresh = () => setSnapshot(history.snapshot());
    const unsubscribe = history.subscribe(refresh);
    refresh();
    return unsubscribe;
  }, [history]);
  return { ...history.snapshot(), back: history.back, forward: history.forward };
}
