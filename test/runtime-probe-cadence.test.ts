// @vitest-environment node
import { expect, it } from 'vitest';
import { awaitHandoffReadiness } from '../scripts/local-runtime.mjs';
import { assessRuntimeLogs } from '../scripts/runtime-log-assessment.mjs';

function inspection(ready: boolean, generation = 'merge') {
  return {
    status: { dashboard_ready: ready, state: ready ? 'running' : 'starting' },
    main: { backend_generation: generation },
    backendJob: { loaded: true, pid: 41, runs: 1, lastExit: '(never exited)' },
    gatewayJob: { loaded: true, pid: 7, runs: 1, lastExit: '0' },
  };
}

it('reduces paired readiness traffic while retaining both aggregate rates as diagnostics', async () => {
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
  expect(previous.failures).toEqual([]);
  expect(previous.diagnostics.http_requests.routes[0].peak_window_count).toBeGreaterThan(100);
  expect(current.failures).toEqual([]);
  expect(current.diagnostics.http_requests.routes[0].peak_window_count)
    .toBeLessThan(previous.diagnostics.http_requests.routes[0].peak_window_count);
  expect(previous.diagnostics.hard_failure_count).toBe(0);
  expect(current.diagnostics.hard_failure_count).toBe(0);
  console.info('paired readiness + one 2s client, peak requests/10s', {
    previous: previous.diagnostics.http_requests.routes[0].peak_window_count,
    current: current.diagnostics.http_requests.routes[0].peak_window_count,
  });
});

it('probes readiness immediately and then once a second', async () => {
  let time = 1_000;
  const readiness: number[] = [];
  await awaitHandoffReadiness('merge', 6_000, async () => {
    readiness.push(time);
    return inspection(time === 3_000);
  }, { now: () => time, wait: async (milliseconds: number) => { time += milliseconds; } });
  expect(readiness).toEqual([1_000, 2_000, 3_000]);
});

it('clips the readiness pause to its wait deadline and retains the last starting observation', async () => {
  let time = 0;
  const waits: number[] = [];
  const inspections: number[] = [];
  const result = await awaitHandoffReadiness('merge', 1_500, async () => {
    inspections.push(time);
    return inspection(false);
  }, { now: () => time, wait: async (milliseconds: number) => { waits.push(milliseconds); time += milliseconds; } });
  expect(waits).toEqual([1_000, 500]);
  expect(inspections).toEqual([0, 1_000, 1_500]);
  expect(result).toMatchObject({ outcome: 'pending', exited: false, error: expect.stringContaining('starting') });
});
