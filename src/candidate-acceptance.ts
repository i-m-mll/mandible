/**
 * Candidate acceptance as an approval precondition for runtime self-update
 * merges (issues a09b4d2, 7d83fe5).
 *
 * The daemon runs the candidate's own `scripts/candidate-acceptance.mjs` on the
 * exact retained merge candidate (the pin commit whose parents are the reviewed
 * base and head) and records the outcome bound to that candidate. Approval
 * accepts only a passing record whose tree, base and head equal the request's
 * current candidate, so any base or head movement makes a result stale.
 *
 * Runs are queued and executed one at a time by `CandidateAcceptanceScheduler`;
 * the auth queue decides when a candidate needs one.
 */
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CandidateAcceptanceProjection } from "./contracts.js";
import type { Db } from "./db.js";
import { getUserHome } from "./platform-paths.js";

const execFileAsync = promisify(execFile);

export type CandidateAcceptanceStatus = "queued" | "running" | "passed" | "failed" | "unavailable" | "cancelled";
export type CandidateAcceptanceOpenStatus = "queued" | "running";
export type CandidateAcceptanceFinalStatus = Exclude<CandidateAcceptanceStatus, CandidateAcceptanceOpenStatus>;

export interface CandidateAcceptanceRecord {
  id: string;
  auth_request_id: string;
  pin_sha: string;
  tree_sha: string;
  base_sha: string;
  head_sha: string;
  status: CandidateAcceptanceStatus;
  started_at: number;
  finished_at: number | null;
  result: unknown;
  error: string | null;
}

export interface CandidateAcceptanceCandidate {
  pin_sha: string;
  tree_sha: string;
  base_sha: string;
  head_sha: string;
}

export interface CandidateAcceptanceRunInput {
  repoRoot: string;
  pinSha: string;
  projectId: string;
  workUnitId: string;
  env: NodeJS.ProcessEnv;
}

export interface CandidateAcceptanceInput extends CandidateAcceptanceRunInput {
  /** Aborted when the run is cancelled; the executor stops its owned processes. */
  signal: AbortSignal;
}

export interface CandidateAcceptanceOutcome {
  status: CandidateAcceptanceFinalStatus;
  result: unknown;
  error: string | null;
}

export type CandidateAcceptanceExecutor = (input: CandidateAcceptanceInput) => Promise<CandidateAcceptanceOutcome>;

const OPEN_STATUSES_SQL = "('queued', 'running')";
const MAX_RESULT_CHARS = 64 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const ACCEPTANCE_TIMEOUT_MS = 30 * 60 * 1000;

function mapRow(row: Record<string, unknown>): CandidateAcceptanceRecord {
  return {
    id: String(row.id),
    auth_request_id: String(row.auth_request_id),
    pin_sha: String(row.pin_sha),
    tree_sha: String(row.tree_sha),
    base_sha: String(row.base_sha),
    head_sha: String(row.head_sha),
    status: row.status as CandidateAcceptanceStatus,
    started_at: Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    result: typeof row.result_json === "string" ? JSON.parse(row.result_json) : null,
    error: row.error == null ? null : String(row.error),
  };
}

export function isOpenCandidateAcceptance(record: CandidateAcceptanceRecord | null): boolean {
  return record?.status === "queued" || record?.status === "running";
}

export function candidateAcceptanceMatches(record: CandidateAcceptanceRecord, candidate: Partial<CandidateAcceptanceCandidate>): boolean {
  return record.tree_sha === candidate.tree_sha && record.base_sha === candidate.base_sha && record.head_sha === candidate.head_sha;
}

export function latestCandidateAcceptance(db: Db, requestId: string): CandidateAcceptanceRecord | null {
  const row = db.prepare(
    "SELECT * FROM auth_candidate_acceptances WHERE auth_request_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).get(requestId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

function readCandidateAcceptance(db: Db, id: string): CandidateAcceptanceRecord | null {
  const row = db.prepare("SELECT * FROM auth_candidate_acceptances WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

function insertCandidateAcceptance(
  db: Db,
  requestId: string,
  candidate: CandidateAcceptanceCandidate,
  at: number,
  outcome: CandidateAcceptanceOutcome | null,
): CandidateAcceptanceRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO auth_candidate_acceptances (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, requestId, candidate.pin_sha, candidate.tree_sha, candidate.base_sha, candidate.head_sha,
    outcome?.status ?? "queued", at, outcome ? at : null, outcome?.error ?? null);
  return readCandidateAcceptance(db, id)!;
}

/** Close an open record with its final outcome. A record already closed is left unchanged. */
function closeCandidateAcceptance(db: Db, id: string, outcome: CandidateAcceptanceOutcome, at: number): boolean {
  let result = outcome.result === undefined ? null : JSON.stringify(outcome.result);
  if (result && result.length > MAX_RESULT_CHARS) {
    const value = outcome.result as Record<string, unknown>;
    result = JSON.stringify({ truncated: true, status: value?.status ?? null, candidate: value?.candidate ?? null, error: value?.error ?? null, receipt: value?.receipt ?? null });
  }
  return db.prepare(
    `UPDATE auth_candidate_acceptances SET status = ?, finished_at = ?, result_json = ?, error = ? WHERE id = ? AND status IN ${OPEN_STATUSES_SQL}`,
  ).run(outcome.status, at, result, outcome.error, id).changes === 1;
}

/** Null when the record passes for exactly this candidate; otherwise the refusal. */
export function candidateAcceptanceRefusal(record: CandidateAcceptanceRecord | null, candidate: Partial<CandidateAcceptanceCandidate>, requestId: string): string | null {
  const run = `\`mandible auth acceptance run ${requestId.slice(0, 8)}\``;
  if (!candidate.tree_sha || !candidate.base_sha || !candidate.head_sha) {
    return "Runtime self-update approval requires an exact retained merge candidate, and this request has none. Resubmit it.";
  }
  if (!record) return `Runtime self-update approval requires a passing candidate acceptance of the exact candidate merge, and none has run. The daemon starts one when the candidate is current; ${run} starts it now.`;
  if (!candidateAcceptanceMatches(record, candidate)) {
    return `The recorded candidate acceptance (${record.status}) was for a different candidate (tree ${record.tree_sha.slice(0, 12)}, base ${record.base_sha.slice(0, 12)}, head ${record.head_sha.slice(0, 12)}); the base or head has moved since. Run ${run} for the current candidate.`;
  }
  if (record.status === "queued") return "Candidate acceptance of this exact candidate is queued. Approve after it passes.";
  if (record.status === "running") return "Candidate acceptance of this exact candidate is still running. Approve after it passes.";
  if (record.status !== "passed") {
    const verdict = record.status === "unavailable" ? "was unavailable" : record.status === "cancelled" ? "was cancelled" : "failed";
    return `Candidate acceptance of this exact candidate ${verdict}${record.error ? `: ${record.error}` : ""}. Fix the cause and run ${run} again.`;
  }
  return null;
}

/** The request view's acceptance state for one request's current candidate. */
export function candidateAcceptanceProjection(
  record: CandidateAcceptanceRecord | null,
  candidate: Partial<CandidateAcceptanceCandidate>,
  pending: boolean,
): CandidateAcceptanceProjection {
  if (!record) return { state: "none", reason: null, started_at: null, finished_at: null };
  const stale = pending && !candidateAcceptanceMatches(record, candidate);
  return {
    state: stale ? "stale" : record.status,
    reason: stale ? `Ran for base ${record.base_sha.slice(0, 12)} and head ${record.head_sha.slice(0, 12)}, not the current candidate.` : record.error,
    started_at: record.started_at,
    finished_at: record.finished_at,
  };
}

export interface CandidateAcceptanceSchedulerOptions {
  db: Db;
  executor: CandidateAcceptanceExecutor;
  now: () => number;
  /** False once the owning queue is disposed or its database closed. */
  live: () => boolean;
  /** Whether a queued record still matches its request's current pending candidate. */
  current: (record: CandidateAcceptanceRecord) => boolean;
  /** Called after any record of the request changes state. */
  changed: (record: CandidateAcceptanceRecord) => void;
}

/**
 * The single owner of acceptance execution in a daemon. Records are durable;
 * run inputs live only in this process, so open records it does not own were
 * interrupted by a restart. One run executes at a time because every run uses
 * the same persistent acceptance checkout.
 */
export class CandidateAcceptanceScheduler {
  private readonly inputs = new Map<string, CandidateAcceptanceRunInput>();
  private active: { id: string; controller: AbortController; done: Promise<void> } | null = null;

  constructor(private readonly options: CandidateAcceptanceSchedulerOptions) {
    this.cancelOrphans("Interrupted by a daemon restart.");
  }

  /** Queue a run of `candidate`, cancelling every other open run of the request. */
  enqueue(requestId: string, candidate: CandidateAcceptanceCandidate, input: CandidateAcceptanceRunInput): CandidateAcceptanceRecord {
    this.cancelOpen(requestId, "Replaced by a run of a newer candidate.");
    const record = insertCandidateAcceptance(this.options.db, requestId, candidate, this.options.now(), null);
    this.inputs.set(record.id, input);
    this.options.changed(record);
    this.pump();
    return readCandidateAcceptance(this.options.db, record.id)!;
  }

  /** Record an outcome decided before any run could start, such as a missing prerequisite. */
  record(requestId: string, candidate: CandidateAcceptanceCandidate, outcome: CandidateAcceptanceOutcome): CandidateAcceptanceRecord {
    this.cancelOpen(requestId, "Replaced by a newer candidate.");
    const record = insertCandidateAcceptance(this.options.db, requestId, candidate, this.options.now(), outcome);
    this.options.changed(record);
    return record;
  }

  /** Cancel the request's open runs, stopping one that is executing. */
  cancelOpen(requestId: string, reason: string): void {
    const rows = this.options.db.prepare(
      `SELECT id FROM auth_candidate_acceptances WHERE auth_request_id = ? AND status IN ${OPEN_STATUSES_SQL}`,
    ).all(requestId) as Array<{ id: string }>;
    for (const { id } of rows) this.cancel(id, reason);
  }

  /** Cancel every open run, for example before the daemon restarts. */
  cancelAll(reason: string): void {
    const rows = this.options.db.prepare(
      `SELECT id FROM auth_candidate_acceptances WHERE status IN ${OPEN_STATUSES_SQL}`,
    ).all() as Array<{ id: string }>;
    for (const { id } of rows) this.cancel(id, reason);
  }

  /** Stop the executing run without recording; the next daemon start records it as interrupted. */
  abort(): void {
    this.active?.controller.abort();
  }

  /** Settles when the executing run, if any, has stopped. */
  async drain(): Promise<void> {
    while (this.active) await this.active.done;
  }

  private cancel(id: string, reason: string): void {
    this.inputs.delete(id);
    if (!closeCandidateAcceptance(this.options.db, id, { status: "cancelled", result: null, error: reason }, this.options.now())) return;
    if (this.active?.id === id) this.active.controller.abort();
    this.options.changed(readCandidateAcceptance(this.options.db, id)!);
  }

  private cancelOrphans(reason: string): void {
    const rows = this.options.db.prepare(
      `SELECT id FROM auth_candidate_acceptances WHERE status IN ${OPEN_STATUSES_SQL}`,
    ).all() as Array<{ id: string }>;
    for (const { id } of rows) {
      if (this.inputs.has(id) || this.active?.id === id) continue;
      this.cancel(id, reason);
    }
  }

  private pump(): void {
    if (this.active || !this.options.live()) return;
    const rows = this.options.db.prepare(
      "SELECT * FROM auth_candidate_acceptances WHERE status = 'queued' ORDER BY started_at, rowid",
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const record = mapRow(row);
      const input = this.inputs.get(record.id);
      if (!input) { this.cancel(record.id, "Interrupted before it started."); continue; }
      if (!this.options.current(record)) { this.cancel(record.id, "The request or its candidate changed before the run started."); continue; }
      this.start(record, input);
      return;
    }
  }

  private start(record: CandidateAcceptanceRecord, input: CandidateAcceptanceRunInput): void {
    const { db, executor, now, live, changed } = this.options;
    db.prepare("UPDATE auth_candidate_acceptances SET status = 'running' WHERE id = ? AND status = 'queued'").run(record.id);
    changed(readCandidateAcceptance(db, record.id)!);
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => executor({ ...input, signal: controller.signal }))
      .catch((error: unknown): CandidateAcceptanceOutcome => ({ status: "failed", result: null, error: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => {
        if (!live()) return;
        if (closeCandidateAcceptance(db, record.id, outcome, now())) changed(readCandidateAcceptance(db, record.id)!);
      })
      .finally(() => {
        this.inputs.delete(record.id);
        this.active = null;
        this.pump();
      });
    this.active = { id: record.id, controller, done };
  }
}

export function acceptanceCheckoutPath(): string {
  return path.join(getUserHome(), ".cache", "mandible", "acceptance", "checkout");
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal });
  return stdout.trim();
}

function collect(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal: AbortSignal }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Not detached: stopping the daemon's service stops an in-flight run too.
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const bound = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-4 * 1024 * 1024);
    child.stdout.on("data", (chunk: Buffer) => { stdout = bound(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = bound(stderr, chunk); });
    // The acceptance command stops its owned daemon, gateway and app on SIGTERM.
    const stop = () => { child.kill("SIGTERM"); };
    const timer = setTimeout(stop, options.timeout);
    options.signal.addEventListener("abort", stop, { once: true });
    const settle = () => { clearTimeout(timer); options.signal.removeEventListener("abort", stop); };
    child.on("error", (error) => { settle(); reject(error); });
    child.on("close", (code) => { settle(); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Production executor. The persistent detached acceptance checkout keeps Rust
 * and dependency builds incremental; it is owned by this daemon and is reset to
 * the exact pin commit before each run.
 */
export const runCandidateAcceptance: CandidateAcceptanceExecutor = async (input) => {
  const { signal } = input;
  const checkout = acceptanceCheckoutPath();
  const common = fs.realpathSync(await git(input.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.env, signal));
  if (!fs.existsSync(checkout)) {
    fs.mkdirSync(path.dirname(checkout), { recursive: true, mode: 0o700 });
    await git(input.repoRoot, ["worktree", "add", "--detach", checkout, input.pinSha], input.env, signal);
  } else {
    const owner = fs.realpathSync(await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.env, signal));
    if (owner !== common) throw new Error(`Acceptance checkout ${checkout} belongs to another repository; preserving it.`);
    await git(checkout, ["checkout", "--detach", "--force", input.pinSha], input.env, signal);
    await git(checkout, ["clean", "-ffd"], input.env, signal);
  }
  if (await git(checkout, ["rev-parse", "HEAD"], input.env, signal) !== input.pinSha) throw new Error("Acceptance checkout is not at the exact candidate.");
  const { stdout: runtimeOut } = await execFileAsync("/bin/sh", [path.join(checkout, "scripts", "bun-runtime.sh")], { cwd: checkout, env: input.env, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS, signal });
  const runtime = runtimeOut.trim();
  // The candidate's own canonical runtime PATH: pinned runtime and checkout
  // CLI, then native macOS tools (a Homebrew `xattr` breaks app bundling),
  // then Cargo and the inherited hook PATH.
  const { stdout: runtimePath } = await execFileAsync(runtime, [path.join(checkout, "scripts", "runtime-environment-path.mjs"), runtime, checkout], { cwd: checkout, env: input.env, encoding: "utf8", timeout: 30_000, signal });
  const env = { ...input.env, MANDIBLE_RUNTIME: runtime, PATH: runtimePath.trim() };
  await execFileAsync(runtime, ["install", "--frozen-lockfile"], { cwd: checkout, env, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal });
  const run = await collect(runtime, [path.join(checkout, "scripts", "candidate-acceptance.mjs"), "--project", input.projectId, "--work-unit", input.workUnitId], { cwd: checkout, env, timeout: ACCEPTANCE_TIMEOUT_MS, signal });
  const parse = (text: string): Record<string, unknown> | null => {
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  };
  const result = parse(run.stdout.trim()) ?? parse(run.stderr.trim().split("\n").at(-1) ?? "");
  if (run.code === 0 && result?.status === "passed" && result.candidate === input.pinSha) return { status: "passed", result, error: null };
  const reason = (typeof result?.error === "string" && result.error) || (typeof result?.cleanup_error === "string" && result.cleanup_error)
    || (result?.status === "passed" ? "Acceptance passed for a different candidate revision." : null)
    || run.stderr.trim().split("\n").slice(-5).join("\n") || `Acceptance exited with ${run.code}.`;
  return { status: result?.status === "unavailable" ? "unavailable" : "failed", result, error: reason };
};
