import type { LogLevel } from "./types.js";

export type IngestionWorkerCommand =
  | {
      kind: "ingest";
      paths: string[];
      forceFull?: boolean;
      bypassSameMtimeUnchanged?: boolean;
    }
  | { kind: "reconcile"; repairLegacyOrphans?: boolean }
  | { kind: "full-ingest" };

export type IngestionWorkerRequest = IngestionWorkerCommand & { id: number };

export type IngestionWorkerResponse =
  | { kind: "ready" }
  | { kind: "result"; id: number; ok: true; value?: unknown }
  | { kind: "result"; id: number; ok: false; error: string }
  | {
      kind: "log";
      level: LogLevel;
      message: string;
      details?: Record<string, unknown>;
    }
  | { kind: "broadcast"; event: string; data: unknown };
