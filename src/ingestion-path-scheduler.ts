import path from "node:path";
import { canonicalSourcePath } from "./conversations/logical-source.js";
import { IngestionPriorityQueue } from "./ingestion-priority-queue.js";

export interface IngestionPathRequirements {
  forceFull: boolean;
  bypassSameMtimeUnchanged: boolean;
  priority: boolean;
}

interface PathWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PathPass {
  requirements: IngestionPathRequirements;
  waiters: PathWaiter[];
  generation: number;
  withinPass: boolean;
}

interface PathDemand {
  path: string;
  pending?: PathPass;
  running?: PathPass;
  job: () => Promise<void>;
}

function strengthen(target: IngestionPathRequirements, incoming: IngestionPathRequirements): void {
  target.forceFull ||= incoming.forceFull;
  target.bypassSameMtimeUnchanged ||= incoming.bypassSameMtimeUnchanged;
  target.priority ||= incoming.priority;
}

function covers(running: IngestionPathRequirements, requested: IngestionPathRequirements): boolean {
  return (!requested.forceFull || running.forceFull)
    && (!requested.bypassSameMtimeUnchanged || running.bypassSameMtimeUnchanged || running.forceFull);
}

/** Owns pending/running logical-source demand inside the single ingestion writer. */
export class IngestionPathScheduler {
  private readonly demands = new Map<string, PathDemand>();
  private readonly queue = new IngestionPriorityQueue<(
    cooperate: () => Promise<void>,
  ) => Promise<void>>((job, cooperate) => job(cooperate));

  constructor(
    private readonly execute: (filePath: string, requirements: IngestionPathRequirements, withinPass: boolean) => Promise<void>,
    private readonly needsFollowup: (filePath: string) => Promise<boolean>,
  ) {}

  async ingest(paths: readonly string[], requirements: IngestionPathRequirements): Promise<void> {
    const outcomes = await Promise.allSettled([...new Set(paths.map((file) =>
      canonicalSourcePath(path.resolve(file))))].map((file) => this.request(file, requirements)));
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `Failed to ingest ${failures.length} source(s)`);
  }

  background(operation: (cooperate: () => Promise<void>) => Promise<void>): Promise<void> {
    return this.queue.enqueue(operation);
  }

  async inline(filePath: string, forceFull = false): Promise<void> {
    const key = canonicalSourcePath(path.resolve(filePath));
    const completed = this.request(key, { forceFull, bypassSameMtimeUnchanged: false, priority: false }, true);
    const demand = this.demands.get(key)!;
    while (demand.pending) {
      this.queue.remove(demand.job);
      await this.run(demand);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await completed;
  }

  private request(filePath: string, requirements: IngestionPathRequirements, withinPass = false): Promise<void> {
    let demand = this.demands.get(filePath);
    if (!demand) {
      demand = { path: filePath, job: () => this.run(demand!) };
      this.demands.set(filePath, demand);
    }
    const current = demand;
    return new Promise<void>((resolve, reject) => {
      if (current.running) current.running.generation += 1;
      if (current.running && !current.pending && covers(current.running.requirements, requirements)) {
        current.running.requirements.priority ||= requirements.priority;
        current.running.waiters.push({ resolve, reject });
        return;
      }
      if (!current.pending) {
        current.pending = { requirements: { ...requirements }, waiters: [], generation: 0, withinPass };
        if (!current.running) void this.queue.enqueue(current.job, requirements.priority);
      } else {
        strengthen(current.pending.requirements, requirements);
        current.pending.withinPass &&= withinPass;
        if (requirements.priority) this.queue.promote(current.job);
      }
      current.pending.waiters.push({ resolve, reject });
    });
  }

  private async run(demand: PathDemand): Promise<void> {
    const pass = demand.pending;
    if (!pass) return;
    demand.pending = undefined;
    demand.running = pass;
    try {
      await this.execute(demand.path, pass.requirements, pass.withinPass);
      const verifiedGeneration = pass.generation;
      const stale = verifiedGeneration > 0 && await this.needsFollowup(demand.path);
      if (stale || pass.generation !== verifiedGeneration) {
        const pending = demand.pending ??= {
          requirements: { ...pass.requirements, bypassSameMtimeUnchanged: true }, waiters: [],
          generation: 0, withinPass: pass.withinPass,
        };
        strengthen(pending.requirements, pass.requirements);
        pending.withinPass &&= pass.withinPass;
        pending.requirements.bypassSameMtimeUnchanged = true;
        pending.waiters.push(...pass.waiters);
      } else {
        for (const waiter of pass.waiters) waiter.resolve();
      }
    } catch (error) {
      for (const waiter of pass.waiters) waiter.reject(error);
    } finally {
      demand.running = undefined;
      if (demand.pending) {
        void this.queue.enqueue(demand.job, demand.pending.requirements.priority);
      } else {
        this.demands.delete(demand.path);
      }
    }
  }
}
