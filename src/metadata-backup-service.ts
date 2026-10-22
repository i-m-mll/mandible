import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Db } from "./db.js";
import type { Logger } from "./types.js";
import { resolveMetadataBackupPath, type MetadataBackupResult } from "./ledger/backup.js";

export type BackupWorkerInput = { database: string; staging: string };
export type BackupWorkerResponse = { ok: true; value: MetadataBackupResult } | { ok: false; error: string };
export type BackupResult = { ok: true; size_bytes: number; path: string; destination: string } | { ok: false; error: string };
type Job = { destination: string; scheduled: boolean; resolve: (result: BackupResult) => void };
type WorkerFactory = (input: BackupWorkerInput) => Worker;

function createWorker(input: BackupWorkerInput): Worker {
  const url = new URL(import.meta.url);
  const extension = url.pathname.endsWith(".ts") ? "ts" : "js";
  url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)}metadata-backup-worker.${extension}`;
  url.search = "";
  url.hash = "";
  return new Worker(url, { workerData: input });
}

export class MetadataBackupService {
  private readonly queue: Job[] = [];
  private processing?: Promise<void>;
  private active?: Worker;
  private closed = false;
  private scheduled = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;

  constructor(private readonly db: Db, private readonly logger: Logger = () => undefined,
    private readonly workerFactory: WorkerFactory = createWorker) {}

  setting(key: string, fallback = ""): string {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? fallback;
  }

  integerSetting(key: string, fallback: number): number {
    const value = parseInt(this.setting(key), 10);
    return Number.isFinite(value) ? value : fallback;
  }

  private writeSetting(key: string, value: string): void {
    this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, Date.now());
  }

  updateSetting(key: string, value: string): void {
    if (this.closed) throw new Error("Metadata backup service is closed.");
    this.writeSetting(key, value);
  }

  run(): Promise<BackupResult> { return this.admit(false); }

  private admit(scheduled: boolean): Promise<BackupResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: "Metadata backup service is closed." });
    const destination = resolveMetadataBackupPath(this.setting("backup.destination"));
    const result = new Promise<BackupResult>(resolve => this.queue.push({ destination, scheduled, resolve }));
    this.pump();
    return result;
  }

  private pump(): void {
    if (this.processing || this.closed) return;
    this.processing = this.drain().finally(() => {
      this.processing = undefined;
      if (this.queue.length) this.pump();
    });
  }

  private tick(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    void this.admit(true).then(result => {
      if (!this.closed) this.logger(result.ok ? "info" : "warn", "metadata_backup_finished", result.ok
        ? { ok: true, size_bytes: result.size_bytes }
        : { ok: false, error: result.error.slice(0, 2048) });
    });
  }

  reschedule(): void {
    this.stopScheduling();
    if (this.closed || this.setting("backup.enabled", "true") !== "true") return;
    const interval = this.integerSetting("backup.interval_hours", 6) * 3_600_000;
    const previous = this.setting("backup.last_run_at");
    if (!previous || Date.now() - parseInt(previous, 10) >= interval) {
      this.startupTimer = setTimeout(() => { this.startupTimer = undefined; this.tick(); }, 5_000);
      this.startupTimer.unref();
    }
    this.intervalTimer = setInterval(() => this.tick(), interval);
    this.intervalTimer.unref();
  }

  stopScheduling(): void {
    clearTimeout(this.startupTimer);
    clearInterval(this.intervalTimer);
    this.startupTimer = undefined;
    this.intervalTimer = undefined;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.stopScheduling();
    for (const job of this.queue.splice(0)) job.resolve({ ok: false, error: "Metadata backup service is closed." });
    const termination = this.active?.terminate();
    this.closing = Promise.all([termination, this.processing]).then(() => undefined);
    return this.closing;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const job = this.queue.shift();
      if (!job) return;
      let result: BackupResult;
      try { result = await this.execute(job); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        result = { ok: false, error: detail };
        if (!this.closed) this.writeSetting("backup.last_error", detail);
      }
      if (job.scheduled) this.scheduled = false;
      job.resolve(result);
    }
  }

  private async execute(job: Job): Promise<BackupResult> {
    const staging = path.join(path.dirname(job.destination), `.${path.basename(job.destination)}.${process.pid}.${randomUUID()}.tmp`);
    let worker: Worker | undefined;
    try {
      if (this.closed) return { ok: false, error: "Metadata backup service is closed." };
      this.writeSetting("backup.last_run_at", String(Date.now()));
      if (this.db.name === ":memory:") throw new Error("Metadata backup service requires a file-backed database.");
      worker = this.workerFactory({ database: this.db.name, staging });
      this.active = worker;
      const response = await new Promise<BackupWorkerResponse>((resolve, reject) => {
        let message: BackupWorkerResponse | undefined;
        let failure: Error | undefined;
        worker!.once("message", value => { message = value as BackupWorkerResponse; });
        worker!.once("error", error => { failure = error; });
        worker!.once("exit", code => {
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error(`Metadata backup worker exited with code ${code}.`));
          else if (!message) reject(new Error("Metadata backup worker exited without a result."));
          else resolve(message);
        });
      });
      if (!response.ok) throw new Error(response.error);
      if (this.closed) return { ok: false, error: "Metadata backup service is closed." };
      fs.renameSync(staging, job.destination);
      this.writeSetting("backup.last_size_bytes", String(response.value.size_bytes));
      this.writeSetting("backup.last_error", "");
      return { ok: true, size_bytes: response.value.size_bytes, path: job.destination, destination: job.destination };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!this.closed) this.writeSetting("backup.last_error", detail);
      return { ok: false, error: detail };
    } finally {
      if (this.active === worker) this.active = undefined;
      try { fs.unlinkSync(staging); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
