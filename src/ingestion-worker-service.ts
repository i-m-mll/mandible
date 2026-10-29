import { IngestionPathScheduler, type IngestionPathRequirements } from "./ingestion-path-scheduler.js";
import type { IngestionWorkerCommand } from "./ingestion-worker-protocol.js";

interface IngestionWorkerOperations {
  ingest: (filePath: string, requirements: IngestionPathRequirements) => Promise<void>;
  needsFollowup: (filePath: string) => Promise<boolean>;
  reconcile: (startup: boolean, cooperate: () => Promise<void>, ingest: (filePath: string) => Promise<void>) => Promise<void>;
  fullIngest: (cooperate: () => Promise<void>, ingest: (filePath: string) => Promise<void>) => Promise<unknown>;
}

/** One request service owns both exact-source demand and background passes. */
export class IngestionWorkerService {
  private readonly paths: IngestionPathScheduler;

  constructor(private readonly operations: IngestionWorkerOperations) {
    this.paths = new IngestionPathScheduler(operations.ingest, operations.needsFollowup);
  }

  async execute(request: IngestionWorkerCommand): Promise<unknown> {
    if (request.kind === "ingest") {
      await this.paths.ingest(request.paths, {
        forceFull: request.forceFull === true,
        bypassSameMtimeUnchanged: request.bypassSameMtimeUnchanged === true,
        priority: request.priority === true,
      });
      return;
    }
    let value: unknown;
    await this.paths.background(async (cooperate) => {
      if (request.kind === "reconcile") {
        await this.operations.reconcile(request.startupPasses === true, cooperate,
          (filePath) => this.paths.inline(filePath));
      } else {
        value = await this.operations.fullIngest(cooperate, (filePath) => this.paths.inline(filePath, true));
      }
    });
    return value;
  }
}
