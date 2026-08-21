interface QueueJob<T> {
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Serial work queue with one cooperative priority lane.
 *
 * Background operations remain single-writer, but may call `cooperate()` at
 * safe boundaries so an exact user-requested ingest does not wait behind a
 * whole filesystem reconciliation.
 */
export class IngestionPriorityQueue<T> {
  private tail: Promise<void> = Promise.resolve();
  private active = false;
  private readonly priority: Array<QueueJob<T>> = [];

  constructor(
    private readonly execute: (value: T, cooperate: () => Promise<void>) => Promise<void>,
  ) {}

  enqueue(value: T, priority = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const job = { value, resolve, reject };
      if (priority && this.active) {
        this.priority.push(job);
        return;
      }
      const scheduled = this.tail.then(async () => {
        this.active = true;
        try {
          await this.run(job);
          await this.cooperate();
        } finally {
          this.active = false;
        }
      });
      this.tail = scheduled.catch(() => undefined);
    });
  }

  private readonly cooperate = async (): Promise<void> => {
    while (this.priority.length > 0) {
      const job = this.priority.shift();
      if (job) await this.run(job);
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
