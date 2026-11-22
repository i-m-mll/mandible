import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { normalizeInstanceInfo, reportDesktopDashboardFrame, reportDesktopStartupTrace, sameInstanceInfo } from '../api';
import { readBootInstanceInfo, servedStartupEpoch, servedUiAssetRevision } from '../boot-instance';
import { getClientAccessState, retryClientAccess } from '../client-auth-token';
import {
  monitorDaemonConnection,
  OUTAGE_INDICATOR_DELAY_MS,
  type DaemonConnection,
  type DaemonOutage,
} from '../daemon-readiness';

const OUTAGE_KEY = 'mandible:reloading-outage';

function readReloadingOutage(): DaemonOutage | undefined {
  try {
    const raw = sessionStorage.getItem(OUTAGE_KEY);
    return raw ? JSON.parse(raw) as DaemonOutage : undefined;
  } catch {
    return undefined;
  }
}

function persistReloadingOutage(outage: DaemonOutage | undefined): void {
  try {
    if (outage) sessionStorage.setItem(OUTAGE_KEY, JSON.stringify(outage));
    else sessionStorage.removeItem(OUTAGE_KEY);
  } catch {
    // Restarts work with browser storage disabled. Only cross-reload timing is lost.
  }
}

function traceOutage(
  phase: 'web_outage_started' | 'web_outage_ready',
  outage: DaemonOutage,
  startupEpoch = outage.startupEpoch,
): void {
  const detail = { phase, atMs: Date.now(), startupEpoch, requestId: outage.requestId };
  performance.mark?.(phase, { detail });
  reportDesktopStartupTrace(detail);
}

function sameReadyConnection(current: DaemonConnection, next: DaemonConnection): boolean {
  if (current.phase !== 'ready' || next.phase !== 'ready') return false;
  const a = current.health;
  const b = next.health;
  return a.startup_epoch === b.startup_epoch
    && a.warm === b.warm
    && a.rebuild_failure?.failed_at === b.rebuild_failure?.failed_at
    && a.rebuild_failure?.message === b.rebuild_failure?.message
    && sameInstanceInfo(normalizeInstanceInfo(a.instance), normalizeInstanceInfo(b.instance));
}

export function useDashboardConnection() {
  const [initialOutage] = useState(readReloadingOutage);
  const [connection, setConnection] = useState<DaemonConnection>(() => initialOutage
    ? { phase: 'outage', outage: initialOutage }
    : { phase: 'starting' });
  const monitor = useRef<ReturnType<typeof monitorDaemonConnection> | null>(null);
  useEffect(() => {
    let confirmedReady = false;
    const current = monitorDaemonConnection({
      instanceId: readBootInstanceInfo()?.instance_id,
      assetRevision: servedUiAssetRevision(),
      initialOutage,
      async readHealth(signal) {
        const response = await fetch('/api/health', { cache: 'no-store', signal });
        return response.ok ? response.json() : null;
      },
      onConnection(next) {
        setConnection(current => sameReadyConnection(current, next) ? current : next);
        if (next.phase === 'outage') confirmedReady = false;
        if (next.phase === 'ready' && !confirmedReady) {
          confirmedReady = true;
          if (getClientAccessState().phase === 'failed') void retryClientAccess();
        }
      },
      reload(outage) {
        persistReloadingOutage(outage);
        window.location.reload();
      },
    });
    monitor.current = current;
    window.addEventListener('online', current.wake);
    document.addEventListener('visibilitychange', current.wake);
    return () => {
      current.stop();
      monitor.current = null;
      window.removeEventListener('online', current.wake);
      document.removeEventListener('visibilitychange', current.wake);
    };
  }, [initialOutage]);

  const outage = connection.phase === 'outage' ? connection.outage : undefined;
  const [indicator, setIndicator] = useState(false);
  useEffect(() => {
    if (!outage) {
      setIndicator(false);
      return;
    }
    const delay = Math.max(0, OUTAGE_INDICATOR_DELAY_MS - (Date.now() - outage.startedAtMs));
    const timer = setTimeout(() => setIndicator(true), delay);
    return () => clearTimeout(timer);
  }, [outage]);

  const observedOutage = useRef(initialOutage);
  useLayoutEffect(() => {
    if (!outage || observedOutage.current === outage) return;
    observedOutage.current = outage;
    traceOutage('web_outage_started', outage);
  }, [outage]);

  return { connection, monitor, observedOutage, outageIndicator: Boolean(outage && indicator) };
}

export function useDashboardStartupFrame(
  canShowDashboard: boolean,
  startupEpoch: string | undefined,
  observedOutage: { current: DaemonOutage | undefined },
): void {
  const [styled, setStyled] = useState(() => {
    const sheet = document.getElementById('mandible-dashboard-css') as HTMLLinkElement | null;
    return sheet === null || sheet.media === 'all';
  });
  useEffect(() => {
    if (styled) return;
    const sheet = document.getElementById('mandible-dashboard-css') as HTMLLinkElement | null;
    const loaded = () => setStyled(true);
    if (!sheet || sheet.media === 'all') loaded();
    else sheet.addEventListener('load', loaded, { once: true });
    return () => sheet?.removeEventListener('load', loaded);
  }, [styled]);

  const revealed = useRef(false);
  useLayoutEffect(() => {
    if (!canShowDashboard || !styled) return;
    if (observedOutage.current) {
      traceOutage('web_outage_ready', observedOutage.current, startupEpoch);
      observedOutage.current = undefined;
      persistReloadingOutage(undefined);
    }
    if (revealed.current) return;
    const frame = document.getElementById('mandible-startup-frame');
    if (frame) frame.hidden = true;
    revealed.current = true;
    const epoch = startupEpoch ?? servedStartupEpoch();
    document.getElementById('app')?.getBoundingClientRect();
    void reportDesktopDashboardFrame('ready', epoch).then(() => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        void reportDesktopDashboardFrame('painted', epoch);
      }));
    });
  }, [canShowDashboard, styled, startupEpoch, observedOutage]);
}
