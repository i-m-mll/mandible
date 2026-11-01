import os from "node:os";
import { Worker } from "node:worker_threads";
import { ArtifactAttachmentError, borrowArtifactAttachment, isOpenedArtifactAttachment, type AttachmentIdentity, type OpenedArtifactAttachment } from "./artifact-attachment.js";

// Bounded worker pool that moves artifact-ingest file reads AND hashing off the
// main thread. The audit (perf umbrella c16807e, issue aadf45e) traced repeated
// 76-86 s whole-daemon freezes to POST /api/artifacts/bundles: ingest paths did
// sync readFileSync plus full-buffer sha256 on the event loop. Hashing alone is
// not enough — the synchronous read is itself the stall — so the worker opens,
// reads, hashes, and (optionally) materializes the content-addressed copy, then
// re-stats to guard against a file mutating underneath the read.

export interface MaterializedArtifactFile {
  hash: string;
  size: number;
  mtimeMs: number;
  ino: number;
  wrote: boolean;
}

const verifiedCasResults = new WeakMap<MaterializedArtifactFile, { root: string; hash: string }>();

export function isVerifiedArtifactCasResult(value: unknown, root: string, hash: string): boolean {
  if (!value || typeof value !== "object") return false;
  const verified = verifiedCasResults.get(value as MaterializedArtifactFile);
  return verified?.root === root && verified.hash === hash;
}

interface PoolJobRequest {
  id: number;
  source: { kind: "path"; path: string } | { kind: "attachment"; fd: number; identity: AttachmentIdentity; name: string };
  artifactRoot: string | null;
  write: boolean;
}

type PoolJobResponse =
  | { id: number; ok: true; value: MaterializedArtifactFile }
  | { id: number; ok: false; error: string; changed: boolean };

interface PendingJob {
  request: PoolJobRequest;
  resolve: (value: MaterializedArtifactFile) => void;
  reject: (error: Error) => void;
}

// The worker re-stats after the read and rejects when identity moved, so a file
// swapped/truncated mid-read never produces a hash that disagrees with the bytes
// we durably store. CAS writes go through a temp file + rename so a concurrent
// reader never observes a torn blob, and an existing blob is left untouched.
const WORKER_SOURCE = `
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parentPort } = require("node:worker_threads");

function casPathForHash(root, hash) {
  return path.join(root, "sha256", hash.slice(0, 2), hash);
}

function handle(request) {
  const source = request.source;
  const attachment = source.kind === "attachment";
  const stat = () => attachment ? fs.fstatSync(source.fd) : fs.statSync(source.path);
  const changed = () => { const error = new Error("artifact source changed during read"); error.changed = true; throw error; };
  const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
  const before = stat();
  if (!before.isFile()) {
    throw new Error("artifact source path is not a regular file");
  }
  if (attachment && !["dev", "ino", "size", "mtimeMs"].every(key => before[key] === source.identity[key])) changed();
  const buffer = fs.readFileSync(attachment ? source.fd : source.path);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const after = stat();
  if (!same(before, after) || buffer.length !== after.size) changed();
  let wrote = false;
  if (request.write && request.artifactRoot) {
    const target = casPathForHash(request.artifactRoot, hash);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      fs.writeFileSync(tmp, buffer);
      try {
        fs.renameSync(tmp, target);
        wrote = true;
      } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        if (!fs.existsSync(target)) throw error;
      }
    }
    const storedBefore = fs.statSync(target);
    const stored = fs.readFileSync(target);
    const storedAfter = fs.statSync(target);
    if (!storedBefore.isFile() || !same(storedBefore, storedAfter) || stored.length !== storedAfter.size
      || crypto.createHash("sha256").update(stored).digest("hex") !== hash) {
      throw new Error("Stored bytes do not match sha256");
    }
  }
  return { hash, size: after.size, mtimeMs: after.mtimeMs, ino: after.ino, wrote };
}

parentPort.on("message", (request) => {
  try {
    parentPort.postMessage({ id: request.id, ok: true, value: handle(request) });
  } catch (error) {
    parentPort.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error), changed: error.changed === true });
  }
});
`;

function defaultPoolSize(): number {
  const parallelism = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, Math.min(4, parallelism - 1));
}

class ArtifactIngestPool {
  private readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly pending = new Map<number, PendingJob>();
  private readonly assigned = new Map<Worker, number>();
  private readonly queue: PendingJob[] = [];
  private nextId = 1;
  private started = false;

  constructor(size = defaultPoolSize()) {
    this.size = Math.max(1, size);
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.size; i += 1) {
      this.spawnWorker();
    }
  }

  private spawnWorker(): void {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.on("message", (message: PoolJobResponse) => this.onMessage(worker, message));
    worker.on("error", (error) => this.onWorkerError(worker, error));
    worker.on("exit", (code) => this.onWorkerExit(worker, code));
    // An idle worker must never keep the event loop alive on its own: a CLI or
    // test process that ingests one file should still exit promptly. A worker is
    // re-ref'd for the duration of an in-flight job (see drainQueue), so the loop
    // stays alive until that job's result arrives.
    worker.unref();
    this.workers.push(worker);
    this.idle.push(worker);
  }

  private onMessage(worker: Worker, message: PoolJobResponse): void {
    this.assigned.delete(worker);
    const job = this.pending.get(message.id);
    if (job) {
      this.pending.delete(message.id);
      if (message.ok) {
        Object.freeze(message.value);
        if (job.request.write && job.request.artifactRoot) {
          verifiedCasResults.set(message.value, { root: job.request.artifactRoot, hash: message.value.hash });
        }
        job.resolve(message.value);
      }
      else job.reject(job.request.source.kind === "attachment"
        ? new ArtifactAttachmentError(message.changed ? "file_rpc_attachment_changed" : "file_rpc_attachment_io_error", message.changed ? 409 : 500, job.request.source.name)
        : new Error(message.error));
    }
    this.releaseWorker(worker);
  }

  private onWorkerError(worker: Worker, _error: Error): void {
    // A borrowed descriptor cannot be released until termination has completed.
    void worker.terminate().then(() => this.onWorkerExit(worker, 1));
  }

  private onWorkerExit(worker: Worker, code: number): void {
    const wasTracked = this.workers.includes(worker);
    const jobId = this.assigned.get(worker);
    if (jobId !== undefined) {
      this.assigned.delete(worker);
      const job = this.pending.get(jobId);
      if (job) {
        this.pending.delete(jobId);
        job.reject(job.request.source.kind === "attachment"
          ? new ArtifactAttachmentError("file_rpc_attachment_io_error", 500, job.request.source.name)
          : new Error(`artifact ingest worker exited with code ${code}`));
      }
    }
    // Only respawn when we are still running and did not intentionally retire it.
    if (wasTracked && this.started) {
      this.replaceWorker(worker);
    }
  }

  private replaceWorker(worker: Worker): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    if (this.started) this.spawnWorker();
    this.drainQueue();
  }

  private releaseWorker(worker: Worker): void {
    if (this.workers.includes(worker) && !this.idle.includes(worker)) {
      this.idle.push(worker);
    }
    // No job in flight for this worker: let it stop holding the loop open.
    if (!this.assigned.has(worker)) worker.unref();
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const worker = this.idle.shift() as Worker;
      const job = this.queue.shift() as PendingJob;
      this.assigned.set(worker, job.request.id);
      // Keep the loop alive while this job runs so the result is always delivered.
      worker.ref();
      worker.postMessage(job.request);
    }
  }

  run(filePath: string | OpenedArtifactAttachment, artifactRoot: string | null, write: boolean): Promise<MaterializedArtifactFile> {
    this.ensureStarted();
    return new Promise<MaterializedArtifactFile>((resolve, reject) => {
      const id = this.nextId++;
      const source: PoolJobRequest["source"] = isOpenedArtifactAttachment(filePath)
        ? { kind: "attachment", ...borrowArtifactAttachment(filePath), name: filePath.name }
        : { kind: "path", path: filePath as string };
      const request: PoolJobRequest = { id, source, artifactRoot, write };
      const job: PendingJob = { request, resolve, reject };
      this.pending.set(id, job);
      this.queue.push(job);
      this.drainQueue();
    });
  }

  async shutdown(): Promise<void> {
    this.started = false;
    const workers = [...this.workers];
    this.workers.length = 0;
    this.idle.length = 0;
    this.queue.length = 0;
    const jobs = [...this.pending.values()];
    this.assigned.clear();
    this.pending.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
    for (const job of jobs) {
      job.reject(job.request.source.kind === "attachment"
        ? new ArtifactAttachmentError("file_rpc_attachment_io_error", 500, job.request.source.name)
        : new Error("artifact ingest pool shut down"));
    }
  }
}

let sharedPool: ArtifactIngestPool | null = null;

function pool(): ArtifactIngestPool {
  if (!sharedPool) sharedPool = new ArtifactIngestPool();
  return sharedPool;
}

// Read + hash a file off the main thread AND write its content-addressed copy
// into the artifact store, guarding against a mid-read mutation. Returns the
// sha256, size, and whether a fresh CAS blob was written.
export async function materializeArtifactFileIntoCas(
  filePath: string | OpenedArtifactAttachment,
  artifactRoot: string,
): Promise<MaterializedArtifactFile> {
  try {
    return await pool().run(filePath, artifactRoot, true);
  } catch (error) {
    if (isOpenedArtifactAttachment(filePath) && !(error instanceof ArtifactAttachmentError)) {
      throw new ArtifactAttachmentError("file_rpc_attachment_io_error", 500, filePath.name);
    }
    throw error;
  }
}

// Read + hash a file off the main thread without writing to the store. Used by
// dry-run planners that must not materialize bytes.
export function readAndHashArtifactFile(filePath: string | OpenedArtifactAttachment): Promise<MaterializedArtifactFile> {
  return pool().run(filePath, null, false);
}

// Testing / shutdown hook: terminate the shared pool so the process (or a test
// runner) can exit cleanly.
export async function shutdownArtifactIngestPool(): Promise<void> {
  if (!sharedPool) return;
  const current = sharedPool;
  sharedPool = null;
  await current.shutdown();
}
