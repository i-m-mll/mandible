import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ForksPoolWorker, type PoolOptions, type PoolWorker, type WorkerRequest } from 'vitest/node';

/** The standard fork worker, with a receipt after its process has exited. */
class MeasuredForksWorker implements PoolWorker {
  readonly name = 'mandible-forks';
  private startedAt = 0;
  private file: string | undefined;
  private stopped: Promise<void> | undefined;
  private recorded = false;
  private readonly workerId = randomUUID();

  constructor(private readonly delegate: PoolWorker, private readonly options: PoolOptions) {
    if (options.project.config.isolate === false) throw new Error('Measured test forks require file isolation.');
  }

  get cacheFs() { return this.delegate.cacheFs; }
  get reportMemory() { return this.delegate.reportMemory; }
  on(event: string, callback: (arg: unknown) => void) { this.delegate.on(event, callback); }
  off(event: string, callback: (arg: unknown) => void) { this.delegate.off(event, callback); }
  deserialize(value: unknown) { return this.delegate.deserialize(value); }

  async start(): Promise<void> {
    this.startedAt = performance.now();
    try { await this.delegate.start(); }
    catch (error) { this.record('start-failed'); throw error; }
  }

  send(message: WorkerRequest): void {
    if (message.type === 'run' || message.type === 'collect') {
      if (this.file || message.context.files.length !== 1) throw new Error('Measured forks require one isolated file per worker.');
      this.file = message.context.files[0].filepath;
    }
    this.delegate.send(message);
  }

  stop(): Promise<void> {
    return this.stopped ??= this.stopAndRecord();
  }

  private async stopAndRecord(): Promise<void> {
    try { await this.delegate.stop(); }
    catch (error) { this.record('stop-failed'); throw error; }
    this.record('complete');
  }

  private record(status: string): void {
    if (this.recorded) return;
    this.recorded = true;
    const endedAt = performance.now();
    const receiptPath = process.env.MANDIBLE_TEST_WORKER_TIMING;
    if (!receiptPath) throw new Error('Missing worker timing path; start Vitest through scripts/run-vitest.js.');
    appendFileSync(receiptPath, `${JSON.stringify({
      file: this.file, environment: this.options.environment.name,
      worker_id: this.workerId, status,
      start_ms: this.startedAt, end_ms: endedAt,
    })}\n`);
  }
}

export function measureForkWorker(delegate: PoolWorker, options: PoolOptions): PoolWorker {
  return new MeasuredForksWorker(delegate, options);
}

export const measuredForks = {
  name: 'mandible-forks',
  createPoolWorker: (options: PoolOptions) => measureForkWorker(new ForksPoolWorker(options), options),
};
