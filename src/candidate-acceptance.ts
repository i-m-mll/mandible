/**
 * Issue a09b4d2 — candidate acceptance as an approval precondition for runtime
 * self-update merges.
 *
 * The daemon runs the candidate's own `scripts/candidate-acceptance.mjs` on the
 * exact retained merge candidate (the pin commit whose parents are the reviewed
 * base and head) and records the outcome bound to that candidate. Approval
 * accepts only a passing record whose tree, base and head equal the request's
 * current candidate, so any base or head movement makes a result stale.
 */
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { getUserHome } from "./platform-paths.js";

const execFileAsync = promisify(execFile);

export type CandidateAcceptanceStatus = "running" | "passed" | "failed" | "unavailable";

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

export interface CandidateAcceptanceInput {
  repoRoot: string;
  pinSha: string;
  projectId: string;
  workUnitId: string;
  env: NodeJS.ProcessEnv;
}

export interface CandidateAcceptanceOutcome {
  status: Exclude<CandidateAcceptanceStatus, "running">;
  result: unknown;
  error: string | null;
}

export type CandidateAcceptanceExecutor = (input: CandidateAcceptanceInput) => Promise<CandidateAcceptanceOutcome>;

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

export function latestCandidateAcceptance(db: Db, requestId: string): CandidateAcceptanceRecord | null {
  const row = db.prepare(
    "SELECT * FROM auth_candidate_acceptances WHERE auth_request_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).get(requestId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function startCandidateAcceptanceRecord(db: Db, requestId: string, candidate: CandidateAcceptanceCandidate, at: number): CandidateAcceptanceRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO auth_candidate_acceptances (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(id, requestId, candidate.pin_sha, candidate.tree_sha, candidate.base_sha, candidate.head_sha, at);
  return latestCandidateAcceptance(db, requestId)!;
}

export function finishCandidateAcceptanceRecord(db: Db, id: string, outcome: CandidateAcceptanceOutcome, at: number): void {
  let result = outcome.result === undefined ? null : JSON.stringify(outcome.result);
  if (result && result.length > MAX_RESULT_CHARS) {
    const value = outcome.result as Record<string, unknown>;
    result = JSON.stringify({ truncated: true, status: value?.status ?? null, candidate: value?.candidate ?? null, error: value?.error ?? null, receipt: value?.receipt ?? null });
  }
  db.prepare(
    "UPDATE auth_candidate_acceptances SET status = ?, finished_at = ?, result_json = ?, error = ? WHERE id = ? AND status = 'running'",
  ).run(outcome.status, at, result, outcome.error, id);
}

/** A running row no live run in this process owns was interrupted by a restart. */
export function failInterruptedCandidateAcceptances(db: Db, liveIds: ReadonlySet<string>, at: number): void {
  const rows = db.prepare("SELECT id FROM auth_candidate_acceptances WHERE status = 'running'").all() as Array<{ id: string }>;
  for (const row of rows) {
    if (liveIds.has(row.id)) continue;
    finishCandidateAcceptanceRecord(db, row.id, { status: "failed", result: null, error: "Interrupted before completion; run it again." }, at);
  }
}

/** Null when the record passes for exactly this candidate; otherwise the refusal. */
export function candidateAcceptanceRefusal(record: CandidateAcceptanceRecord | null, candidate: Partial<CandidateAcceptanceCandidate>, requestId: string): string | null {
  const run = `\`mandible auth acceptance run ${requestId.slice(0, 8)}\``;
  if (!candidate.tree_sha || !candidate.base_sha || !candidate.head_sha) {
    return "Runtime self-update approval requires an exact retained merge candidate, and this request has none. Resubmit it.";
  }
  if (!record) return `Runtime self-update approval requires a passing candidate acceptance of the exact candidate merge, and none has run. Run ${run}.`;
  const exact = record.tree_sha === candidate.tree_sha && record.base_sha === candidate.base_sha && record.head_sha === candidate.head_sha;
  if (!exact) {
    return `The recorded candidate acceptance (${record.status}) was for a different candidate (tree ${record.tree_sha.slice(0, 12)}, base ${record.base_sha.slice(0, 12)}, head ${record.head_sha.slice(0, 12)}); the base or head has moved since. Run ${run} again.`;
  }
  if (record.status === "running") return "Candidate acceptance of this exact candidate is still running. Approve after it passes.";
  if (record.status !== "passed") return `Candidate acceptance of this exact candidate ${record.status === "unavailable" ? "was unavailable" : "failed"}${record.error ? `: ${record.error}` : ""}. Fix the cause and run ${run} again.`;
  return null;
}

export function acceptanceCheckoutPath(): string {
  return path.join(getUserHome(), ".cache", "mandible", "acceptance", "checkout");
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function collect(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Not detached: stopping the daemon's service stops an in-flight run too.
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const bound = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-4 * 1024 * 1024);
    child.stdout.on("data", (chunk: Buffer) => { stdout = bound(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = bound(stderr, chunk); });
    // The acceptance command stops its owned daemon, gateway and app on SIGTERM.
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, options.timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Production executor. The persistent detached acceptance checkout keeps Rust
 * and dependency builds incremental; it is owned by this daemon and is reset to
 * the exact pin commit before each run.
 */
export const runCandidateAcceptance: CandidateAcceptanceExecutor = async (input) => {
  const checkout = acceptanceCheckoutPath();
  const common = fs.realpathSync(await git(input.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.env));
  if (!fs.existsSync(checkout)) {
    fs.mkdirSync(path.dirname(checkout), { recursive: true, mode: 0o700 });
    await git(input.repoRoot, ["worktree", "add", "--detach", checkout, input.pinSha], input.env);
  } else {
    const owner = fs.realpathSync(await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.env));
    if (owner !== common) throw new Error(`Acceptance checkout ${checkout} belongs to another repository; preserving it.`);
    await git(checkout, ["checkout", "--detach", "--force", input.pinSha], input.env);
    await git(checkout, ["clean", "-ffd"], input.env);
  }
  if (await git(checkout, ["rev-parse", "HEAD"], input.env) !== input.pinSha) throw new Error("Acceptance checkout is not at the exact candidate.");
  const { stdout: runtimeOut } = await execFileAsync("/bin/sh", [path.join(checkout, "scripts", "bun-runtime.sh")], { cwd: checkout, env: input.env, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS });
  const runtime = runtimeOut.trim();
  const env = { ...input.env, PATH: `${path.dirname(runtime)}${path.delimiter}${input.env.PATH ?? ""}` };
  await execFileAsync(runtime, ["install", "--frozen-lockfile"], { cwd: checkout, env, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const run = await collect(runtime, [path.join(checkout, "scripts", "candidate-acceptance.mjs"), "--project", input.projectId, "--work-unit", input.workUnitId], { cwd: checkout, env, timeout: ACCEPTANCE_TIMEOUT_MS });
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
