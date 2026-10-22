import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolOptions, WorkerRequest } from 'vitest/node';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

import { measureForkWorker } from "../scripts/measured-test-pool.js";

const delegate = { time: 10, failStart: false, failStop: false, messages: [] as unknown[] };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); delegate.failStart = false; delegate.failStop = false; delegate.time = 10; delegate.messages = []; });

function fixture() {
  const filename = path.join(testRuntimeRoot, `worker-${crypto.randomUUID()}.jsonl`);
  vi.stubEnv('MANDIBLE_TEST_WORKER_TIMING', filename);
  vi.spyOn(performance, 'now').mockImplementation(() => delegate.time);
  const options = { project: { config: { isolate: true } }, environment: { name: 'node' }, execArgv: ['--smol'], env: { HOME: '/private' } } as unknown as PoolOptions;
  const worker = measureForkWorker({
    name: "forks", cacheFs: true, reportMemory: false,
    async start() { delegate.time += 5; if (delegate.failStart) throw new Error("start failed"); },
    async stop() { delegate.time += 7; if (delegate.failStop) throw new Error("stop failed"); },
    send(message) { delegate.messages.push(message); },
    on() {}, off() {}, deserialize(value) { return value; },
  }, options);
  const request = { __vitest_worker_request__: true, type: 'run', context: { files: [{ filepath: '/repo/test/example.test.ts' }] } } as WorkerRequest;
  return { worker, options, request, receipts: () => fs.readFileSync(filename, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
}

describe('standard fork lifecycle measurement', () => {
  it('includes delegated startup and graceful shutdown and records exactly once', async () => {
    const { worker, request, receipts } = fixture();
    expect(worker.cacheFs).toBe(true);
    await worker.start();
    worker.send(request);
    delegate.time += 4;
    await worker.stop();
    await worker.stop();
    expect(delegate.messages).toEqual([request]);
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatchObject({ status: 'complete', file: '/repo/test/example.test.ts', environment: 'node', start_ms: 10, end_ms: 26 });
    expect(() => worker.send(request)).toThrow('one isolated file');
  });

  it('records failed startup and teardown as failures instead of successful lifetimes', async () => {
    delegate.failStart = true;
    const start = fixture();
    await expect(start.worker.start()).rejects.toThrow('start failed');
    expect(start.receipts()[0].status).toBe('start-failed');
    delegate.failStart = false;
    delegate.failStop = true;
    const stop = fixture();
    await stop.worker.start();
    stop.worker.send(stop.request);
    await expect(stop.worker.stop()).rejects.toThrow('stop failed');
    expect(stop.receipts()[0].status).toBe('stop-failed');
  });
});
