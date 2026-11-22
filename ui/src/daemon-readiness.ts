import type { HealthResponse } from '../../src/types';

export type DaemonHealthSnapshot = Partial<HealthResponse>;

export type DaemonOutage = {
  startedAtMs: number;
  startupEpoch?: string;
  requestId?: string;
};

export type DaemonConnection =
  | { phase: 'starting' }
  | { phase: 'ready'; health: DaemonHealthSnapshot }
  | { phase: 'outage'; outage: DaemonOutage };

type MonitorOptions = {
  instanceId: string | undefined;
  assetRevision: string | undefined;
  readHealth(signal: AbortSignal): Promise<DaemonHealthSnapshot | null>;
  onConnection(connection: DaemonConnection): void;
  reload(outage: DaemonOutage | undefined): void;
  initialOutage?: DaemonOutage;
};

const HEALTHY_POLL_MS = 5_000;
const FIRST_RETRY_MS = 100;
const MAX_RETRY_MS = 750;
const PROBE_TIMEOUT_MS = 1_000;
export const OUTAGE_INDICATOR_DELAY_MS = 700;

/** One probe at a time. SSE supplies the exit edge and wakes the health probe on loss or reconnection. */
export function monitorDaemonConnection({
  instanceId, assetRevision, readHealth, onConnection, reload, initialOutage,
}: MonitorOptions) {
  let expectedInstance = instanceId;
  let outage = initialOutage;
  let readyEpoch: string | undefined;
  let hasServed = false;
  let transportDown = false;
  let exitingEpoch: string | undefined;
  let retryMs = FIRST_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let wakePending = false;
  let stopped = false;

  function enterOutage(requestId?: string) {
    if (!hasServed || outage) return;
    outage = { startedAtMs: Date.now(), startupEpoch: readyEpoch, requestId };
    onConnection({ phase: 'outage', outage });
  }

  function schedule(delay: number) {
    clearTimeout(timer);
    timer = setTimeout(() => void probe(), delay);
  }

  async function probe() {
    if (stopped || active) return;
    wakePending = false;
    const request = new AbortController();
    active = request;
    const timeout = setTimeout(() => request.abort(), PROBE_TIMEOUT_MS);
    let health: DaemonHealthSnapshot | null;
    try {
      health = await readHealth(request.signal);
    } catch {
      health = null;
    } finally {
      clearTimeout(timeout);
    }
    if (stopped || active !== request) return;
    active = undefined;

    const matched = health?.status === 'ok' && (!expectedInstance || expectedInstance === health.instance?.instance_id)
      ? health : null;
    if (matched?.ready === true && (!exitingEpoch || matched.startup_epoch !== exitingEpoch)) {
      if (assetRevision && matched.ui_asset_revision && matched.ui_asset_revision !== assetRevision) {
        stop();
        reload(outage);
        return;
      }
      expectedInstance ??= matched.instance?.instance_id;
      readyEpoch = matched.startup_epoch;
      exitingEpoch = undefined;
      hasServed = true;
      outage = undefined;
      retryMs = FIRST_RETRY_MS;
      onConnection({ phase: 'ready', health: matched });
      schedule(wakePending ? 0 : HEALTHY_POLL_MS);
      return;
    }

    if (matched?.ready === false || (!matched && transportDown)) enterOutage();
    schedule(wakePending ? 0 : retryMs);
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
  }

  function wake() {
    if (stopped) return;
    if (active) wakePending = true;
    else schedule(0);
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    active?.abort();
  }

  void probe();
  return {
    wake,
    stop,
    transport(state: 'open' | 'down') {
      transportDown = state === 'down';
      wake();
    },
    shuttingDown(requestId: string, startupEpoch?: string) {
      if (stopped || (startupEpoch && readyEpoch && startupEpoch !== readyEpoch)) return;
      exitingEpoch = startupEpoch ?? readyEpoch;
      enterOutage(requestId);
      active?.abort();
      active = undefined;
      retryMs = FIRST_RETRY_MS;
      wake();
    },
  };
}
