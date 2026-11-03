import { parseDomainEvent, type MandibleEventType } from "./contracts.js";
import { Worker } from "node:worker_threads";
import type { Logger } from "./types.js";
import type SqliteDatabase from "./sqlite.js";
import type {
  IngestionWorkerCommand,
  IngestionWorkerRequest,
  IngestionWorkerResponse,
} from "./ingestion-worker-protocol.js";
import { ConversationSourceChangedError } from "./conversations/source-store.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface IngestionActorOptions {
  dbPath: string;
  logger: Logger;
  publish: (event: MandibleEventType, data: unknown) => void;
  workerUrl?: URL;
  mainDb?: SqliteDatabase;
  checkpointIntervalMs?: number;
}

export function canUseDefaultIngestionWorker(): boolean {
  return defaultWorkerExtension() !== null;
}

function defaultWorkerExtension(): "js" | "ts" | null {
  const filename = new URL(import.meta.url).pathname;
  if (filename.endsWith(".js")) return "js";
  return process.versions.bun && filename.endsWith(".ts") ? "ts" : null;
}

/**
 * Persistent ingestion worker with its own SQLite connection.
 *
 * The actor deliberately keeps the protocol small: the request thread sends
 * paths or asks for a safety sweep, while parsing, compression, filesystem
 * traversal, and ingestion writes all happen in the worker.
 */
export class IngestionActor {
  private readonly options: IngestionActorOptions;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closing = false;
  private previousAutocheckpoint: number | undefined;

  constructor(options: IngestionActorOptions) {
    this.options = options;
    this.spawn();
  }

  ingest(
    paths: string[],
    forceFull = false,
    bypassSameMtimeUnchanged = false,
    priority = false,
  ): Promise<void> {
    return this.request({ kind: "ingest", paths, forceFull, bypassSameMtimeUnchanged, priority });
  }

  reconcile(startupPasses = false): Promise<void> {
    return this.request({ kind: "reconcile", startupPasses });
  }

  fullIngest(): Promise<{ processed: number; errors: number }> {
    return this.request({ kind: "full-ingest" });
  }

  /** Termination is safe: SQLite rolls an interrupted transaction back. */
  async close(): Promise<void> {
    this.closing = true;
    const worker = this.worker;
    this.worker = null;
    this.restoreAutocheckpoint();
    this.rejectPending(new Error("ingestion worker stopped"));
    if (worker) {
      await worker.terminate();
    }
  }

  private request<T>(request: IngestionWorkerCommand): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error("ingestion worker is closing"));
    }
    if (!this.worker) {
      this.spawn();
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker?.postMessage({ ...request, id } satisfies IngestionWorkerRequest);
    });
  }

  private spawn(): void {
    const worker = new Worker(this.options.workerUrl ?? defaultWorkerUrl(), {
      workerData: {
        dbPath: this.options.dbPath,
        checkpointIntervalMs: this.options.checkpointIntervalMs,
      },
      // `node --input-type=module` is valid for eval/stdin only and otherwise
      // makes a file-backed worker fail before loading its module.
      execArgv: process.execArgv.filter((arg) => arg !== "--input-type=module"),
    });
    this.worker = worker;
    worker.on("message", (message: IngestionWorkerResponse) => {
      if (this.worker === worker) this.onMessage(message);
    });
    worker.on("error", (error) => {
      this.options.logger("warn", "ingestion_worker_error", { error: String(error) });
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = null;
        this.restoreAutocheckpoint();
        this.rejectPending(new Error(`ingestion worker exited with code ${code}`));
      }
      if (!this.closing && code !== 0) {
        this.options.logger("warn", "ingestion_worker_exit", { code });
      }
    });
  }

  private onMessage(message: IngestionWorkerResponse): void {
    if (message.kind === "ready") {
      const db = this.options.mainDb;
      if (db && this.previousAutocheckpoint === undefined) {
        this.previousAutocheckpoint = db.pragma("wal_autocheckpoint", { simple: true }) as number;
        db.pragma("wal_autocheckpoint = 0");
      }
      this.options.logger("info", "ingestion_worker_ready");
      return;
    }
    if (message.kind === "log") {
      this.options.logger(message.level, message.message, message.details);
      return;
    }
    if (message.kind === "broadcast") {
      const parsed = parseDomainEvent({ type: message.event, data: message.data });
      if (!parsed.ok) throw new Error(`Invalid ingestion worker event: ${parsed.error}`);
      this.options.publish(parsed.value.type, parsed.value.data);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      pending.reject(message.errorCode === "conversation_source_changed"
        ? new ConversationSourceChangedError(message.error)
        : new Error(message.error));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private restoreAutocheckpoint(): void {
    if (this.previousAutocheckpoint === undefined) return;
    const db = this.options.mainDb;
    if (db?.open) db.pragma(`wal_autocheckpoint = ${this.previousAutocheckpoint}`);
    this.previousAutocheckpoint = undefined;
  }
}

function defaultWorkerUrl(): URL {
  // Construct this dynamically so source transformers do not rewrite a Node
  // worker module into a browser-dev-server URL.
  const url = new URL(import.meta.url);
  const extension = defaultWorkerExtension();
  if (!extension) throw new Error("default ingestion worker is unavailable in this runtime");
  url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)}ingestion-worker.${extension}`;
  url.search = "";
  url.hash = "";
  return url;
}
