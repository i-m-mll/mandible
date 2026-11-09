/**
 * Candidate acceptance as an approval precondition for runtime self-update
 * merges (issues a09b4d2, 7d83fe5).
 *
 * The daemon runs the candidate's own `scripts/candidate-acceptance.mjs` on the
 * exact retained merge candidate (the pin commit whose parents are the reviewed
 * base and head) and records the outcome bound to that candidate. Approval
 * accepts only a passing record whose pin, tree, base and head equal the request's
 * current candidate, so any base or head movement makes a result stale.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CandidateAcceptancePhase, CandidateAcceptanceProjection } from "./contracts.js";
import { getDaemonLogger } from "./daemon-log.js";
import type { Db } from "./db.js";
import { getUserHome } from "./platform-paths.js";
import { readAcceptanceFailure } from "../scripts/acceptance-result.mjs";
import { ACCEPTANCE_EXPECTED_TOTAL_MS, ACCEPTANCE_STAGES, acceptanceBackstop, parsePhaseLine, ProgressWatch, scriptIdleMs, stageWarning, totalWarning,
  type AcceptanceBackstop, type AcceptancePhaseEvent, type AcceptancePhaseName } from "../scripts/acceptance-progress.mjs";
import { acceptanceFailure, compactFailure, describeAcceptanceFailure, failureText, sentence, stageActivity } from "../scripts/acceptance-failure.mjs";

import { runSupervisedCommand, type SupervisedCommandFailure } from "../scripts/process-group-supervisor.mjs";

export const CANDIDATE_ACCEPTANCE_INTERRUPTED = failureText("environment", "Acceptance stopped because the Mandible daemon restarted while it was running");

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
  /** From the stored result; empty while running or when the run stored none. */
  phases: CandidateAcceptancePhase[];
  warnings: string[];
}

export interface CandidateAcceptanceInput {
  repoRoot: string;
  pinSha: string;
  projectId: string;
  workUnitId: string;
  env: NodeJS.ProcessEnv;
  /** Aborted when the run is stopped; the executor stops its owned processes. */
  signal: AbortSignal;
  /** Each stage start and end as the run reaches it. */
  onPhase?: (event: AcceptancePhaseEvent) => void;
}

export interface CandidateAcceptanceOutcome {
  status: "passed" | "failed";
  result: unknown;
  error: string | null;
}

export type CandidateAcceptanceExecutor = (input: CandidateAcceptanceInput) => Promise<CandidateAcceptanceOutcome>;

const MAX_RESULT_CHARS = 64 * 1024;

function subprocessFailureEvidence(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object" || !("processGroupSettled" in error)) return null;
  const failure = error as SupervisedCommandFailure;
  return { exit_code: failure.exitCode, code: failure.code, signal: failure.signal,
    timed_out: failure.timedOut, aborted: failure.aborted, duration_ms: failure.durationMs,
    ...(failure.hung ? { idle_ms: failure.idleMs, silent_ms: failure.silentMs, last_output_at: failure.lastOutputAt } : {}),
    process_group_settled: failure.processGroupSettled,
    stdout: failure.stdout?.slice(-4096), stderr: failure.stderr?.slice(-4096),
    stdout_truncated: failure.stdoutTruncated || (failure.stdout?.length ?? 0) > 4096,
    stderr_truncated: failure.stderrTruncated || (failure.stderr?.length ?? 0) > 4096 };
}

/** Stored acceptance inputs; the queue overlays its live waiting/running state. */
export interface CandidateAcceptanceRead {
  applies: boolean;
  latest: CandidateAcceptanceRecord | null;
}

function storedPhases(text: string | null): CandidateAcceptancePhase[] {
  const value = text ? JSON.parse(text) as unknown : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, { status?: unknown; elapsed_ms?: unknown; expected_ms?: unknown }>).map(([name, phase]) => ({
    name, status: String(phase?.status ?? "unknown"),
    elapsed_ms: typeof phase?.elapsed_ms === "number" ? phase.elapsed_ms : null,
    expected_ms: typeof phase?.expected_ms === "number" ? phase.expected_ms : null,
  }));
}

function storedWarnings(text: string | null): string[] {
  const value = text ? JSON.parse(text) as unknown : null;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function latestCandidateAcceptances(db: Db, requestIds: string[]): Map<string, CandidateAcceptanceRecord> {
  if (requestIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, error, phases_json, warnings_json
    FROM (
      SELECT auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at, finished_at, error,
        CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.phases') END AS phases_json,
        CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.warnings') END AS warnings_json,
        ROW_NUMBER() OVER (PARTITION BY auth_request_id ORDER BY started_at DESC, rowid DESC) AS rank
      FROM auth_candidate_acceptances WHERE auth_request_id IN (${requestIds.map(() => "?").join(", ")})
    ) WHERE rank = 1
  `).all(...requestIds) as Array<Omit<CandidateAcceptanceRecord, "phases" | "warnings"> & { auth_request_id: string; phases_json: string | null; warnings_json: string | null }>;
  return new Map(rows.map(({ auth_request_id, phases_json, warnings_json, ...record }) => [auth_request_id,
    { ...record, phases: storedPhases(phases_json), warnings: storedWarnings(warnings_json) }]));
}

export function latestCandidateAcceptance(db: Db, requestId: string): CandidateAcceptanceRecord | null {
  return latestCandidateAcceptances(db, [requestId]).get(requestId) ?? null;
}

/**
 * The request view's acceptance state for one request's current candidate.
 * `open` means a run of it is waiting or running; `live` is that run's
 * phases so far.
 */
export function candidateAcceptanceProjection(
  record: CandidateAcceptanceRecord | null,
  candidate: CandidateAcceptanceCandidate | null,
  open: boolean,
  live: CandidateAcceptancePhase[] = [],
): CandidateAcceptanceProjection {
  const current = record && candidate && record.pin_sha === candidate.pin_sha && record.tree_sha === candidate.tree_sha
    && record.base_sha === candidate.base_sha && record.head_sha === candidate.head_sha ? record : null;
  const none = { warnings: [], phases: [] };
  if (open) return { state: "running", reason: null, started_at: current?.status === "running" ? current.started_at : null, finished_at: null, warnings: [], phases: live };
  if (!record) return { state: "none", reason: null, started_at: null, finished_at: null, ...none };
  if (!current) {
    return { state: "stale", reason: `It ran for base ${record.base_sha.slice(0, 12)} and head ${record.head_sha.slice(0, 12)}, not the current candidate.`,
      started_at: record.started_at, finished_at: record.finished_at, ...none };
  }
  return { state: current.status, reason: current.error, started_at: current.started_at, finished_at: current.finished_at,
    ...(current.status === "running" ? none : { warnings: current.warnings, phases: current.phases }) };
}

/** Null when the current candidate passed; otherwise why approval refuses. */
export function candidateAcceptanceRefusal(acceptance: CandidateAcceptanceProjection, requestId: string): string | null {
  const run = `\`mandible auth acceptance run ${requestId.slice(0, 8)}\``;
  switch (acceptance.state) {
    case "passed": return null;
    case "running": return "Candidate acceptance of this exact candidate is in progress. Approve after it passes.";
    case "failed": return `Candidate acceptance of this exact candidate failed. ${sentence(acceptance.reason ?? "It recorded no reason.")} To run it again: ${run}.`;
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
  private active: { requestId: string; pinSha: string; recordId: string; controller: AbortController; phases: Map<string, { status: string; started_at: number; elapsed_ms: number | null }> } | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly executor: CandidateAcceptanceExecutor,
    private readonly now: () => number,
    private readonly changed: (requestId: string) => void,
    /** Capture live authority before execution; reconcile synchronously inside the verdict transaction. */
    private readonly prepareFinalization?: (requestId: string, candidate: CandidateAcceptanceCandidate) => (recordId: string) => void,
  ) {}

  /** Fail the rows a previous daemon left running; a restart interrupted them. */
  start(): void {
    this.db.prepare("UPDATE auth_candidate_acceptances SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'")
      .run(this.now(), CANDIDATE_ACCEPTANCE_INTERRUPTED);
  }

  /** The running run's phases so far; a running phase reports its elapsed time until now. */
  livePhases(requestId: string): CandidateAcceptancePhase[] {
    if (this.active?.requestId !== requestId) return [];
    const now = this.now();
    return [...this.active.phases].map(([name, phase]) => ({ name, status: phase.status,
      elapsed_ms: phase.elapsed_ms ?? now - phase.started_at, expected_ms: ACCEPTANCE_STAGES[name as AcceptancePhaseName]?.expectedMs ?? null }));
  }

  private phase(requestId: string, event: AcceptancePhaseEvent): void {
    const active = this.active;
    if (active?.requestId !== requestId) return;
    const previous = active.phases.get(event.name);
    const startedAt = event.status === "running" || !previous ? this.now() - (event.elapsed_ms ?? 0) : previous.started_at;
    active.phases.set(event.name, { status: event.status, started_at: startedAt, elapsed_ms: event.elapsed_ms });
    getDaemonLogger()("info", "auth_candidate_acceptance_phase", { subsystem: "auth", auth_request_id: requestId,
      phase: event.name, status: event.status, elapsed_ms: event.elapsed_ms, expected_ms: ACCEPTANCE_STAGES[event.name as AcceptancePhaseName]?.expectedMs ?? null });
    this.changed(requestId);
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
    this.abort(requestId, "Acceptance stopped because the request's candidate changed; the run of the new candidate replaces this one.");
    this.waiting.set(requestId, { candidate, input });
    this.schedule(requestId);
  }

  /** Schedule waiting isolated runs after the current run. */
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
    this.waiting.delete(requestId);
    const { candidate } = job;
    const recordId = randomUUID();
    const startedAt = this.now();
    this.db.prepare(
      `INSERT INTO auth_candidate_acceptances (id, auth_request_id, pin_sha, tree_sha, base_sha, head_sha, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(recordId, requestId, candidate.pin_sha, candidate.tree_sha, candidate.base_sha, candidate.head_sha, startedAt);
    const controller = new AbortController();
    this.active = { requestId, pinSha: candidate.pin_sha, recordId, controller, phases: new Map() };
    this.changed(requestId);
    let finalize: ((recordId: string) => void) | undefined;
    const outcome = await Promise.resolve().then(async () => {
      if (controller.signal.aborted) return { status: "failed" as const, result: null, error: "Acceptance stopped." };
      finalize = this.prepareFinalization?.(requestId, candidate);
      const input = job.input();
      return this.executor({ ...input, env: { ...input.env, MANDIBLE_ACCEPTANCE_ID: recordId, MANDIBLE_ACCEPTANCE_REQUEST: requestId,
        MANDIBLE_ACCEPTANCE_STARTED_AT: String(startedAt),
        MANDIBLE_ACCEPTANCE_TREE: candidate.tree_sha, MANDIBLE_ACCEPTANCE_BASE: candidate.base_sha, MANDIBLE_ACCEPTANCE_HEAD: candidate.head_sha },
        signal: controller.signal, onPhase: event => this.phase(requestId, event) });
    })
      .catch((error: unknown): CandidateAcceptanceOutcome => ({ status: "failed", result: subprocessFailureEvidence(error) ? { subprocess: subprocessFailureEvidence(error) } : null, error: error instanceof Error ? error.message : String(error) }));
    this.active = null;
    this.finish(requestId, recordId, withTotalWarning(outcome, this.now() - startedAt), finalize);
  }

  private finish(requestId: string, recordId: string, outcome: CandidateAcceptanceOutcome, finalize?: (recordId: string) => void): void {
    if (this.stopped) return;
    let result: string | null;
    try { result = outcome.result == null ? null : JSON.stringify(outcome.result) ?? null; }
    catch (error) {
      result = null;
      outcome = { status: 'failed', result: null, error: failureText('environment', `The acceptance result could not be stored: ${error instanceof Error ? error.message : String(error)}`) };
    }
    if (result && result.length > MAX_RESULT_CHARS) {
      const value = outcome.result as Record<string, unknown>;
      const checks = value?.checks as { initial_transport_error?: { code?: unknown; message?: unknown }; failure_logs?: unknown; route_cost?: Record<string, unknown> } | undefined;
      const text = (field: unknown, limit: number) => typeof field === 'string' ? field.slice(0, limit) : null;
      const failureLogs = Array.isArray(checks?.failure_logs) ? checks.failure_logs
        .filter(log => log && ['daemon', 'gateway', 'route-cost', 'source-preview'].includes(log.name)).slice(0, 4)
        .map(log => ({ name: log.name, sha256: text(log.sha256, 64), bytes: typeof log.bytes === 'number' ? log.bytes : null,
          excerpt: typeof log.excerpt === 'string' ? log.excerpt.slice(-4000) : null })) : undefined;
      result = JSON.stringify({ truncated: true, status: text(value?.status, 16), candidate: text(value?.candidate, 128), binding: value?.binding, timing: value?.timing, phases: value?.phases, warnings: value?.warnings,
        secondary_errors: Array.isArray(value?.secondary_errors) ? value.secondary_errors.map(item => text(item, 512)).slice(0, 8) : undefined,
        subprocess: value?.subprocess, error: text(value?.error, 1024), failure: compactFailure(value?.failure), receipt: text(value?.receipt, 512), checks: {
          ...(checks?.initial_transport_error ? { initial_transport_error: {
            code: text(checks.initial_transport_error.code, 64), message: text(checks.initial_transport_error.message, 512),
          } } : {}),
          ...(failureLogs ? { failure_logs: failureLogs } : {}),
          ...(checks?.route_cost ? { route_cost: {
            complete: checks.route_cost.complete, diagnostic: checks.route_cost.diagnostic,
            error: text(checks.route_cost.error, 512), counts: checks.route_cost.counts, progress: checks.route_cost.progress,
            pending_confirmations: Array.isArray(checks.route_cost.pending_confirmations) ? checks.route_cost.pending_confirmations.slice(0, 32) : undefined,
            routes_not_run: Array.isArray(checks.route_cost.routes_not_run) ? checks.route_cost.routes_not_run.slice(0, 32) : undefined,
            source_stderr: text(checks.route_cost.source_stderr, 4000),
          } } : {}),
        } });
    }
    const close = this.db.prepare(
      "UPDATE auth_candidate_acceptances SET status = ?, finished_at = ?, result_json = ?, error = ? WHERE id = ? AND status = 'running'",
    );
    let closed: boolean;
    try {
      closed = this.db.transaction(() => {
        const changed = close.run(outcome.status, this.now(), result, outcome.error, recordId).changes === 1;
        // The receipt selection and lifecycle revision commit with the verdict.
        // A replay of an already terminal row must not revise the request.
        if (changed && outcome.status === 'passed') finalize?.(recordId);
        if (changed) this.db.prepare("UPDATE auth_candidate_acceptances SET finished_at = ? WHERE id = ?").run(this.now(), recordId);
        return changed;
      })();
    } catch (error) {
      closed = close.run('failed', this.now(), result,
        failureText('environment', `Acceptance finished, but recording its verdict on the request failed: ${error instanceof Error ? error.message : String(error)}`), recordId).changes === 1;
    }
    if (closed) this.changed(requestId);
  }
}

/** A passing run that took longer than the expected total, checkout included, gets the whole-run warning. */
function withTotalWarning(outcome: CandidateAcceptanceOutcome, elapsedMs: number): CandidateAcceptanceOutcome {
  if (outcome.status !== "passed" || elapsedMs <= ACCEPTANCE_EXPECTED_TOTAL_MS || !outcome.result || typeof outcome.result !== "object") return outcome;
  const result = outcome.result as { warnings?: unknown };
  return { ...outcome, result: { ...result, warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), totalWarning(elapsedMs)] } };
}

export function acceptanceCheckoutPath(): string {
  return path.join(getUserHome(), ".cache", "mandible", "acceptance", "checkout");
}

const checkoutIdleMs = ACCEPTANCE_STAGES.checkout.idleMs!;

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const { stdout } = await runSupervisedCommand("git", args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, capture: true, idleMs: checkoutIdleMs, graceMs: 750, maxBuffer: 4 * 1024 * 1024, signal });
  return stdout.trim();
}

export interface AcceptanceCommandCompletion {
  code: number | null; stdout: string; stderr: string; failure: string | null;
  diagnostics: Record<string, unknown> | null;
}

export function candidateAcceptanceOutcome(pin: string, run: AcceptanceCommandCompletion,
  checkpoint: { result: Record<string, unknown> | null; error: string | null }): CandidateAcceptanceOutcome {
  const parse = (text: string): Record<string, unknown> | null => {
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
    catch { return null; }
  };
  const parsed = parse(run.stdout.trim()) ?? parse(run.stderr.trim().split('\n').at(-1) ?? '');
  const primary = (run.failure || run.code !== 0 || parsed?.status !== 'passed' || parsed.candidate !== pin) && checkpoint.result ? checkpoint.result : parsed;
  const secondary = [checkpoint.error, run.failure, primary !== parsed && typeof parsed?.error === 'string' ? parsed.error : null].filter((text): text is string => !!text);
  const result = primary || run.diagnostics || secondary.length ? { ...primary,
    ...(run.failure ? { subprocess: run.diagnostics } : {}), ...(secondary.length ? { secondary_errors: secondary } : {}) } : null;
  if (!run.failure && run.code === 0 && parsed?.status === 'passed' && parsed.candidate === pin) return { status: 'passed', result, error: null };
  const stderr = run.stderr.trim().split('\n').slice(-5).join('\n');
  const reason = (typeof primary?.error === 'string' && primary.error)
    || (typeof primary?.cleanup_error === 'string' && describeAcceptanceFailure(new Error(primary.cleanup_error), 'finalization').text)
    || (run.failure && failureText('either', `The acceptance run ended without reporting a result: ${run.failure}`))
    || (secondary[0] && failureText('either', secondary[0]))
    || (parsed?.status === 'passed' && failureText('environment', `Acceptance reported a pass for commit ${String(parsed.candidate)}, not for the candidate ${pin}, so the pass does not count`))
    || failureText('either', `The acceptance run exited with code ${run.code} without reporting a result${stderr ? `; its last output was: ${stderr}` : ''}`);
  return { status: 'failed', result, error: reason };
}

/** Reset the persistent acceptance checkout to the exact pin and install its dependencies. */
async function prepareAcceptanceCheckout(input: CandidateAcceptanceInput, signal: AbortSignal): Promise<{ checkout: string; runtime: string; env: NodeJS.ProcessEnv }> {
  const checkout = acceptanceCheckoutPath();
  const common = fs.realpathSync(await git(input.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.env, signal));
  if (!fs.existsSync(checkout)) {
    fs.mkdirSync(path.dirname(checkout), { recursive: true, mode: 0o700 });
    await git(input.repoRoot, ["worktree", "add", "--detach", checkout, input.pinSha], input.env, signal);
  } else {
    const owner = fs.realpathSync(await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"], input.env, signal));
    if (owner !== common) throw acceptanceFailure("environment", `The acceptance checkout at ${checkout} belongs to another repository, so acceptance left it alone instead of reusing it.`);
    await git(checkout, ["checkout", "--detach", "--force", input.pinSha], input.env, signal);
    await git(checkout, ["clean", "-ffd"], input.env, signal);
  }
  const checkedOut = await git(checkout, ["rev-parse", "HEAD"], input.env, signal);
  if (checkedOut !== input.pinSha) throw acceptanceFailure("environment", `The acceptance checkout is at commit ${checkedOut} after checking out the candidate ${input.pinSha}.`, { checked_out: checkedOut, candidate: input.pinSha });
  const { stdout: runtimeOut } = await runSupervisedCommand("/bin/sh", [path.join(checkout, "scripts", "bun-runtime.sh")], { cwd: checkout, env: input.env, capture: true, idleMs: checkoutIdleMs, graceMs: 750, signal });
  const runtime = runtimeOut.trim();
  // The candidate's own canonical runtime PATH: pinned runtime and checkout
  // CLI, then native macOS tools (a Homebrew `xattr` breaks app bundling),
  // then Cargo and the inherited hook PATH.
  const { stdout: runtimePath } = await runSupervisedCommand(runtime, [path.join(checkout, "scripts", "runtime-environment-path.mjs"), runtime, checkout], { cwd: checkout, env: input.env, capture: true, idleMs: checkoutIdleMs, graceMs: 750, signal });
  const env = { ...input.env, MANDIBLE_RUNTIME: runtime, PATH: runtimePath.trim() };
  await runSupervisedCommand(runtime, ["install", "--frozen-lockfile"], { cwd: checkout, env, capture: true, idleMs: checkoutIdleMs, graceMs: 750, maxBuffer: 16 * 1024 * 1024, signal })
    .catch((error: SupervisedCommandFailure) => {
      if (error.code === "HUNG" || error.aborted || error.exitCode == null) throw error;
      throw acceptanceFailure("either", `Installing the candidate's dependencies (bun install --frozen-lockfile) failed with exit code ${error.exitCode}. A lockfile that does not match package.json points at the branch; a network or registry problem points at the environment.`);
    });
  return { checkout, runtime, env };
}

/**
 * Run one acceptance command under the run-wide backstop. When the backstop
 * fires, the command is aborted and reaped like any other failure, and the
 * failure is the backstop's, naming the stage the run was in.
 */
export async function runAcceptanceCommand<T>(backstop: AcceptanceBackstop, command: (signal: AbortSignal) => Promise<T>): Promise<T> {
  try { return await command(backstop.signal); }
  catch (error) { throw backstop.explain(error); }
}

/**
 * The executor's watch over the acceptance script's output. Each phase line
 * the script prints sets the silence the script may keep to that phase's hung
 * threshold, and is handed to `onPhase`.
 */
export function acceptanceScriptWatch(onPhase: (event: AcceptancePhaseEvent) => void, now: () => number = Date.now):
  { watch: ProgressWatch; onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => void } {
  const watch = new ProgressWatch({ stage: "The acceptance script", idleMs: scriptIdleMs("startup"), now });
  let pending = "";
  return { watch, onOutput: (chunk, stream) => {
    if (stream !== "stderr") return;
    const lines = (pending + chunk.toString("utf8")).split("\n");
    pending = lines.pop()!.slice(-4096);
    for (const line of lines) {
      const event = parsePhaseLine(line);
      if (!event) continue;
      watch.threshold(scriptIdleMs(event.status === "running" ? event.name : "script"));
      watch.stage = `${stageActivity(event.name as AcceptancePhaseName)} (in the acceptance script)`;
      onPhase(event);
    }
  } };
}

type CheckoutPhase = { status: "passed" | "failed"; started_at: number; elapsed_ms: number; expected_ms: number; over_expected: boolean };

/** Put the executor's checkout stage first in the result's phases, with its warning. */
function withCheckoutPhase(outcome: CandidateAcceptanceOutcome, checkout: CheckoutPhase): CandidateAcceptanceOutcome {
  const result = (outcome.result && typeof outcome.result === "object" ? outcome.result : {}) as { phases?: unknown; warnings?: unknown };
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return { ...outcome, result: { ...result,
    phases: { checkout, ...(result.phases && typeof result.phases === "object" ? result.phases : {}) },
    warnings: checkout.over_expected ? [stageWarning("checkout", checkout.elapsed_ms, checkout.expected_ms), ...warnings] : warnings } };
}

/**
 * Production executor. The persistent detached acceptance checkout keeps Rust
 * and dependency builds incremental; it is owned by this daemon and is reset to
 * the exact pin commit before each run. No stage fails for taking long: each
 * is stopped only when it goes silent past its hung threshold, and the run as
 * a whole only at the backstop.
 */
export const runCandidateAcceptance: CandidateAcceptanceExecutor = async (input) => {
  const startedAt = Number(input.env.MANDIBLE_ACCEPTANCE_STARTED_AT ?? Date.now());
  const backstop = acceptanceBackstop(input.signal, { startedAt });
  try { return await acceptanceRun(input, startedAt, backstop); }
  finally { backstop.close(); }
};

async function acceptanceRun(input: CandidateAcceptanceInput, startedAt: number, backstop: AcceptanceBackstop): Promise<CandidateAcceptanceOutcome> {
  const onPhase = (event: AcceptancePhaseEvent) => {
    backstop.enter(event.name as AcceptancePhaseName);
    input.onPhase?.(event);
  };
  const checkoutStarted = Date.now();
  onPhase({ name: "checkout", status: "running", elapsed_ms: null });
  const prepared = await runAcceptanceCommand(backstop, signal => prepareAcceptanceCheckout(input, signal)).then(value => ({ value }), (error: unknown) => ({ error }));
  const elapsed = Date.now() - checkoutStarted;
  const checkout: CheckoutPhase = { status: "error" in prepared ? "failed" : "passed", started_at: checkoutStarted, elapsed_ms: elapsed,
    expected_ms: ACCEPTANCE_STAGES.checkout.expectedMs, over_expected: elapsed > ACCEPTANCE_STAGES.checkout.expectedMs };
  onPhase({ name: "checkout", status: checkout.status, elapsed_ms: elapsed });
  if ("error" in prepared) {
    const subprocess = subprocessFailureEvidence(prepared.error);
    return withCheckoutPhase({ status: "failed", result: subprocess ? { subprocess } : null, error: describeAcceptanceFailure(prepared.error, "checkout").text }, checkout);
  }
  const { checkout: checkoutPath, runtime, env } = prepared.value;
  const { watch, onOutput } = acceptanceScriptWatch(onPhase);
  const run = await runAcceptanceCommand(backstop, signal => runSupervisedCommand(runtime, [path.join(checkoutPath, "scripts", "candidate-acceptance.mjs"), "--project", input.projectId, "--work-unit", input.workUnitId],
    { cwd: checkoutPath, env, capture: true, watch, onOutput, graceMs: 750, maxBuffer: 16 * 1024 * 1024, signal }))
    .then(result => ({ ...result, failure: null as string | null, diagnostics: null as Record<string, unknown> | null }))
    .catch((error: SupervisedCommandFailure & { cause?: unknown }) => {
      const subprocess = (error.code === "BACKSTOP" ? error.cause : error) as SupervisedCommandFailure;
      return { code: subprocess.exitCode ?? null, stdout: subprocess.stdout ?? "", stderr: subprocess.stderr ?? "", failure: error.message, diagnostics: subprocessFailureEvidence(subprocess),
        backstop: error.code === "BACKSTOP" ? error : null };
    });
  watch.close();
  if ("backstop" in run && run.backstop) {
    return withCheckoutPhase({ status: "failed", result: { subprocess: run.diagnostics }, error: describeAcceptanceFailure(run.backstop, backstop.stage).text }, checkout);
  }
  const response = candidateAcceptanceOutcome(input.pinSha, run, { result: null, error: null });
  if (response.status === 'passed') return withCheckoutPhase(response, checkout);
  const checkpoint = input.env.MANDIBLE_ACCEPTANCE_ID && input.env.MANDIBLE_ACCEPTANCE_REQUEST && input.env.MANDIBLE_ACCEPTANCE_TREE
    ? readAcceptanceFailure(path.dirname(checkoutPath), {
      recordId: input.env.MANDIBLE_ACCEPTANCE_ID, requestId: input.env.MANDIBLE_ACCEPTANCE_REQUEST,
      projectId: input.projectId, workUnitId: input.workUnitId,
      pin_sha: input.pinSha, tree_sha: input.env.MANDIBLE_ACCEPTANCE_TREE!,
      base_sha: input.env.MANDIBLE_ACCEPTANCE_BASE!, head_sha: input.env.MANDIBLE_ACCEPTANCE_HEAD!,
      started_at: startedAt,
    }) : { result: null, error: null };
  return withCheckoutPhase(candidateAcceptanceOutcome(input.pinSha, run, checkpoint), checkout);
}
