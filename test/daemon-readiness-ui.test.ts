import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  monitorDaemonConnection,
  type DaemonConnection,
  type DaemonHealthSnapshot,
} from '../ui/src/daemon-readiness';
import { resolveInstanceInfo } from '../src/instance-policy';

const instance = resolveInstanceInfo({ env: {} });
const healthy = (startup_epoch = 'old', ui_asset_revision = 'dashboard-a'): DaemonHealthSnapshot => ({
  status: 'ok', ready: true, warm: false, startup_epoch, ui_asset_revision, instance,
});

function fixture(initialHealth: DaemonHealthSnapshot | null = healthy()) {
  let health = initialHealth;
  const states: DaemonConnection[] = [];
  const reload = vi.fn();
  const monitor = monitorDaemonConnection({
    instanceId: instance.instance_id,
    assetRevision: 'dashboard-a',
    readHealth: async () => health,
    onConnection: connection => states.push(connection),
    reload,
  });
  return { monitor, states, reload, setHealth(value: DaemonHealthSnapshot | null) { health = value; } };
}

describe('dashboard daemon availability', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves through preparation and keeps the outage active until the new daemon is ready', async () => {
    const f = fixture({ ...healthy(), rebuilding: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.states.at(-1)?.phase).toBe('ready');

    f.monitor.shuttingDown('approval', 'old');
    expect(f.states.at(-1)).toMatchObject({ phase: 'outage', outage: { requestId: 'approval', startupEpoch: 'old' } });
    await vi.advanceTimersByTimeAsync(200);
    expect(f.states.at(-1)?.phase).toBe('outage');

    f.setHealth({ ...healthy('new'), ready: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(f.states.at(-1)?.phase).toBe('outage');
    f.setHealth(healthy('new'));
    await vi.advanceTimersByTimeAsync(750);
    expect(f.states.at(-1)).toMatchObject({ phase: 'ready', health: { startup_epoch: 'new', warm: false } });
    f.monitor.shuttingDown('late fanout', 'old');
    expect(f.states.at(-1)?.phase).toBe('ready');
    expect(f.reload).not.toHaveBeenCalled();
    f.monitor.stop();
  });

  it('checks health on SSE loss and leaves a serving process usable', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(1);
    f.monitor.transport('down');
    await vi.advanceTimersByTimeAsync(20);
    expect(f.states.every(state => state.phase === 'ready')).toBe(true);

    f.setHealth(null);
    f.monitor.transport('down');
    await vi.advanceTimersByTimeAsync(20);
    expect(f.states.at(-1)?.phase).toBe('outage');
    f.setHealth({ ...healthy('new'), instance: { ...instance, instance_id: 'another-daemon' } });
    await vi.advanceTimersByTimeAsync(200);
    expect(f.states.at(-1)?.phase).toBe('outage');

    f.setHealth(healthy());
    f.monitor.transport('open');
    await vi.advanceTimersByTimeAsync(20);
    expect(f.states.at(-1)?.phase).toBe('ready');
    expect(f.reload).not.toHaveBeenCalled();
    f.monitor.stop();
  });

  it('reloads once for a different ready dashboard revision and carries the outage into the new document', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(1);
    f.monitor.shuttingDown('approval', 'old');
    f.setHealth({ ...healthy('new', 'dashboard-b'), ready: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(f.reload).not.toHaveBeenCalled();
    f.setHealth(healthy('new', 'dashboard-b'));
    await vi.advanceTimersByTimeAsync(1_000);
    f.monitor.transport('open');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.reload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: 'approval', startupEpoch: 'old' }));
  });
});
