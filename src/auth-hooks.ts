/**
 * Auth hooks — configurable post-auth-action hooks.
 *
 * Replaces the hardcoded build_dist_if_src_changed / restart_mandible_if_dist_changed
 * logic that was previously in auth-merge.sh. Hooks are stored in the auth_hooks
 * table and executed after successful auth actions (merge, commit, etc.).
 *
 * Bug: 4afab83
 *
 * Issue 27241e6 — hook execution is durable, bounded, and honest:
 *
 *   - Execution state lives in `auth_hook_executions`, one row per
 *     (auth request, hook), written BEFORE the process is spawned. A daemon
 *     that dies between the merge and hook completion therefore leaves a
 *     durable record of unfinished convergence instead of losing it.
 *   - Each row snapshots the hook id and the exact command bytes plus their
 *     SHA-256 digest at the moment execution begins. A retry reruns those
 *     snapshotted bytes — it never reruns the merge, and it never silently
 *     substitutes a command the operator edited afterwards.
 *   - Execution is at-least-once with a bounded attempt budget. The row is the
 *     idempotency key: planning is INSERT OR IGNORE, so a resumed sweep adopts
 *     an existing row rather than starting a second run of the same hook.
 *   - The child process receives a scrubbed allowlist environment, never the
 *     daemon's full ambient `process.env`.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { verifyRuntimeHandoffAuthority, type RuntimePublicationBinding } from "./runtime-handoff-proof.js";
import { readRuntimeHandoffLock, runtimeHandoffLockRefusal, type RuntimeHandoffLock } from "../scripts/runtime-handoff-lock.mjs";
import { inspectServiceDefinitions, serviceInstallationContext, runtimeHandoffReadiness } from "../scripts/service-definitions.mjs";
import type { AuthPublicationBlocker } from "./contracts.js";
import { authRequestChangesBuildInputs } from "./runtime-build-scope.js";
import { observationPending, runtimeObservationAcceptance, runtimeVerificationDisposition, runtimeHandoffDisposition, runtimeReceiptAcceptanceMarker, RuntimeObservationError } from "../scripts/runtime-observation.mjs";

import { extractSuccessfulMergeCommitSha } from "./auth-signature-verification.js";
import { getDb } from "./db.js";
import { getMandibleHome } from "./platform-paths.js";
import type { Db } from "./db.js";
import type {
  AuthConvergence,
  AuthConvergenceHookSummary,
  AuthConvergenceState,
  AuthRuntimeVerification,
  AuthHook,
  AuthHookAlert,
  AuthHookExecutionResult,
  AuthHookInput,
  AuthHookRun,
  AuthHookRunAttempt,
  AuthHookRunState,
  AuthRequest,
  AuthRequestType,
} from "./types.js";

export type { AuthHookExecutionResult };

export interface RuntimeHandoffJournal {
  schema: string;
  binding: RuntimePublicationBinding;
  bindingDigest: string;
  phase: string;
  error?: string;
  receipt?: unknown;
  acknowledgedAt?: number;
  bridgeInstalled?: boolean;
  cleanupStartedAt?: number;
  launch?: unknown;
  attempt?: { id: string; actor: unknown; enteredAt: number; deadline: number; state: 'running' | 'complete' | 'failed';
    effects: Record<string, unknown>; receipt?: unknown; receiptDigest?: string; fence?: unknown };
  cleanup?: { state: 'pending' | 'complete' | 'failed'; [key: string]: unknown };
  recovery?: { digest: string; failureDigest: string; receipt: unknown; actor: unknown; observedAt: number };
}

export interface RuntimeVerificationResult {
  outcome: 'confirmed' | 'pending';
  reason?: string;
  retainedFailure?: boolean;
}

export interface RuntimeHandoffClient {
  readRuntimeHandoff(home: string, requestId: string, executionId: string): RuntimeHandoffJournal | null | Promise<RuntimeHandoffJournal | null>;
  readRuntimeHandoffPhase(home: string, requestId: string, executionId: string): string | undefined | Promise<string | undefined>;
  verifyRuntimeHandoffReceipt(journal: RuntimeHandoffJournal, options: { probe: boolean }): Promise<unknown>;
  runtimeRecoveryEvidenceKey?(journal: RuntimeHandoffJournal): Promise<{ outcome: 'confirmed' | 'pending'; key: string; reason?: string } | null>;
  observeFailedRuntimeHandoff?(journal: RuntimeHandoffJournal, actor: unknown, options?: { observerToken?: string }): Promise<RuntimeHandoffJournal>;
  withRuntimeObservation?<T>(journal: RuntimeHandoffJournal, operation: (token: string) => Promise<T>): Promise<T>;
  assertRuntimeHandoffOwner?(journal: RuntimeHandoffJournal): void;
  persistRuntimeRecoveryObservation?(journal: RuntimeHandoffJournal): void;
  recheckRuntimeObservation?(journal: RuntimeHandoffJournal, receipt: unknown): void;
  completeRuntimeHandoffRecovery?(journal: RuntimeHandoffJournal): Promise<RuntimeHandoffJournal>;
  runtimeHandoffDrainIdentity?(journal: RuntimeHandoffJournal): string | null;
  acknowledgeRuntimeHandoff(binding: RuntimePublicationBinding, options?: { verifiedReceipt?: unknown; acceptedReceiptDigest?: string }): Promise<unknown>;
  closeQuiescentRuntimeHandoff?(home: string, options: { actor: unknown }): Promise<{
    outcome: 'released' | 'blocked' | 'none'; requestId?: string; executionId?: string; reason?: string }>;
  retireFailedRuntimeHandoff(home: string, input: { bindingDigest: string; actor: unknown; reason: string }): unknown;
}

/** The required hook whose runtime handoff self-updates this installation. */
export const MANDIBLE_REBUILD_HOOK_ID = "builtin-mandible-rebuild";

// Most hooks should finish quickly. The built-in Mandible hook may perform a
// cold Rust/Tauri release build after native changes, so it gets a deliberate
// longer ceiling instead of being killed halfway through bundle production.
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const MANDIBLE_REBUILD_HOOK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Issue 27241e6 — attempt budget for one (request, hook) pair. Three attempts
 * covers the realistic transient failures (a busy lock, a host that was mid
 * restart) without turning a genuinely broken hook into an unbounded retry
 * loop that never surfaces to the operator.
 */
export const AUTH_HOOK_MAX_ATTEMPTS = 3;

/** Persisted hook output is bounded so one runaway hook cannot bloat the DB. */
const MAX_PERSISTED_OUTPUT_CHARS = 64 * 1024;

export function authHookTimeoutMs(hookId: string): number {
  return hookId === "builtin-mandible-rebuild"
    ? MANDIBLE_REBUILD_HOOK_TIMEOUT_MS
    : DEFAULT_HOOK_TIMEOUT_MS;
}

// --- Execution environment contract (issue 27241e6) ---------------------------

/**
 * The only ambient variables a hook inherits. Everything else the daemon holds
 * — tokens, provider credentials, session ids, editor and shell customization,
 * `MANDIBLE_*` daemon configuration — is deliberately dropped, because a hook
 * command is operator-registered but not operator-supervised at run time.
 *
 * A hook that needs anything beyond this list must resolve it itself from the
 * repository it runs in, or the operator must widen this list deliberately.
 */
export const AUTH_HOOK_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

/**
 * PATH is controlled rather than inherited: an inherited PATH lets whatever
 * launched the daemon decide which `git`, `node`, or `npm` a protected-merge
 * finalizer executes.
 */
export const AUTH_HOOK_BASE_PATH = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

/** Setting key an operator can use to replace the controlled hook PATH. */
export const AUTH_HOOK_PATH_SETTING = "auth_hooks.path";

export function authHookPath(db: Db | null, homeDir: string): string {
  const override = readSettingValue(db, AUTH_HOOK_PATH_SETTING);
  if (override && override.trim()) {
    return override.trim();
  }
  const userBins = homeDir
    ? [`${homeDir}/.local/bin`, `${homeDir}/.cargo/bin`, `${homeDir}/bin`]
    : [];
  return [...userBins, AUTH_HOOK_BASE_PATH].join(":");
}

function readSettingValue(db: Db | null, key: string): string | null {
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

export interface AuthHookEnvContext {
  hook_id: string;
  hook_label: string;
  attempt: number;
  execution_id: string;
  command_digest: string;
}

/**
 * Build the scrubbed environment for one hook attempt. Callers must never merge
 * `process.env` into the result — the whole point of this function is that the
 * hook contract is an explicit allowlist plus the documented MANDIBLE_* facts.
 */
export function buildAuthHookEnv(
  request: AuthRequest,
  context: AuthHookEnvContext,
  options: { db?: Db | null; source?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};
  for (const key of AUTH_HOOK_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  if (!env.HOME) {
    // A hook with no HOME cannot resolve `~/.local/bin` or a git config; fall
    // back to the process owner's home rather than handing it an empty string.
    try {
      env.HOME = os.homedir();
    } catch {
      /* no home resolvable — leave unset */
    }
  }
  env.PATH = authHookPath(options.db ?? null, env.HOME ?? "");
  // A finalizer is non-interactive by construction; say so rather than letting
  // a hook inherit an interactive terminal's capabilities.
  env.TERM = "dumb";
  env.CI = "true";

  env.MANDIBLE_AUTH_REQUEST_ID = request.id;
  env.MANDIBLE_AUTH_TYPE = request.type;
  env.MANDIBLE_AUTH_REPO = request.repo ?? "";
  env.MANDIBLE_AUTH_BRANCH = request.head_branch ?? "";
  env.MANDIBLE_AUTH_BASE_BRANCH = request.base_branch ?? "";
  // These reviewed revisions stay stable after the protected checkout moves
  // on. Post-merge hooks must use them instead of retry-time HEAD when deciding
  // which convergence work the original merge required.
  env.MANDIBLE_AUTH_MERGE_BASE_SHA = request.merge_preflight_base_sha ?? "";
  env.MANDIBLE_AUTH_MERGE_HEAD_SHA = request.merge_head_sha ?? "";
  env.MANDIBLE_AUTH_MERGE_COMMIT_SHA = extractSuccessfulMergeCommitSha(request.output) ?? "";
  env.MANDIBLE_HOOK_ID = context.hook_id;
  env.MANDIBLE_HOOK_LABEL = context.hook_label;
  env.MANDIBLE_HOOK_ATTEMPT = String(context.attempt);
  env.MANDIBLE_HOOK_EXECUTION_ID = context.execution_id;
  env.MANDIBLE_HOOK_COMMAND_DIGEST = context.command_digest;
  return env;
}

export function authHookCommandDigest(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

// --- Convergence projection ---------------------------------------------------

/**
 * Issue 27241e6 — the honest answer to "is this merge live?".
 *
 *   none      — no hook was registered for this request; merged is all there is
 *   complete  — every planned hook run reached `complete`
 *   failed    — a required hook exhausted its attempts
 *   pending   — a run is still runnable (never attempted, or retryable)
 *
 * `failed` outranks `pending`: once a required hook is terminally failed the
 * request is not going to converge on its own, and saying "pending" would be
 * the same dishonesty this issue exists to remove.
 */
export function convergenceStateFromRuns(runs: readonly AuthHookRun[]): AuthConvergenceState {
  if (runs.length === 0) return "none";
  if (runs.some((run) => run.required && run.state === "failed")) return "failed";
  if (runs.some((run) => run.state === "pending" || run.state === "running")) return "pending";
  return "complete";
}

export function isRuntimeHandoffPending(result: Pick<AuthHookExecutionResult, "hook_id" | "exit_code" | "output">): boolean {
  return result.hook_id === MANDIBLE_REBUILD_HOOK_ID && result.exit_code === 75 && /MANDIBLE_RUNTIME_HANDOFF_PENDING:[0-9a-f]{64}/.test(result.output);
}

export function formatHookExecutionResult(result: AuthHookExecutionResult, retry = false): string {
  const status = isRuntimeHandoffPending(result)
    ? "handoff pending: the new daemon is starting; convergence will be reported"
    : result.exit_code === 0 ? "ok" : `failed (exit ${result.exit_code})`;
  return `[hook: ${result.label}] ${retry ? "retry " : ""}${status} (${result.duration_ms}ms)\n`;
}

export function summarizeConvergenceRun(run: AuthHookRun): AuthConvergenceHookSummary {
  return {
    hook_id: run.hook_id,
    label: run.hook_label,
    state: run.state,
    required: run.required,
    attempts: run.attempts,
    max_attempts: run.max_attempts,
    exit_code: run.exit_code,
    failure: run.state === "failed" ? run.output.trim().split("\n").at(-1)?.trim() || null : null,
    command_digest: run.command_digest,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

/**
 * A handoff whose hook row is terminal and whose journal is acknowledged or
 * failed has nothing left for reconciliation to adopt, acknowledge, or record.
 * Reconciling it would only re-verify an old publication against the current
 * checkout, at several synchronous Git children per run, for every
 * self-update in the installation's history (issue 63c9031). The exception is
 * a failed journal whose verification-only recovery the row has already
 * accepted: a crash after that commit left the journal to complete. A missing
 * journal is never settled; it may be unreadable only for now. The active failed
 * owner bypasses this historical-settlement predicate for automatic recovery.
 */
export function runtimeHandoffSettled(run: Pick<AuthHookRun, "state" | "output">, journalPhase: string | undefined): boolean {
  if (journalPhase === 'retired') return true;
  if (run.state !== "complete" && run.state !== "failed") return false;
  if (journalPhase === "failed") return !(run.state === "complete" && run.output.includes(RECOVERY_ACCEPTED_MARKER));
  return journalPhase === "acknowledged";
}

const RECOVERY_ACCEPTED_MARKER = "MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:";

/** Whether the row committed acceptance of exactly this journal's verification-only recovery. */
function recoveryAccepted(run: AuthHookRun, journal: RuntimeHandoffJournal): boolean {
  return !!journal.recovery && runtimeObservationAcceptance(run, journal) === 'accepted';
}

export class AuthHookManager {
  private readonly db: Db;
  private readonly handoffClient?: RuntimeHandoffClient;
  private readonly serviceDefinitionInspector: typeof inspectServiceDefinitions;
  /**
   * Requests whose rebuild handoff was observed settled, valued by the run's
   * version at that observation. A settled handoff becomes unsettled only
   * through a run update or verification-only recovery, which forgets its
   * entry. The active failed owner is checked separately for changed evidence.
   */
  private readonly settledHandoffs = new Map<string, string>();
  /**
   * Requests whose reconciliation keeps failing on a terminal run, which cannot
   * record the failure, valued by the failure classes reported. Such a run is
   * still retried on every sweep; only the report is deduplicated.
   */
  private readonly reportedHandoffFailures = new Map<string, Set<string>>();
  private reconciliationInFlight = false;
  private readonly recoveryEvidence = new Map<string, { key: string; retryAt: number }>();
  private readonly verificationInFlight = new Set<string>();

  constructor(db?: Db, options: { handoffClient?: RuntimeHandoffClient; serviceDefinitionInspector?: typeof inspectServiceDefinitions } = {}) {
    this.db = db ?? getDb();
    this.handoffClient = options.handoffClient;
    this.serviceDefinitionInspector = options.serviceDefinitionInspector ?? inspectServiceDefinitions;
  }

  private handoffPath(run: AuthHookRun): string {
    if (!/^[a-zA-Z0-9-]+$/.test(run.auth_request_id) || !/^[a-zA-Z0-9-]+$/.test(run.id)) throw new Error("Invalid runtime handoff identity");
    return path.join(getMandibleHome(), "config", "local-sessions", "handoff", `${run.auth_request_id}-${run.id}`, "journal.json");
  }

  private hasRuntimeHandoff(run: AuthHookRun): boolean {
    return run.hook_id === MANDIBLE_REBUILD_HOOK_ID && (fs.existsSync(this.handoffPath(run)) || isRuntimeHandoffPending(run) || run.state === "complete" && /MANDIBLE_RUNTIME_(?:HANDOFF|RECOVERY|RECEIPT)_ACCEPTED:[0-9a-f]{64}/.test(run.output));
  }

  /** Whether merging this repo self-updates the running installation. */
  selfUpdatesRuntime(repo: string | null | undefined): boolean {
    return this.selfUpdatingRepos(repo ? [repo] : []).has(repo ?? "");
  }

  selfUpdatingRepos(repos: string[]): Set<string> {
    if (repos.length === 0) return new Set();
    const rows = this.db.prepare(
      "SELECT repo_pattern FROM auth_hooks WHERE id = ? AND enabled = 1 AND auth_type = 'merge'",
    ).all(MANDIBLE_REBUILD_HOOK_ID) as Array<{ repo_pattern: string }>;
    const patterns = new Set(rows.map(row => row.repo_pattern));
    return new Set(repos.filter(repo => Boolean(repo) && (patterns.has("*") || patterns.has(repo))));
  }

  runtimeHandoffLock(): RuntimeHandoffLock | null {
    return readRuntimeHandoffLock(getMandibleHome());
  }

  async prepareRuntimePublication(actor: unknown): Promise<AuthPublicationBlocker | null> {
    const owner = this.runtimeHandoffLock();
    if (!owner) return null;
    const runtime: RuntimeHandoffClient = this.handoffClient ?? await import(new URL('../scripts/runtime-handoff.mjs', import.meta.url).href);
    if (!runtime.closeQuiescentRuntimeHandoff) return { code: 'runtime_handoff_lock', message: runtimeHandoffLockRefusal(owner) };
    const result = await runtime.closeQuiescentRuntimeHandoff(getMandibleHome(), { actor });
    return result.outcome === 'blocked' ? { code: 'runtime_handoff_lock', message: result.reason || runtimeHandoffLockRefusal(owner) } : null;
  }

  async publicationBlocker(inspectOwnership: boolean): Promise<AuthPublicationBlocker | null> {
    const lock = this.runtimeHandoffLock();
    if (lock) return { code: "runtime_handoff_lock", message: runtimeHandoffLockRefusal(lock) };
    if (!inspectOwnership) return null;
    const inspection = await this.serviceDefinitionInspector(serviceInstallationContext({ home: getMandibleHome() }));
    // A handoff admitted while inspection was in flight still takes priority.
    const currentLock = this.runtimeHandoffLock();
    if (currentLock) return { code: "runtime_handoff_lock", message: runtimeHandoffLockRefusal(currentLock) };
    const readiness = runtimeHandoffReadiness(inspection);
    return readiness.ok ? null : { code: readiness.refusal.category, message: readiness.refusal.message };
  }

  private recordRuntimeRetirement(requestId: string, executionId: string): void {
    const run = this.getRun(requestId, MANDIBLE_REBUILD_HOOK_ID);
    if (!run || run.id !== executionId) return;
    this.db.prepare("UPDATE auth_hook_executions SET state = 'failed', exit_code = 1, output = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'running')").run(
      truncateOutput(`${run.output}\nRuntime handoff retired by the operator; convergence was not confirmed.`), Date.now(), Date.now(), run.id);
    this.settledHandoffs.delete(requestId);
  }

  async retireFailedRuntimeHandoff(input: { bindingDigest: string; reason: string }, actor: unknown): Promise<unknown> {
    const runtime: RuntimeHandoffClient = this.handoffClient ?? await import(new URL('../scripts/runtime-handoff.mjs', import.meta.url).href);
    const result = await runtime.retireFailedRuntimeHandoff(getMandibleHome(), { ...input, actor });
    const retirement = result as { requestId?: string; executionId?: string };
    if (retirement?.requestId && retirement.executionId) this.recordRuntimeRetirement(retirement.requestId, retirement.executionId);
    return result;
  }

  runtimeHandoffOwnsRequest(requestId: string): boolean {
    return this.hasDurableTables() && this.listRuns(requestId).some(run => this.hasRuntimeHandoff(run));
  }

  async admittedDrainIdentity(requestId: string): Promise<string | null> {
    for (const run of this.listRuns(requestId)) {
      if (!this.hasRuntimeHandoff(run)) continue;
      const runtime: RuntimeHandoffClient = this.handoffClient ?? await import(new URL('../scripts/runtime-handoff.mjs', import.meta.url).href);
      const journal = await runtime.readRuntimeHandoff(getMandibleHome(), requestId, run.id);
      if (!journal || journal.binding.commandDigest !== run.command_digest || journal.binding.executionId !== run.id || journal.binding.requestId !== requestId) continue;
      const identity = runtime.runtimeHandoffDrainIdentity?.(journal);
      if (identity) return identity;
    }
    return null;
  }

  async verifyCurrentRuntimeHandoff(request: Pick<AuthRequest, 'id'>, actor: unknown, guard: () => void): Promise<RuntimeVerificationResult> {
    guard();
    if (this.verificationInFlight.has(request.id)) return { outcome: 'pending', reason: 'Runtime verification is already in progress.' };
    this.verificationInFlight.add(request.id);
    try { return await this.verifyCurrentRuntimeHandoffOnce(request, actor, guard); }
    catch (error) {
      if (!observationPending(error)) throw error;
      return { outcome: 'pending', reason: error.message, retainedFailure: this.getRun(request.id, MANDIBLE_REBUILD_HOOK_ID)?.state === 'failed' };
    } finally { this.verificationInFlight.delete(request.id); this.settledHandoffs.delete(request.id); }
  }

  private async withRuntimeHandoffObservation<T>(runtime: RuntimeHandoffClient, journal: RuntimeHandoffJournal, operation: (token?: string) => Promise<T>): Promise<T> {
    if (runtime.withRuntimeObservation) return runtime.withRuntimeObservation(journal, operation);
    if (!this.handoffClient) throw new Error('Runtime verification lease is unavailable.');
    return operation();
  }

  private assertCurrentHandoffOwner(runtime: RuntimeHandoffClient, journal: RuntimeHandoffJournal): void {
    if (runtime.assertRuntimeHandoffOwner) runtime.assertRuntimeHandoffOwner(journal);
    else if (!this.handoffClient) throw new Error('Runtime handoff owner verification is unavailable.');
    else {
      const owner = this.runtimeHandoffLock();
      if (owner && (owner.bindingDigest !== journal.bindingDigest || owner.requestId !== journal.binding.requestId
          || owner.executionId !== journal.binding.executionId)) throw new Error('Active runtime handoff owner changed during verification.');
    }
  }

  private acceptRuntimeReceipt(runtime: RuntimeHandoffClient, journal: RuntimeHandoffJournal, expected: AuthHookRun,
    guard: () => void, commitAdoption: () => void = () => {}): void {
    const marker = runtimeReceiptAcceptanceMarker(journal);
    if (!marker) throw new Error('Current runtime completion receipt is unavailable or inconsistent.');
    this.db.transaction(() => {
      guard();
      this.assertCurrentHandoffOwner(runtime, journal);
      const latest = this.getRun(expected.auth_request_id, expected.hook_id);
      if (!latest || latest.id !== expected.id || latest.command_digest !== expected.command_digest || latest.attempts !== expected.attempts) {
        throw new Error('Runtime hook changed during receipt acceptance.');
      }
      if (runtimeObservationAcceptance(latest, journal) === 'accepted') return;
      if (latest.state !== expected.state || latest.state === 'complete') throw new Error('Runtime hook acceptance differs from the current receipt.');
      commitAdoption();
      const now = Date.now();
      this.db.prepare("UPDATE auth_hook_executions SET state = 'complete', exit_code = 0, output = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(
        truncateOutput(`${latest.output}\n${marker}\n${JSON.stringify(journal.attempt!.receipt)}`), now, now, latest.id);
    }).immediate();
  }

  private async verifyCurrentRuntimeHandoffOnce(request: Pick<AuthRequest, "id">, actor: unknown, guard: () => void): Promise<RuntimeVerificationResult> {
    const expectedRun = this.getRun(request.id, 'builtin-mandible-rebuild');
    if (!expectedRun || !this.hasRuntimeHandoff(expectedRun)) throw new Error('Request has no retained runtime handoff.');
    const runtime: RuntimeHandoffClient = this.handoffClient ?? await import(new URL('../scripts/runtime-handoff.mjs', import.meta.url).href);
    if (!runtime.completeRuntimeHandoffRecovery || expectedRun.state !== 'complete'
        && (!runtime.persistRuntimeRecoveryObservation || !runtime.observeFailedRuntimeHandoff || !runtime.recheckRuntimeObservation)) throw new Error('Runtime verification-only recovery is unavailable.');
    const retained = await runtime.readRuntimeHandoff(getMandibleHome(), request.id, expectedRun.id);
    if (!retained || retained.binding.requestId !== request.id || retained.binding.executionId !== expectedRun.id || retained.binding.hookId !== expectedRun.hook_id || retained.binding.commandDigest !== expectedRun.command_digest) throw new Error('Retained recovery binding differs.');
    let journal: RuntimeHandoffJournal = retained;
    const verify = async (observerToken?: string): Promise<RuntimeVerificationResult> => {
      const run = this.getRun(request.id, 'builtin-mandible-rebuild');
      const current = await runtime.readRuntimeHandoff(getMandibleHome(), request.id, expectedRun.id);
      if (!run || run.id !== expectedRun.id || run.command_digest !== expectedRun.command_digest || run.attempts !== expectedRun.attempts
          || !current || current.bindingDigest !== retained.bindingDigest) throw new Error('Retained handoff changed before verification ownership was acquired.');
      journal = current;
      guard();
      const disposition = runtimeVerificationDisposition(run, journal);
      if (disposition === 'inconsistent') throw new Error('Retained runtime phase and hook acceptance are inconsistent.');
      if (disposition === 'retired') throw new Error('This runtime handoff was retired; recovery is terminally refused.');
      if (disposition === 'confirmed') return { outcome: 'confirmed' };
      this.assertCurrentHandoffOwner(runtime, journal);
      (await verifyRuntimeHandoffAuthority(this.db, journal.binding));
      if (journal.attempt) {
        if (disposition === 'helper_pending') return { outcome: 'pending', reason: 'The approved update attempt is still executing.' };
        let verifiedReceipt: unknown;
        if (disposition === 'observe') {
          journal = await runtime.observeFailedRuntimeHandoff!(journal, actor, { observerToken });
          if (runtimeHandoffDisposition(journal)?.runtime !== 'complete') return { outcome: 'pending', reason: 'The approved update attempt has not completed.' };
        }
        if (runtimeObservationAcceptance(run, journal) !== 'accepted') {
          verifiedReceipt = await runtime.verifyRuntimeHandoffReceipt(journal, { probe: true });
          await verifyRuntimeHandoffAuthority(this.db, journal.binding);
          this.acceptRuntimeReceipt(runtime, journal, run, guard);
        }
        await runtime.acknowledgeRuntimeHandoff(journal.binding, { verifiedReceipt, acceptedReceiptDigest: journal.attempt!.receiptDigest });
        return { outcome: 'confirmed' };
      }
      if (disposition === 'helper_pending') return { outcome: 'pending', reason: 'The initial handoff helper is still executing; verification has not started.', retainedFailure: run.state === 'failed' };
      if (disposition === 'await_acceptance') return { outcome: 'pending',
        reason: 'The helper completed; normal runtime completion acceptance is pending.', retainedFailure: run.state === 'failed' };
      if (disposition === 'observe') {
        journal = await runtime.observeFailedRuntimeHandoff!(journal, actor, { observerToken });
        const observed = journal;
        await verifyRuntimeHandoffAuthority(this.db, observed.binding);
        this.db.transaction(() => {
          guard();
          this.assertCurrentHandoffOwner(runtime, observed);
          const current = this.getRun(request.id, run.hook_id);
          if (!current || current.id !== run.id || current.command_digest !== run.command_digest || current.attempts !== run.attempts || current.state !== run.state) throw new Error('Retained hook changed during recovery observation.');
          const latest = this.db.prepare('SELECT state FROM auth_hook_executions WHERE id = ?').get(run.id) as { state: string };
          if (!['failed', 'pending', 'running'].includes(latest.state)) throw new Error('Verification hook is no longer pending or failed.');
          runtime.persistRuntimeRecoveryObservation!(observed);
          runtime.recheckRuntimeObservation!(observed, observed.recovery!.receipt);
          const now = Date.now();
          this.db.prepare("UPDATE auth_hook_executions SET state = 'complete', exit_code = 0, output = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state = ? AND command_digest = ?").run(
            truncateOutput(`${current.output}\n${RECOVERY_ACCEPTED_MARKER}${observed.recovery!.digest}\n${JSON.stringify(observed.recovery)}`), now, now, current.id, run.state, current.command_digest);
        }).immediate();
      }
      if (['failed', 'verification-pending', 'starting', 'observing'].includes(journal.phase)) journal = await runtime.completeRuntimeHandoffRecovery!(journal);
      const verifiedReceipt = await runtime.verifyRuntimeHandoffReceipt(journal, { probe: true });
      await runtime.acknowledgeRuntimeHandoff(journal.binding, { verifiedReceipt });
      return { outcome: 'confirmed' };
    };
    return this.withRuntimeHandoffObservation(runtime, journal, verify);
  }

  /** External handoff observations never consume an attempt or start another hook. */
  async reconcileRuntimeHandoffs(
    adopt: (binding: RuntimePublicationBinding, proof: Awaited<ReturnType<typeof verifyRuntimeHandoffAuthority>>) => Promise<() => void>,
    onFailed: (requestId: string, handoffError: string) => void | Promise<void>,
    onStuck: (requestId: string, error: string) => void | Promise<void> = () => {},
    onStuckCleared: (requestId: string) => void | Promise<void> = () => {},
  ): Promise<string[]> {
    if (this.reconciliationInFlight || !this.hasDurableTables()) return [];
    this.reconciliationInFlight = true;
    try {
      const activeLock = this.runtimeHandoffLock();
      const versions = this.db.prepare("SELECT auth_request_id, state, attempts, updated_at FROM auth_hook_executions WHERE hook_id = ? ORDER BY created_at ASC").all(MANDIBLE_REBUILD_HOOK_ID) as Array<Pick<AuthHookRun, "auth_request_id" | "state" | "attempts" | "updated_at">>;
      const accepted: string[] = [];
      for (const version of versions) {
        const activeOwner = activeLock?.requestId === version.auth_request_id;
        if (!activeOwner && this.settledHandoffs.get(version.auth_request_id) === runVersion(version)) continue;
        const run = this.getRun(version.auth_request_id, MANDIBLE_REBUILD_HOOK_ID);
        if (!run) continue;
        const settled = async () => {
          this.settledHandoffs.set(run.auth_request_id, runVersion(run));
          if (this.reportedHandoffFailures.delete(run.auth_request_id)) await onStuckCleared(run.auth_request_id);
        };
        if (!this.hasRuntimeHandoff(run)) {
          if (run.state === "complete" || run.state === "failed") await settled();
          continue;
        }
        let handoffError: string | undefined;
        try {
          const moduleUrl = new URL("../scripts/runtime-handoff.mjs", import.meta.url).href;
          const runtime: RuntimeHandoffClient = this.handoffClient ?? await import(moduleUrl);
          const ownsLock = activeOwner && activeLock.executionId === run.id;
          let journal = await runtime.readRuntimeHandoff(getMandibleHome(), run.auth_request_id, run.id);
          const currentAttempt = journal ? runtimeHandoffDisposition(journal) : null;
          if (!currentAttempt && journal?.phase === 'retired') {
            this.recordRuntimeRetirement(run.auth_request_id, run.id);
            await settled();
            continue;
          }
          if (!currentAttempt && !ownsLock && runtimeHandoffSettled(run, journal?.phase)) { await settled(); continue; }
          if (!journal) throw new Error("The retained runtime handoff journal is unavailable");
          const binding = journal.binding as RuntimePublicationBinding;
          if (journal.schema !== "mandible-runtime-handoff@1" || binding.requestId !== run.auth_request_id || binding.executionId !== run.id || binding.hookId !== run.hook_id || binding.commandDigest !== run.command_digest) throw new Error("Runtime handoff journal differs from the retained hook");
          if (currentAttempt?.runtime === 'pending') continue;
          if (currentAttempt?.runtime === 'failed') {
            handoffError = journal.error?.trim() || 'The current approved update attempt failed.';
            throw new Error(handoffError);
          }
          if (!currentAttempt) {
            if (run.state !== 'complete' && ownsLock && activeLock.bindingDigest === journal.bindingDigest
                && (journal.phase === 'failed' && run.state === 'failed'
                  || ['verification-pending', 'starting', 'observing'].includes(journal.phase) && journal.launch)) {
              if (!runtime.runtimeRecoveryEvidenceKey) throw new Error("Runtime recovery evidence observation is unavailable.");
              const evidence = await runtime.runtimeRecoveryEvidenceKey(journal);
              if (!evidence) {
                this.recoveryEvidence.delete(run.id);
                continue;
              }
              const publication = this.db.prepare("SELECT updated_at FROM auth_requests WHERE id = ?").get(run.auth_request_id) as { updated_at: number } | undefined;
              const key = `${journal.bindingDigest}:${journal.error ?? ""}:${runVersion(run)}:${publication?.updated_at}:${evidence.key}`;
              const previous = this.recoveryEvidence.get(run.id);
              if (previous?.key === key && Date.now() < previous.retryAt) continue;
              try {
                const result = await this.verifyCurrentRuntimeHandoff({ id: run.auth_request_id }, {
                  kind: "daemon_reconciliation", pid: process.pid,
                }, () => {});
                if (result.outcome === 'pending') {
                  this.recoveryEvidence.set(run.id, { key, retryAt: Date.now() + 5 * 60_000 });
                  continue;
                }
              } catch (error) {
                this.recoveryEvidence.set(run.id, { key, retryAt: Date.now() + 5 * 60_000 });
                throw error;
              }
              this.recoveryEvidence.delete(run.id);
              accepted.push(run.auth_request_id);
              await settled();
              continue;
            }
            if (['failed', 'verification-pending', 'starting', 'observing'].includes(journal.phase) && run.state === "complete") {
              if (!recoveryAccepted(run, journal)) { await settled(); continue; }
              const result = await this.verifyCurrentRuntimeHandoff({ id: run.auth_request_id }, { kind: 'daemon_reconciliation', pid: process.pid }, () => {});
              if (result.outcome === 'confirmed') { accepted.push(run.auth_request_id); await settled(); }
              continue;
            }
            if (journal.phase === "failed") {
              handoffError = journal.error?.trim() || "The runtime handoff failed without a recorded reason.";
              throw new Error(`Independent runtime handoff failed: ${handoffError}; inspect its retained journal and logs before repair`);
            }
            if (journal.phase !== "complete") continue;
          }
          let cleanupPending = false;
          const completed = await this.withRuntimeHandoffObservation(runtime, journal, async () => {
            const currentRun = this.getRun(run.auth_request_id, run.hook_id);
            const currentJournal = await runtime.readRuntimeHandoff(getMandibleHome(), run.auth_request_id, run.id);
            if (!currentRun || currentRun.id !== run.id || currentRun.command_digest !== run.command_digest
                || currentRun.attempts !== run.attempts || !currentJournal || currentJournal.bindingDigest !== journal!.bindingDigest
                || currentJournal.binding.executionId !== run.id || currentJournal.binding.commandDigest !== currentRun.command_digest) {
              throw new Error('Runtime handoff binding changed before completion ownership was acquired.');
            }
            const disposition = runtimeVerificationDisposition(currentRun, currentJournal);
            if (disposition === 'confirmed') return true;
            if (disposition === 'retired') { this.recordRuntimeRetirement(run.auth_request_id, run.id); return false; }
            if (disposition === 'inconsistent') throw new Error('Runtime completion phase and hook acceptance are inconsistent.');
            if (!['await_acceptance', 'acknowledge'].includes(disposition)) throw new RuntimeObservationError('observation_changed',
              'Runtime handoff is no longer ready for completion acceptance.', null, 'pending');
            this.assertCurrentHandoffOwner(runtime, currentJournal);
            const verifiedReceipt = disposition === 'await_acceptance'
              ? await runtime.verifyRuntimeHandoffReceipt(currentJournal, { probe: true }) : undefined;
            if (disposition === 'await_acceptance') {
              const proof = await verifyRuntimeHandoffAuthority(this.db, currentJournal.binding);
              const commitAdoption = await adopt(currentJournal.binding, proof);
              if (currentJournal.attempt) this.acceptRuntimeReceipt(runtime, currentJournal, currentRun, () => {}, commitAdoption);
              else this.db.transaction(() => {
                this.assertCurrentHandoffOwner(runtime, currentJournal);
                const latest = this.getRun(run.auth_request_id, run.hook_id);
                if (!latest || latest.id !== currentRun.id || latest.command_digest !== currentRun.command_digest
                    || latest.attempts !== currentRun.attempts) throw new Error('Runtime hook changed during completion acceptance.');
                if (latest.state !== currentRun.state) throw new RuntimeObservationError('observation_changed',
                  'Runtime hook acceptance advanced during verification.', null, 'pending');
                commitAdoption();
                const now = Date.now();
                this.db.prepare("UPDATE auth_hook_executions SET state = 'complete', exit_code = 0, output = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(
                  truncateOutput(`${latest.output}\nMANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${currentJournal.bindingDigest}\n${JSON.stringify(currentJournal.receipt)}`), now, now, latest.id,
                );
              }).immediate();
            }
            const acknowledgement = await runtime.acknowledgeRuntimeHandoff(currentJournal.binding, {
              verifiedReceipt, acceptedReceiptDigest: currentJournal.attempt?.receiptDigest,
            }) as { cleanup?: string } | undefined;
            cleanupPending = !!currentJournal.attempt && acknowledgement?.cleanup !== 'complete';
            return true;
          });
          if (completed) accepted.push(run.auth_request_id);
          if (!cleanupPending) await settled();
        } catch (error) {
          if (observationPending(error)) continue;
          // Record the refusal once: the row's first transition to failed is the
          // moment this handoff's rebuild failed, and the caller reports it then.
          const now = Date.now();
          const refused = this.db.prepare("UPDATE auth_hook_executions SET state = 'failed', output = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state NOT IN ('complete', 'failed')").run(
            truncateOutput(`${run.output}\nRuntime handoff recovery refused: ${error instanceof Error ? error.message : String(error)}`), now, now, run.id,
          );
          const message = handoffError ?? (error instanceof Error ? error.message : String(error));
          if (Number(refused.changes) > 0) await onFailed(run.auth_request_id, message);
          else {
            const reported = this.reportedHandoffFailures.get(run.auth_request_id) ?? new Set<string>();
            this.reportedHandoffFailures.set(run.auth_request_id, reported);
            if (!reported.has(failureClass(message))) {
              reported.add(failureClass(message));
              await onStuck(run.auth_request_id, message);
            }
          }
        }
      }
      return [...new Set(accepted)];
    } finally { this.reconciliationInFlight = false; }
  }

  /**
   * Find all enabled hooks matching a given repo name and auth type.
   * Matching rules:
   * - repo_pattern "*" matches all repos
   * - Otherwise, exact match against the repo name
   * - auth_type must match exactly
   */
  findMatchingHooks(repoName: string | undefined, authType: AuthRequestType): AuthHook[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_hooks
         WHERE enabled = 1
           AND auth_type = ?
           AND (repo_pattern = '*' OR repo_pattern = ?)
         ORDER BY position ASC, created_at ASC`
      )
      .all(authType, repoName ?? "") as Record<string, unknown>[];

    return rows.map(mapHookRow);
  }

  private matchingHooksForRequest(request: AuthRequest): AuthHook[] {
    return this.findMatchingHooks(request.repo, request.type)
      .filter(hook => hook.id !== MANDIBLE_REBUILD_HOOK_ID || authRequestChangesBuildInputs(request));
  }

  // --- Durable execution state ------------------------------------------------

  private hasDurableTables(): boolean {
    try {
      const row = this.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'auth_hook_executions'",
        )
        .get() as { present?: number } | undefined;
      return row?.present === 1;
    } catch {
      return false;
    }
  }

  /**
   * Snapshot the matching hooks for this request into durable rows. Idempotent:
   * an existing row for (request, hook) wins, so replanning after a crash
   * adopts the in-progress record and its attempt count rather than resetting
   * the attempt budget.
   */
  planRuns(request: AuthRequest, additionalHooks: AuthHook[] = []): AuthHookRun[] {
    if (!this.hasDurableTables()) return [];
    const hooks = [...additionalHooks, ...this.matchingHooksForRequest(request)];
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO auth_hook_executions (
         id, auth_request_id, hook_id, hook_label, command, command_digest,
         position, required, state, attempts, max_attempts, exit_code, output,
         attempt_history, started_at, finished_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, '', '[]', NULL, NULL, ?, ?)`,
    );
    const plan = this.db.transaction((entries: AuthHook[]) => {
      for (const hook of entries) {
        insert.run(
          randomUUID(),
          request.id,
          hook.id,
          hook.label,
          hook.command,
          authHookCommandDigest(hook.command),
          hook.position,
          hook.required ? 1 : 0,
          AUTH_HOOK_MAX_ATTEMPTS,
          now,
          now,
        );
      }
    });
    plan(hooks);
    return this.listRuns(request.id);
  }

  listRuns(authRequestId: string): AuthHookRun[] {
    return this.listRunsForRequests([authRequestId]).get(authRequestId) ?? [];
  }

  listRunsForRequests(requestIds: string[]): Map<string, AuthHookRun[]> {
    const runs = new Map<string, AuthHookRun[]>();
    if (requestIds.length === 0 || !this.hasDurableTables()) return runs;
    const rows = this.db.prepare(
      `SELECT * FROM auth_hook_executions WHERE auth_request_id IN (${requestIds.map(() => "?").join(", ")})
       ORDER BY position ASC, created_at ASC`,
    ).all(...requestIds) as Record<string, unknown>[];
    for (const row of rows) {
      const run = mapRunRow(row);
      const group = runs.get(run.auth_request_id) ?? [];
      group.push(run);
      runs.set(run.auth_request_id, group);
    }
    return runs;
  }

  getRun(authRequestId: string, hookId: string): AuthHookRun | null {
    if (!this.hasDurableTables()) return null;
    const row = this.db
      .prepare("SELECT * FROM auth_hook_executions WHERE auth_request_id = ? AND hook_id = ?")
      .get(authRequestId, hookId) as Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : null;
  }

  convergence(authRequestId: string): AuthConvergence {
    return this.convergenceForRequests([authRequestId]).get(authRequestId)!;
  }

  convergenceForRequests(requestIds: string[]): Map<string, AuthConvergence> {
    const runs = this.listRunsForRequests(requestIds);
    const pending = this.runtimeHandoffLock()?.verification;
    return new Map(requestIds.map(id => {
      const group = runs.get(id) ?? [];
      const verification = pending && this.projectRuntimeVerification(pending, group);
      return [id, { state: convergenceStateFromRuns(group), hooks: group.map(summarizeConvergenceRun),
        ...(verification ? { runtime_verification: verification } : {}) }];
    }));
  }

  private projectRuntimeVerification(pending: NonNullable<RuntimeHandoffLock['verification']>, runs: AuthHookRun[]): AuthRuntimeVerification | null {
    if (pending.hookId !== MANDIBLE_REBUILD_HOOK_ID) return null;
    const run = runs.find(run => run.auth_request_id === pending.requestId && run.id === pending.executionId && run.hook_id === pending.hookId);
    if (!run || run.state === 'complete' || run.command_digest !== pending.commandDigest
        || !run.output.includes(`MANDIBLE_RUNTIME_HANDOFF_PENDING:${pending.bindingDigest}`)) return null;
    return { phase: pending.phase, code: pending.code, reason: pending.reason };
  }

  runtimeVerificationStatus(): { requestId: string; executionId: string; bindingDigest: string; observation: AuthRuntimeVerification } | null {
    const pending = this.runtimeHandoffLock()?.verification;
    if (!pending) return null;
    const run = this.getRun(pending.requestId, pending.hookId);
    const observation = this.projectRuntimeVerification(pending, run ? [run] : []);
    return observation ? { requestId: pending.requestId, executionId: pending.executionId, bindingDigest: pending.bindingDigest, observation } : null;
  }

  /**
   * Auth request ids with at least one runnable hook row. Used by the daemon's
   * startup and periodic sweeps to resume convergence lost to a crash.
   */
  listRequestIdsWithRunnableHooks(limit = 50): string[] {
    if (!this.hasDurableTables()) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_hook_executions
         WHERE state = 'pending'
           AND auth_request_id IN (SELECT id FROM auth_requests WHERE status = 'completed' AND exit_code = 0)
         ORDER BY updated_at ASC`,
      )
      .all() as Record<string, unknown>[];
    // A pending rebuild owned by a runtime handoff is not runnable here: its
    // independent helper converges it, and runPending never spawns it again.
    const ids = new Set<string>();
    for (const run of rows.map(mapRunRow)) {
      if (ids.size >= limit) break;
      if (!this.hasRuntimeHandoff(run)) ids.add(run.auth_request_id);
    }
    return [...ids];
  }

  /**
   * Startup-only recovery: every `running` row in the database belongs to a
   * process that no longer exists, because this one has not spawned anything
   * yet. Converts them back to `pending` (or `failed` when the attempt budget
   * is gone) so the resume sweep can pick them up.
   */
  reclaimAllInterruptedRuns(): number {
    if (!this.hasDurableTables()) return 0;
    const rows = this.db
      .prepare("SELECT DISTINCT auth_request_id FROM auth_hook_executions WHERE state = 'running'")
      .all() as Array<{ auth_request_id: string }>;
    for (const row of rows) {
      this.reclaimInterruptedRuns(String(row.auth_request_id));
    }
    return rows.length;
  }

  /**
   * A row left `running` means the daemon died while the child was alive. The
   * attempt was already charged (it was persisted before the spawn), so this
   * only decides whether the budget allows another one.
   *
   * Only ever call this for rows that cannot still be running: at daemon
   * startup (a fresh process owns no children) or for a request whose inline
   * execution this process is about to perform. A live `running` row must stay
   * `running`, because that state is what stops a concurrent sweep from
   * spawning a second copy of the same hook.
   */
  reclaimInterruptedRuns(authRequestId: string): AuthHookRun[] {
    if (!this.hasDurableTables()) return [];
    const now = Date.now();
    for (const run of this.listRuns(authRequestId)) {
      if (run.state !== "running" || this.hasRuntimeHandoff(run)) continue;
      const history = [...run.attempt_history];
      const last = history[history.length - 1];
      if (!last || last.attempt !== run.attempts) {
        history.push({
          attempt: run.attempts,
          started_at: run.started_at ?? now,
          finished_at: now,
          exit_code: null,
          duration_ms: now - (run.started_at ?? now),
          outcome: "interrupted",
        });
      }
      const exhausted = run.attempts >= run.max_attempts;
      this.db
        .prepare(
          `UPDATE auth_hook_executions
           SET state = ?, attempt_history = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          exhausted ? "failed" : "pending",
          JSON.stringify(history),
          exhausted ? now : null,
          now,
          run.id,
        );
    }
    return this.listRuns(authRequestId);
  }

  /**
   * Grant one more attempt to a terminally failed run so an operator can retry
   * after fixing the host condition. Only the hook command reruns.
   */
  grantRetry(authRequestId: string, hookId?: string): number {
    if (!this.hasDurableTables()) return 0;
    const now = Date.now();
    const runs = this.listRuns(authRequestId).filter(
      (run) => run.state === "failed" && !this.hasRuntimeHandoff(run) && (!hookId || run.hook_id === hookId),
    );
    for (const run of runs) {
      this.db
        .prepare(
          `UPDATE auth_hook_executions
           SET state = 'pending', max_attempts = ?, finished_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(run.attempts + 1, now, run.id);
    }
    return runs.length;
  }

  /**
   * Execute all matching hooks for a completed auth request.
   *
   * Hooks run sequentially in position order. If a hook fails, subsequent hooks
   * still run: the merge already succeeded and the queue must not block. The
   * failure is not swallowed — it lives in the durable row and surfaces as
   * `merged / convergence failed`.
   */
  async executeHooks(
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
    options: { reusePlan?: boolean } = {},
  ): Promise<AuthHookExecutionResult[]> {
    if (!this.hasDurableTables()) {
      // Legacy/partial DBs (old fixtures) keep the pre-27241e6 behaviour rather
      // than losing hook execution entirely.
      const hooks = this.matchingHooksForRequest(request);
      const results: AuthHookExecutionResult[] = [];
      for (const hook of hooks) {
        results.push(await this.spawnHook(hook.id, hook.label, hook.command, request, {
          attempt: 1,
          executionId: `ephemeral:${hook.id}`,
          onOutput,
        }));
      }
      return results;
    }

    if (!options.reusePlan) this.planRuns(request);
    this.reclaimInterruptedRuns(request.id);
    return this.runPending(request, onOutput);
  }

  /**
   * Run every runnable row for this request, oldest position first. Safe to
   * call repeatedly: rows that are already terminal are skipped, and rows whose
   * attempt budget is exhausted are marked failed rather than retried forever.
   */
  async runPending(
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
  ): Promise<AuthHookExecutionResult[]> {
    const results: AuthHookExecutionResult[] = [];
    if (!this.hasDurableTables()) return results;

    for (const planned of this.listRuns(request.id)) {
      const run = this.getRun(request.id, planned.hook_id);
      // `running` is deliberately not runnable: it is the marker that some
      // process already spawned this hook, and honouring it is what keeps a
      // concurrent sweep from starting a second copy.
      if (!run || run.state !== "pending" || this.hasRuntimeHandoff(run)) continue;
      if (run.attempts >= run.max_attempts) {
        this.markRunFailedExhausted(run);
        continue;
      }
      results.push(await this.runOnce(run, request, onOutput));
    }
    return results;
  }

  private markRunFailedExhausted(run: AuthHookRun): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE auth_hook_executions SET state = 'failed', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?",
      )
      .run(now, now, run.id);
  }

  /**
   * One attempt against one durable row. The attempt counter and `running`
   * state are committed BEFORE the spawn, so a daemon killed mid-hook leaves
   * evidence that the attempt happened instead of an attempt budget that can
   * be burned forever by crash-looping.
   */
  private async runOnce(
    run: AuthHookRun,
    request: AuthRequest,
    onOutput?: (hookLabel: string, text: string) => void,
  ): Promise<AuthHookExecutionResult> {
    const attempt = run.attempts + 1;
    const startedAt = Date.now();
    this.db
      .prepare(
        `UPDATE auth_hook_executions
         SET state = 'running', attempts = ?, started_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempt, startedAt, startedAt, run.id);

    const result = await this.spawnHook(run.hook_id, run.hook_label, run.command, request, {
      attempt,
      executionId: run.id,
      commandDigest: run.command_digest,
      onOutput,
    });

    const finishedAt = Date.now();
    const ok = result.exit_code === 0;
    const history: AuthHookRunAttempt[] = [
      ...run.attempt_history,
      {
        attempt,
        started_at: startedAt,
        finished_at: finishedAt,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        outcome: ok ? "ok" : result.exit_code === null ? "timeout" : "failed",
      },
    ];
    const exhausted = attempt >= run.max_attempts;
    const handoffPending = isRuntimeHandoffPending(result);
    const nextState: AuthHookRunState = ok ? "complete" : handoffPending ? "pending" : exhausted ? "failed" : "pending";
    this.db
      .prepare(
        `UPDATE auth_hook_executions
         SET state = ?, exit_code = ?, output = ?, attempt_history = ?,
             finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextState,
        result.exit_code,
        truncateOutput(result.output),
        JSON.stringify(history),
        ok || exhausted && !handoffPending ? finishedAt : null,
        finishedAt,
        run.id,
      );
    return result;
  }

  private spawnHook(
    hookId: string,
    hookLabel: string,
    command: string,
    request: AuthRequest,
    options: {
      attempt: number;
      executionId: string;
      commandDigest?: string;
      onOutput?: (hookLabel: string, text: string) => void;
    },
  ): Promise<AuthHookExecutionResult> {
    const startedAt = Date.now();
    const cwd = request.cwd ?? undefined;
    const timeoutMs = authHookTimeoutMs(hookId);
    const env = buildAuthHookEnv(
      request,
      {
        hook_id: hookId,
        hook_label: hookLabel,
        attempt: options.attempt,
        execution_id: options.executionId,
        command_digest: options.commandDigest ?? authHookCommandDigest(command),
      },
      { db: this.db },
    );

    return new Promise<AuthHookExecutionResult>((resolve) => {
      let output = "";
      let settled = false;

      const child = spawn("bash", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Issue 27241e6 — scrubbed allowlist, never `...process.env`.
        env,
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 5000);
        resolve({
          hook_id: hookId,
          label: hookLabel,
          exit_code: null,
          output: output + "\n[hook timed out after " + (timeoutMs / 1000) + "s]",
          duration_ms: Date.now() - startedAt,
        });
      }, timeoutMs);

      const handleChunk = (data: Buffer): void => {
        const text = data.toString("utf8");
        output += text;
        options.onOutput?.(hookLabel, text);
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hook_id: hookId,
          label: hookLabel,
          exit_code: 1,
          output: output + "\n[hook error: " + error.message + "]",
          duration_ms: Date.now() - startedAt,
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          hook_id: hookId,
          label: hookLabel,
          exit_code: typeof code === "number" ? code : 1,
          output,
          duration_ms: Date.now() - startedAt,
        });
      });
    });
  }

  // --- Deduplicated failure alerts ---------------------------------------------

  /**
   * Record at most one alert per (request, hook). The UNIQUE constraint is the
   * dedup: a second required-hook failure for the same pair updates the detail
   * on the existing open alert instead of creating another inbox entry. No
   * ledger issue is created — a transient host failure is not a repairable
   * defect, and manufacturing an issue for each one is churn.
   */
  recordFailureAlert(request: AuthRequest, run: AuthHookRun, detail: string): AuthHookAlert | null {
    if (!this.hasDurableTables()) return null;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO auth_hook_alerts (
           id, auth_request_id, hook_id, hook_label, session_id, repo, detail,
           created_at, updated_at, acknowledged_at, acknowledged_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(auth_request_id, hook_id) DO UPDATE SET
           detail = excluded.detail,
           hook_label = excluded.hook_label,
           updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        request.id,
        run.hook_id,
        run.hook_label,
        request.target_session_id ?? request.session_id ?? null,
        request.repo ?? null,
        detail,
        now,
        now,
      );
    return this.getAlert(request.id, run.hook_id);
  }

  getAlert(authRequestId: string, hookId: string): AuthHookAlert | null {
    if (!this.hasDurableTables()) return null;
    const row = this.db
      .prepare("SELECT * FROM auth_hook_alerts WHERE auth_request_id = ? AND hook_id = ?")
      .get(authRequestId, hookId) as Record<string, unknown> | undefined;
    return row ? mapAlertRow(row) : null;
  }

  listOpenAlerts(limit = 50): AuthHookAlert[] {
    if (!this.hasDurableTables()) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_hook_alerts
         WHERE acknowledged_at IS NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapAlertRow);
  }

  acknowledgeAlert(id: string, by: string): boolean {
    if (!this.hasDurableTables()) return false;
    const info = this.db
      .prepare(
        "UPDATE auth_hook_alerts SET acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ? AND acknowledged_at IS NULL",
      )
      .run(Date.now(), by, Date.now(), id) as { changes?: number };
    return (info.changes ?? 0) > 0;
  }

  /** Clear the open alert for a pair that has since converged. */
  resolveAlert(authRequestId: string, hookId: string): void {
    if (!this.hasDurableTables()) return;
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE auth_hook_alerts SET acknowledged_at = ?, acknowledged_by = COALESCE(acknowledged_by, 'convergence'), updated_at = ? WHERE auth_request_id = ? AND hook_id = ? AND acknowledged_at IS NULL",
      )
      .run(now, now, authRequestId, hookId);
  }

  // --- CRUD ---

  list(): AuthHook[] {
    const rows = this.db
      .prepare("SELECT * FROM auth_hooks ORDER BY position ASC, created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapHookRow);
  }

  get(id: string): AuthHook | null {
    const row = this.db
      .prepare("SELECT * FROM auth_hooks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapHookRow(row) : null;
  }

  create(input: AuthHookInput): AuthHook {
    const now = Date.now();
    const id = randomUUID();
    const withRequired = this.hasRequiredColumn();
    const args: unknown[] = [
      id,
      input.repo_pattern,
      input.auth_type,
      input.command,
      input.label,
      input.enabled !== false ? 1 : 0,
      input.position ?? 100,
    ];
    if (withRequired) args.push(input.required === false ? 0 : 1);
    args.push(now, now);
    this.db
      .prepare(
        `INSERT INTO auth_hooks
           (id, repo_pattern, auth_type, command, label, enabled, builtin, position${withRequired ? ", required" : ""}, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?${withRequired ? ", ?" : ""}, ?, ?)`,
      )
      .run(...args);
    return this.get(id)!;
  }

  update(id: string, fields: Partial<AuthHookInput> & { enabled?: boolean }): AuthHook | null {
    const existing = this.get(id);
    if (!existing) return null;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (fields.repo_pattern !== undefined) {
      updates.push("repo_pattern = ?");
      values.push(fields.repo_pattern);
    }
    if (fields.auth_type !== undefined) {
      updates.push("auth_type = ?");
      values.push(fields.auth_type);
    }
    if (fields.command !== undefined) {
      updates.push("command = ?");
      values.push(fields.command);
    }
    if (fields.label !== undefined) {
      updates.push("label = ?");
      values.push(fields.label);
    }
    if (fields.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(fields.enabled ? 1 : 0);
    }
    if (fields.position !== undefined) {
      updates.push("position = ?");
      values.push(fields.position);
    }
    if (fields.required !== undefined && this.hasRequiredColumn()) {
      updates.push("required = ?");
      values.push(fields.required ? 1 : 0);
    }

    if (updates.length === 0) return existing;

    updates.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    this.db
      .prepare(`UPDATE auth_hooks SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.get(id);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    if (existing.builtin) {
      throw new Error("Cannot delete built-in hooks. Disable them instead.");
    }
    this.db.prepare("DELETE FROM auth_hooks WHERE id = ?").run(id);
    return true;
  }

  private requiredColumnPresent: boolean | null = null;

  private hasRequiredColumn(): boolean {
    if (this.requiredColumnPresent !== null) return this.requiredColumnPresent;
    try {
      const columns = this.db.prepare("PRAGMA table_info(auth_hooks)").all() as Array<{ name: string }>;
      this.requiredColumnPresent = columns.some((column) => column.name === "required");
    } catch {
      this.requiredColumnPresent = false;
    }
    return this.requiredColumnPresent;
  }
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_PERSISTED_OUTPUT_CHARS) return text;
  return `[output truncated to the last ${MAX_PERSISTED_OUTPUT_CHARS} characters]\n` +
    text.slice(text.length - MAX_PERSISTED_OUTPUT_CHARS);
}

function mapHookRow(row: Record<string, unknown>): AuthHook {
  return {
    id: String(row.id),
    repo_pattern: String(row.repo_pattern ?? "*"),
    auth_type: String(row.auth_type ?? "merge") as AuthRequestType,
    command: String(row.command ?? ""),
    label: String(row.label ?? ""),
    enabled: row.enabled === 1 || row.enabled === true,
    builtin: row.builtin === 1 || row.builtin === true,
    position: typeof row.position === "number" ? row.position : 0,
    // Absent column (pre-v138 fixture) means the pre-27241e6 world, where every
    // hook was implicitly load-bearing.
    required: row.required === undefined ? true : row.required === 1 || row.required === true,
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

/** A failure message without its numbers, so a repeating failure reads as one. */
function failureClass(message: string): string {
  return message.replace(/\d+(?:\.\d+)?/g, "#");
}

function runVersion(run: Pick<AuthHookRun, "state" | "attempts" | "updated_at">): string {
  return `${run.state}:${run.attempts}:${run.updated_at}`;
}

function mapRunRow(row: Record<string, unknown>): AuthHookRun {
  return {
    id: String(row.id),
    auth_request_id: String(row.auth_request_id),
    hook_id: String(row.hook_id),
    hook_label: String(row.hook_label ?? ""),
    command: String(row.command ?? ""),
    command_digest: String(row.command_digest ?? ""),
    position: typeof row.position === "number" ? row.position : 0,
    required: row.required === 1 || row.required === true,
    state: String(row.state ?? "pending") as AuthHookRunState,
    attempts: Number(row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? AUTH_HOOK_MAX_ATTEMPTS),
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    output: String(row.output ?? ""),
    attempt_history: parseAttemptHistory(row.attempt_history),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

function parseAttemptHistory(raw: unknown): AuthHookRunAttempt[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthHookRunAttempt[]) : [];
  } catch {
    return [];
  }
}

function mapAlertRow(row: Record<string, unknown>): AuthHookAlert {
  return {
    id: String(row.id),
    auth_request_id: String(row.auth_request_id),
    hook_id: String(row.hook_id),
    hook_label: String(row.hook_label ?? ""),
    session_id: row.session_id == null ? null : String(row.session_id),
    repo: row.repo == null ? null : String(row.repo),
    detail: String(row.detail ?? ""),
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
    acknowledged_at: row.acknowledged_at == null ? null : Number(row.acknowledged_at),
    acknowledged_by: row.acknowledged_by == null ? null : String(row.acknowledged_by),
  };
}
