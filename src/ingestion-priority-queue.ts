interface QueueJob<T> {
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const PRIORITY_SOURCE_BURST = 16;

/** Serialized work with interactive service at completed-source boundaries. */
export class IngestionPriorityQueue<T> {
  private active = false;
  private readonly ordinary: Array<QueueJob<T>> = [];
  private readonly priority: Array<QueueJob<T>> = [];

  constructor(
    private readonly execute: (value: T, cooperate: () => Promise<void>) => Promise<void>,
  ) {}

  enqueue(value: T, priority = false): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      (priority ? this.priority : this.ordinary).push({ value, resolve, reject });
    });
    if (!this.active) {
      this.active = true;
      queueMicrotask(() => { void this.drain(); });
    }
    return result;
  }

  promote(value: T): void {
    const index = this.ordinary.findIndex((job) => job.value === value);
    if (index >= 0) this.priority.push(...this.ordinary.splice(index, 1));
  }

  remove(value: T): void {
    for (const lane of [this.ordinary, this.priority]) {
      const index = lane.findIndex((job) => job.value === value);
      if (index >= 0) lane.splice(index, 1)[0].resolve();
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.priority.length || this.ordinary.length) {
        const job = this.priority.shift() ?? this.ordinary.shift();
        if (job) await this.run(job);
        await this.cooperate();
      }
    } finally {
      this.active = false;
    }
  }

  private readonly cooperate = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const count = Math.max(PRIORITY_SOURCE_BURST, this.priority.length);
    for (let index = 0; index < count; index += 1) {
      const job = this.priority.shift();
      if (!job) break;
      await this.run(job);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  private async run(job: QueueJob<T>): Promise<void> {
    try {
      await this.execute(job.value, this.cooperate);
      job.resolve();
    } catch (error) {
      job.reject(error);
    }
  }
}
