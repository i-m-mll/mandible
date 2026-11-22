import { useLayoutEffect, useState } from 'preact/hooks';
import { appHistory, type AppHistoryNavigation } from '../app-history';
import { reportDesktopDashboardRoute } from '../api';

export function useAppHistory(): AppHistoryNavigation {
  const history = appHistory();
  const [, setSnapshot] = useState(history.snapshot);
  const snapshot = history.snapshot();
  useLayoutEffect(() => {
    const refresh = () => setSnapshot(history.snapshot());
    const unsubscribe = history.subscribe(refresh);
    refresh();
    return unsubscribe;
  }, [history]);
  useLayoutEffect(() => reportDesktopDashboardRoute(snapshot.href), [snapshot.href]);
  return { ...snapshot, back: history.back, forward: history.forward };
}
