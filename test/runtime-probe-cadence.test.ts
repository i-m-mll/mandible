// @vitest-environment node
import { expect, it } from 'vitest';
import { awaitHandoffReadiness } from '../scripts/local-runtime.mjs';
import { assessRuntimeLogs } from '../scripts/runtime-log-assessment.mjs';
import { observeRuntimeHealthCoverage } from '../src/runtime-health-contract.js';

function inspection(ready: boolean, generation = 'merge') {
  return {
    status: { dashboard_ready: ready, state: ready ? 'running' : 'starting' },
    main: { backend_generation: generation },
    backendJob: { loaded: true, pid: 41, runs: 1, lastExit: '(never exited)' },
    gatewayJob: { loaded: true, pid: 7, runs: 1, lastExit: '0' },
  };
}

it('keeps paired readiness inspections plus an ordinary client below the unchanged storm limit', async () => {
  const run = async (pauseMs?: number) => {
    let time = 0;
    let nextClient = 0;
    const rows: string[] = [];
    const request = (at: number) => rows.push(JSON.stringify({ event: 'http_request', method: 'GET',
      pathname: '/api/health', status: 200, time: new Date(at).toISOString() }));
    const result = await awaitHandoffReadiness('merge', 20_000, async () => {
      request(time); request(time);
      return inspection(time >= 12_000);
    }, {
      ...(pauseMs === undefined ? {} : { pauseMs }), now: () => time,
      wait: async (milliseconds: number) => {
        time += milliseconds;
        while (nextClient <= time) { request(nextClient); nextClient += 2_000; }
      },
    });
    expect(result.error).toBeNull();
    return assessRuntimeLogs(rows.join('\n'));
  };
  const previous = await run(200);
  const current = await run();
  expect(previous.failures).toEqual([expect.stringContaining('Repeated request storm: GET /api/health')]);
  expect(previous.diagnostics.http_requests.routes[0].peak_window_count).toBeGreaterThan(100);
  expect(current.failures).toEqual([]);
  expect(current.diagnostics.http_requests.routes[0].peak_window_count).toBeLessThan(100);
  console.info('paired readiness + one 2s client, peak requests/10s', {
    previous: previous.diagnostics.http_requests.routes[0].peak_window_count,
    current: current.diagnostics.http_requests.routes[0].peak_window_count,
  });
});

it('uses the same one-second default for immediate readiness and health coverage probes', async () => {
  let time = 1_000;
  const readiness: number[] = [];
  await awaitHandoffReadiness('merge', 6_000, async () => {
    readiness.push(time);
    return inspection(time === 3_000);
  }, { now: () => time, wait: async (milliseconds: number) => { time += milliseconds; } });
  time = 1_000;
  const observed: number[] = [];
  await observeRuntimeHealthCoverage({
    observationMs: 2_000, deadlineMs: 5_000, now: () => time,
    wait: async milliseconds => { time += milliseconds; },
    probe: async () => {
      observed.push(time);
      const interval = { sequence: time / 1_000, intervalStartedAt: time - 1_000, intervalEndedAt: time, warning: false };
      return { eventLoop: { ...interval, maxMs: 0 }, memory: interval };
    },
    healthOf: value => value,
  });
  expect(readiness).toEqual([1_000, 2_000, 3_000]);
  expect(observed).toEqual(readiness);
});

it('clips the readiness pause to its original deadline and reports the last actual generation', async () => {
  let time = 0;
  const waits: number[] = [];
  const inspections: number[] = [];
  const result = await awaitHandoffReadiness('merge', 1_500, async () => {
    inspections.push(time);
    return inspection(true, 'older');
  }, { now: () => time, wait: async (milliseconds: number) => { waits.push(milliseconds); time += milliseconds; } });
  expect(waits).toEqual([1_000, 500]);
  expect(inspections).toEqual([0, 1_000, 1_500]);
  expect(result).toMatchObject({ exited: false, error: expect.stringContaining('older') });
});
