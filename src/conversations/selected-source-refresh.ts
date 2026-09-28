import path from "node:path";
import type { Db } from "../db.js";
import { ingestExactSelectedPath, selectedConversationSourceEpochIsCurrent } from "../ingestion.js";
import { IngestionActor, canUseDefaultIngestionWorker } from "../ingestion-actor.js";
import type { Logger } from "../types.js";

const FAILED_REFRESH_RETRY_MS = 30_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_REFRESHES = 2;
const MAX_CACHED_FAILURES = 256;

export interface SelectedSourceIngestionActor {
  ingest(paths: string[], forceFull?: boolean, bypassSameMtimeUnchanged?: boolean, priority?: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface SelectedSourceRefreshOptions {
  db: Db;
  dbPath: string;
  logger: Logger;
  publish: (event: string, data: unknown) => void;
  actorFactory?: () => SelectedSourceIngestionActor;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Lazily refreshes only the exact source selected by a conversation read.
 * Each request gets a disposable worker that writes to this instance's DB and
 * structure cache; it never starts provider watchers or a global reconcile.
 */
export class SelectedSourceRefresher {
  private readonly db: Db;
  private readonly actorFactory: () => SelectedSourceIngestionActor;
  private readonly publish: SelectedSourceRefreshOptions["publish"];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly workerAvailable: boolean;
  private readonly flights = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, { at: number; message: string }>();
  private closing = false;

  constructor(options: SelectedSourceRefreshOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.publish = options.publish;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
    this.workerAvailable = options.actorFactory !== undefined || canUseDefaultIngestionWorker();
    this.actorFactory = options.actorFactory ?? (() => {
      return new IngestionActor({
        dbPath: options.dbPath,
        logger: this.logger,
        publish: this.publish,
      });
    });
  }

  scheduleReparse = (sourcePath: string, sourceId: string, conversationId: string): boolean => {
    const target = this.target(sourcePath);
    if (!target || this.closing || !this.workerAvailable) return false;
    this.throwRecentFailure(target);
    if (this.flights.has(target)) return true;
    this.throwIfAtCapacity();
    this.start(target, sourceId, conversationId);
    return true;
  };

  ingest = async (sourcePath: string) => {
    const target = this.target(sourcePath);
    if (!target || this.closing || !this.workerAvailable) {
      throw new Error("selected conversation refresh worker is unavailable");
    }
    this.throwRecentFailure(target);
    let flight = this.flights.get(target);
    if (!flight) {
      this.throwIfAtCapacity();
      flight = this.start(target);
    }
    await flight;
    return { ok: true as const, status: "ingested" as const, transcript_path: target, session_ref: null };
  };

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.flights.values()]);
  }

  private target(sourcePath: string): string | null {
    if (!sourcePath || !path.isAbsolute(sourcePath)) return null;
    return path.resolve(sourcePath);
  }

  private throwRecentFailure(target: string): void {
    const failure = this.failures.get(target);
    if (!failure) return;
    if (this.now() - failure.at < FAILED_REFRESH_RETRY_MS) {
      throw new Error(`Selected-source refresh failed; retry after 30 seconds: ${failure.message}`);
    }
    this.failures.delete(target);
  }

  private throwIfAtCapacity(): void {
    if (this.flights.size >= MAX_CONCURRENT_REFRESHES) {
      throw new Error("selected conversation refresh is at capacity; retry shortly");
    }
  }

  private start(target: string, sourceId?: string, conversationId?: string): Promise<void> {
    const existing = this.flights.get(target);
    if (existing) return existing;
    if (this.closing) return Promise.reject(new Error("selected conversation refresh service is closing"));
    const flight = this.run(target, sourceId)
      .then(() => {
        this.failures.delete(target);
        if (conversationId) this.notifyConversation(conversationId);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.failures.has(target) && this.failures.size >= MAX_CACHED_FAILURES) {
          const oldest = this.failures.keys().next().value;
          if (oldest !== undefined) this.failures.delete(oldest);
        }
        this.failures.set(target, { at: this.now(), message });
        this.logger("warn", "selected_conversation_refresh_failed", {
          conversation_id: conversationId ?? null,
          source_id: sourceId ?? null,
          source_path: target,
          error: message,
        });
        if (conversationId) this.notifyConversation(conversationId);
        throw error;
      })
      .finally(() => {
        if (this.flights.get(target) === flight) this.flights.delete(target);
      });
    this.flights.set(target, flight);
    // Scheduling is intentionally nonblocking. Keep the rejection observed so
    // a selected read can report the cached failure on its next retry.
    void flight.catch(() => undefined);
    return flight;
  }

  private async run(target: string, sourceId?: string): Promise<void> {
    const actor = this.actorFactory();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ingestExactSelectedPath(actor, target),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("selected conversation refresh exceeded 60 seconds")), this.timeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (sourceId && !selectedConversationSourceEpochIsCurrent(this.db, sourceId)) {
        throw new Error("selected source did not reach the current parser version");
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      await actor.close();
    }
  }

  private notifyConversation(conversationId: string): void {
    try {
      const row = this.db.prepare("SELECT block_count FROM conversations WHERE id = ?")
        .get(conversationId) as { block_count: number } | undefined;
      this.publish("conversation:updated", { id: conversationId, block_count: row?.block_count ?? 0 });
    } catch (error) {
      this.logger("warn", "selected_conversation_refresh_notification_failed", {
        conversation_id: conversationId,
        error: String(error),
      });
    }
  }
}
