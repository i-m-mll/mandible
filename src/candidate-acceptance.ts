/**
 * Candidate acceptance as an approval precondition for runtime self-update
 * merges (issues a09b4d2, 7d83fe5).
 *
 * The daemon runs the candidate's own `scripts/candidate-acceptance.mjs` on the
 * exact retained merge candidate (the pin commit whose parents are the reviewed
 * base and head) and records the outcome bound to that candidate. Approval
 * accepts only a passing record whose tree, base and head equal the request's
 * current candidate, so any base or head movement makes a result stale.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CandidateAcceptanceProjection } from "./contracts.js";
import { getDaemonLogger } from "./daemon-log.js";
import type { Db } from "./db.js";
import { getUserHome } from "./platform-paths.js";

const execFileAsync = promisify(execFile);

export const CANDIDATE_ACCEPTANCE_INTERRUPTED = "Interrupted by a daemon restart.";

export type CandidateAcceptanceStatus = "running" | "passed" | "failed";

export interface CandidateAcceptanceCandidate {
  pin_sha: string;
  tree_sha: string;
  base_sha: string;
  head_sha: string;
}

export interface CandidateAcceptanceRecord extends CandidateAcceptanceCandidate {
  status: CandidateAcceptanceStatus;
  started_at: number;
  finished_at: number | null;
  error: string | null;
}

export interface CandidateAcceptanceInput {
  repoRoot: string;
  pinSha: string;
  projectId: string;
  workUnitId: string;
  env: NodeJS.ProcessEnv;
  /** Aborted when the run is stopped; the executor stops its owned processes. */
  signal: AbortSignal;
}

export interface CandidateAcceptanceOutcome {
  status: "passed" | "failed";
  result: unknown;
  error: string | null;
}

export type CandidateAcceptanceExecutor = (input: CandidateAcceptanceInput) => Promise<CandidateAcceptanceOutcome>;

const MAX_RESULT_CHARS = 64 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const ACCEPTANCE_TIMEOUT_MS = 30 * 60 * 1000;

/** Stored acceptance inputs; the queue overlays its live waiting/running state. */
export interface CandidateAcceptanceRead {
  applies: boolean;
  latest: CandidateAcceptanceRecord | null;
}

export function latestCandidateAcceptances(db: Db, requestIds: string[]): Map<string, CandidateAcceptanceRecord> {
  if (requestIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, error
    FROM (
      SELECT auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, error,
        ROW_NUMBER() OVER (PARTITION BY auth_request_id ORDER BY started_at DESC, rowid DESC) AS rank
      FROM auth_candidate_acceptances WHERE auth_request_id IN (${requestIds.map(() => "?").join(", ")})
    ) WHERE rank = 1
  `).all(...requestIds) as Array<CandidateAcceptanceRecord & { auth_request_id: string }>;
  return new Map(rows.map(({ auth_request_id, ...record }) => [auth_request_id, record]));
}

export function latestCandidateAcceptance(db: Db, requestId: string): CandidateAcceptanceRecord | null {
  return latestCandidateAcceptances(db, [requestId]).get(requestId) ?? null;
}

/** The request view's acceptance state for one request's current candidate. `open` means a run of it is waiting or running. */
export function candidateAcceptanceProjection(
  record: CandidateAcceptanceRecord | null,
  candidate: CandidateAcceptanceCandidate | null,
  open: boolean,
): CandidateAcceptanceProjection {
  const current = record && candidate && record.tree_sha === candidate.tree_sha
    && record.base_sha === candidate.base_sha && record.head_sha === candidate.head_sha ? record : null;
  if (open) return { state: "running", reason: null, started_at: current?.status === "running" ? current.started_at : null, finished_at: null };
  if (!record) return { state: "none", reason: null, started_at: null, finished_at: null };
  if (!current) {
    return { state: "stale", reason: `It ran for base ${record.base_sha.slice(0, 12)} and head ${record.head_sha.slice(0, 12)}, not the current candidate.`,
      started_at: record.started_at, finished_at: record.finished_at };
  }
  return { state: current.status, reason: current.error, started_at: current.started_at, finished_at: current.finished_at };
}

/** Null when the current candidate passed; otherwise why approval refuses. */
export function candidateAcceptanceRefusal(acceptance: CandidateAcceptanceProjection, requestId: string): string | null {
  const run = `\`mandible auth acceptance run ${requestId.slice(0, 8)}\``;
  switch (acceptance.state) {
    case "passed": return null;
    case "running": return "Candidate acceptance of this exact candidate is in progress. Approve after it passes.";
    case "failed": return `Candidate acceptance of this exact candidate failed: ${acceptance.reason}. Fix the cause and run ${run} again.`;
    case "stale": return `The recorded candidate acceptance was for a different candidate. ${acceptance.reason} Run ${run} for the current candidate.`;
    case "none": return `Runtime self-update approval requires a passing candidate acceptance of the exact candidate merge, and none has run. Run ${run}.`;
  }
}

/**
 * Runs acceptance one at a time, because every run uses the same checkout.
 * Runs wait in memory; a durable row exists only once a run starts.
 */
export class CandidateAcceptanceRuns {
  private chain: Promise<void> = Promise.resolve();
  private readonly waiting = new Map<string, { candidate: CandidateAcceptanceCandidate; input: () => Omit<CandidateAcceptanceInput, "signal"> }>();
  private active: { requestId: string; pinSha: string; recordId: string; controller: AbortController } | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly executor: CandidateAcceptanceExecutor,
    private readonly now: () => number,
    private readonly changed: (requestId: string) => void,
    private readonly handoffLocked: () => boolean,
  ) {}

  /** Fail the rows a previous daemon left running; a restart interrupted them. */
  start(): void {
    this.db.prepare("UPDATE auth_candidate_acceptances SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'")
      .run(this.now(), CANDIDATE_ACCEPTANCE_INTERRUPTED);
  }

  /** Whether a run of exactly this pin is waiting or running for the request. */
  isOpen(requestId: string, pinSha: string): boolean {
    return this.waiting.get(requestId)?.candidate.pin_sha === pinSha || (this.active?.requestId === requestId && this.active.pinSha === pinSha);
  }

  /**
   * Run acceptance of the request's candidate after any earlier run, replacing
   * the request's previous run. `input` is resolved when the run starts; if it
   * throws, the run fails with that reason.
   */
  enqueue(requestId: string, candidate: CandidateAcceptanceCandidate, input: () => Omit<CandidateAcceptanceInput, "signal">): void {
    this.abort(requestId, "Replaced by a run of a newer candidate.");
    this.waiting.set(requestId, { candidate, input });
    this.schedule(requestId);
  }

  /** Resume runs deferred by a handoff once the installation is available. */
  resume(): void {
    for (const requestId of this.waiting.keys()) this.schedule(requestId);
  }

  private schedule(requestId: string): void {
    this.chain = this.chain.then(() => this.next(requestId)).catch((error: unknown) => {
      getDaemonLogger()("error", "auth_candidate_acceptance_crashed", { subsystem: "auth", auth_request_id: requestId, error: String(error) });
    });
  }

  /** Drop the request's waiting run and fail its running one with `reason`. */
  abort(requestId: string, reason: string): void {
    this.waiting.delete(requestId);
    const active = this.active;
    if (active?.requestId !== requestId) return;
    this.active = null;
    active.controller.abort();
    this.finish(requestId, active.recordId, { status: "failed", result: null, error: reason });
  }

  /** Stop without recording; the next daemon start records the interrupted run. Settles when it has stopped. */
  stop(): Promise<void> {
    this.stopped = true;
    this.waiting.clear();
    this.active?.controller.abort();
    return this.chain;
  }

  /** Settles when every run enqueued so far has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  private async next(requestId: string): Promise<void> {
    const job = this.waiting.get(requestId);
    if (!job || this.stopped) return;
    if (this.handoffLocked()) return;
    this.waiting.delete(requestId);
    const { candidate } = job;
    const recordId = randomUUID();
    this.db.prepare(
      `INSERT INTO auth_candidate_acceptances (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(recordId, requestId, candidate.pin_sha, candidate.tree_sha, candidate.base_sha, candidate.head_sha, this.now());
    const controller = new AbortController();
    this.active = { requestId, pinSha: candidate.pin_sha, recordId, controller };
    this.changed(requestId);
    const outcome = await Promise.resolve().then(async () => {
      if (controller.signal.aborted) return { status: "failed" as const, result: null, error: "Acceptance stopped." };
      return this.executor({ ...job.input(), signal: controller.signal });
    })
      .catch((error: unknown): CandidateAcceptanceOutcome => ({ status: "failed", result: null, error: error instanceof Error ? error.message : String(error) }));
    this.active = null;
    this.finish(requestId, recordId, outcome);
  }

  private finish(requestId: string, recordId: string, outcome: CandidateAcceptanceOutcome): void {
    if (this.stopped) return;
    let result = outcome.result == null ? null : JSON.stringify(outcome.result);
    if (result && result.length > MAX_RESULT_CHARS) {
      const value = outcome.result as Record<string, unknown>;
      result = JSON.stringify({ truncated: true, status: value?.status ?? null, candidate: value?.candidate ?? null, error: value?.error ?? null, receipt: value?.receipt ?? null });
    }
    const closed = this.db.prepare(
      "UPDATE auth_candidate_acceptances SET status = ?, finished_at = ?, result_json = ?, error = ? WHERE id = ? AND status = 'running'",
    ).run(outcome.status, this.now(), result, outcome.error, recordId).changes === 1;
    if (closed) this.changed(requestId);
  }
}

export function acceptanceCheckoutPath(): string {
  return path.join(getUserHome(), ".cache", "mandible", "acceptance", "checkout");
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal });
  return stdout.trim();
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
  // Not detached: stopping the daemon's service stops an in-flight run too. The
  // acceptance command stops its owned daemon, gateway and app on SIGTERM.
  const run = await execFileAsync(runtime, [path.join(checkout, "scripts", "candidate-acceptance.mjs"), "--project", input.projectId, "--work-unit", input.workUnitId],
    { cwd: checkout, env, encoding: "utf8", timeout: ACCEPTANCE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGTERM", signal })
    .then(({ stdout, stderr }) => ({ code: 0 as number | null, stdout, stderr }))
    .catch((error: { code?: unknown; stdout?: string; stderr?: string }) => ({ code: typeof error.code === "number" ? error.code : null, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  const parse = (text: string): Record<string, unknown> | null => {
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  };
  const result = parse(run.stdout.trim()) ?? parse(run.stderr.trim().split("\n").at(-1) ?? "");
  if (run.code === 0 && result?.status === "passed" && result.candidate === input.pinSha) return { status: "passed", result, error: null };
  const reason = (typeof result?.error === "string" && result.error) || (typeof result?.cleanup_error === "string" && result.cleanup_error)
    || (result?.status === "passed" ? "Acceptance passed for a different candidate revision." : null)
    || run.stderr.trim().split("\n").slice(-5).join("\n") || `Acceptance exited with ${run.code}.`;
  return { status: "failed", result, error: result?.status === "unavailable" ? `Acceptance was unavailable: ${reason}` : reason };
};
