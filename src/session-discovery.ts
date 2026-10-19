import { DOMAIN_EVENTS } from "./contracts.js";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import { SessionRegistry, cachePidStartTimes, parsePsPidStart } from "./registry.js";
import { broadcast } from "./sse.js";
import { WorkScanner } from "./work-scanner.js";
import type { Logger } from "./types.js";

const execFileAsync = promisify(execFile);

export type DiscoveryResult = import("./contracts.js").SessionDiscoveryResult;

interface WorktreeInfo {
  path: string;
  branch: string | null;
}

interface AgentProcess {
  pid: number;
  app: string;
  cwd: string;
  pid_start: string;
  /** The registry row the process's launcher named in MANDIBLE_SESSION_ID. */
  session_id: string | null;
}

/** Known agent process patterns to scan for. */
const AGENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; app: string }> = [
  { pattern: /claude/, app: "claude" },
  { pattern: /codex/, app: "codex" },
  // Bug: 81c9d85 — discover Gemini agent sessions
  { pattern: /gemini/, app: "gemini" },
];

/**
 * Discovers agent sessions from running processes and worktrees,
 * and reaps dead sessions whose PIDs are no longer alive.
 */
export class SessionDiscovery {
  private readonly registry: SessionRegistry;
  private readonly workScanner: WorkScanner;
  private readonly log: Logger;
  private stopped = false;
  private readonly abort = new AbortController();
  private activeDiscovery: Promise<DiscoveryResult> | null = null;

  constructor(
    registry: SessionRegistry,
    workScanner: WorkScanner,
    logger: Logger,
  ) {
    this.registry = registry;
    this.workScanner = workScanner;
    this.log = logger;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled([this.activeDiscovery]);
  }

  /** Run one shared, cancellable discovery pass. */
  discoverSessions(): Promise<DiscoveryResult> {
    if (this.stopped) return Promise.reject(new Error("Session discovery is stopped"));
    if (this.activeDiscovery) return this.activeDiscovery;
    const discovery = this.runDiscovery();
    this.activeDiscovery = discovery;
    const clear = () => { if (this.activeDiscovery === discovery) this.activeDiscovery = null; };
    void discovery.then(clear, clear);
    return discovery;
  }

  private async runDiscovery(): Promise<DiscoveryResult> {
    const start = Date.now();
    let discovered = 0;
    let alreadyTracked = 0;

    // 1. Gather all known worktree paths from the work scanner's repos
    const worktrees = await this.getWorktreePaths();

    // 2. Find running agent processes
    const processes = await this.findAgentProcesses();

    if (this.stopped) throw new Error("Session discovery is stopped");
    // Preserve the canonical parser/cache used by registry liveness checks.
    // Only successful process evidence is cached; failure never becomes death.
    cachePidStartTimes(new Map(processes.map(proc => [proc.pid, proc.pid_start])));

    // 3. Attach processes to the rows they name; register unknown processes in worktrees
    for (const proc of processes) {
      if (this.attachToNamedSession(proc)) {
        alreadyTracked++;
        continue;
      }
      const matchingWorktree = worktrees.find(
        (wt) => proc.cwd === wt.path || proc.cwd.startsWith(wt.path + "/"),
      );
      if (!matchingWorktree) {
        continue;
      }

      // Check if already tracked by PID
      const existing = this.registry.getSessionByPid(proc.pid);
      if (existing?.status === "active") {
        alreadyTracked++;
        continue;
      }

      // Create new session record for this discovered process
      const sessionId = `discovered-${crypto.randomUUID()}`;
      const pidStart = proc.pid_start;

      this.registry.registerSession({
        id: sessionId,
        app: proc.app,
        pid: proc.pid,
        pid_start: pidStart,
        cwd: proc.cwd,
        branch: matchingWorktree.branch ?? undefined,
        worktree: matchingWorktree.path,
        status: "active",
      });

      this.log("info", "session_discovered", {
        session_id: sessionId,
        app: proc.app,
        pid: proc.pid,
        cwd: proc.cwd,
        branch: matchingWorktree.branch,
      });

      discovered++;
    }

    // 4. Reap dead sessions
    const deadReaped = this.reapDeadSessions();

    const result: DiscoveryResult = {
      discovered,
      dead_reaped: deadReaped,
      already_tracked: alreadyTracked,
      processes_found: processes.length,
      duration_ms: Date.now() - start,
    };

    broadcast(DOMAIN_EVENTS.SESSION_DISCOVERY_COMPLETED, result);

    return result;
  }

  /**
   * Give a process's pid to the registry row it names, so the row's liveness
   * follows the process. The name is an inherited environment variable, so a
   * process that started after the row was registered (a nested agent) is not
   * its owner. Only the reaper's verdict is revisited: ended and idle rows keep
   * their state.
   */
  private attachToNamedSession(proc: AgentProcess): boolean {
    const named = proc.session_id ? this.registry.getSession(proc.session_id) : null;
    if (named?.status !== "active" && named?.status !== "dead") return false;
    if (named.pid !== null && named.pid !== proc.pid) return false;
    if (Date.parse(named.created_at) < Date.parse(proc.pid_start)) return false;
    if (named.pid !== proc.pid || named.status === "dead") {
      this.registry.registerSession({ id: named.id, app: named.app, pid: proc.pid, pid_start: proc.pid_start, status: "active" });
      this.log("info", "session_process_attached", { session_id: named.id, pid: proc.pid });
    }
    return true;
  }

  reapDeadSessions(): number {
    return this.stopped ? 0 : this.registry.reapDead().length;
  }

  /** Reuse the scanner's bounded inventory path and exact branch parser. */
  private async getWorktreePaths(): Promise<WorktreeInfo[]> {
    const repos = await this.workScanner.getReposAsync();
    const result: WorktreeInfo[] = [];
    for (const repo of repos) {
      if (this.stopped) throw new Error("Session discovery is stopped");
      if (!repo.exists) continue;
      const inventory = await this.workScanner.getWorktreeInventory(repo.root, { signal: this.abort.signal });
      if (!inventory.known) throw new Error(`Worktree inventory is unavailable for ${repo.id}`);
      result.push(...inventory.worktrees.map(worktree => ({ path: worktree.path, branch: worktree.branch })));
    }
    return result;
  }

  /**
   * Find running agent processes (claude, codex) and resolve their cwds.
   * Uses `ps` + `lsof` on macOS.
   */
  private async findAgentProcesses(): Promise<AgentProcess[]> {
    const results: AgentProcess[] = [];

    // Read command identity and start time in one process snapshot.
    let psOutput: string;
    try {
      const output = await execFileAsync("ps", ["axo", "pid=,lstart=,comm="], {
        encoding: "utf8",
        timeout: 5000, killSignal: "SIGKILL", signal: this.abort.signal,
        maxBuffer: 16 * 1024 * 1024,
      });
      psOutput = output.stdout;
    } catch (error) {
      if (!this.stopped) this.log("warn", "session_discovery_ps_failed", { error: String(error) });
      throw error;
    }

    const candidates: Array<{ pid: number; app: string; pid_start: string }> = [];
    for (const [pid, { pid_start, rest }] of parsePsPidStart(psOutput)) {
      const app = pid === process.pid ? undefined : AGENT_PATTERNS.find(({ pattern }) => pattern.test(rest.toLowerCase()))?.app;
      if (app) candidates.push({ pid, app, pid_start });
    }

    // Resolve every candidate cwd and launcher identity in one batched call each.
    const pids = candidates.map((c) => c.pid);
    const [cwdByPid, sessionIdByPid] = await Promise.all([
      this.resolveProcessCwds(pids),
      this.resolveLauncherSessionIds(pids),
    ]);
    for (const candidate of candidates) {
      const cwd = cwdByPid.get(candidate.pid);
      if (cwd) {
        results.push({ ...candidate, cwd, session_id: sessionIdByPid.get(candidate.pid) ?? null });
      }
    }

    return results;
  }

  /**
   * Run a tool over a batch of pids. Status 1 means some requested processes
   * exited, and the survivors' output still counts. A timeout, abort or other
   * tool failure is not a successful partial discovery pass.
   */
  private async readPerPid(file: string, args: string[], failureEvent: string, pids: number[]): Promise<string> {
    if (pids.length === 0) return "";
    try {
      return (await execFileAsync(file, args, {
        encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", signal: this.abort.signal, maxBuffer: 16 * 1024 * 1024,
      })).stdout;
    } catch (error) {
      const failure = error as { stdout?: string; code?: string | number; killed?: boolean; signal?: string };
      if (failure.code === 1 && !failure.killed && !failure.signal) return failure.stdout ?? "";
      if (!this.stopped) this.log("warn", failureEvent, { pid_count: pids.length, error: String(error) });
      throw error;
    }
  }

  /** Read MANDIBLE_SESSION_ID from each process's environment (`ps -E`) in one call. */
  private async resolveLauncherSessionIds(pids: number[]): Promise<Map<number, string>> {
    const sessionIdByPid = new Map<number, string>();
    const output = await this.readPerPid("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")], "session_discovery_env_failed", pids);
    for (const line of output.split("\n")) {
      const pid = Number.parseInt(line, 10);
      const sessionId = [...line.matchAll(/(?:^|\s)MANDIBLE_SESSION_ID=(\S+)/g)].at(-1)?.[1];
      if (Number.isInteger(pid) && sessionId) sessionIdByPid.set(pid, sessionId);
    }
    return sessionIdByPid;
  }

  /**
   * Resolve the current working directory of many processes in one call.
   * On macOS, `lsof -a -p pid1,pid2,... -d cwd -Fpn` reports each process id on
   * a `p` line followed by its cwd on an `n` line. lsof exits non-zero when any
   * requested pid has exited, but still prints the surviving processes on
   * stdout, so partial output is parsed regardless of exit status.
   */
  private async resolveProcessCwds(pids: number[]): Promise<Map<number, string>> {
    const cwdByPid = new Map<number, string>();
    const output = await this.readPerPid("/usr/sbin/lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"], "session_discovery_lsof_failed", pids);
    let currentPid: number | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) {
        const pid = Number.parseInt(line.slice(1), 10);
        currentPid = Number.isInteger(pid) ? pid : null;
      } else if (line.startsWith("n") && line.length > 1 && currentPid !== null) {
        const cwdPath = line.slice(1);
        if (!cwdByPid.has(currentPid) && fs.existsSync(cwdPath)) {
          cwdByPid.set(currentPid, cwdPath);
        }
      }
    }
    return cwdByPid;
  }
}

/**
 * Periodic reaper that automatically marks dead sessions.
 * Runs on a configurable interval (default 60s).
 */
export class ReaperTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly discovery: SessionDiscovery;
  private readonly log: Logger;
  private readonly intervalMs: number;
  // Bug: 81c9d85 — periodic discovery interval (default 5 minutes)
  private readonly discoveryIntervalMs: number;
  private discovering = false;

  // Cumulative counters reported on the reaper:tick broadcast.
  private _totalReaped = 0;
  private _totalRuns = 0;

  constructor(discovery: SessionDiscovery, logger: Logger, intervalMs = 60_000, discoveryIntervalMs = 300_000) {
    this.discovery = discovery;
    this.log = logger;
    this.intervalMs = intervalMs;
    this.discoveryIntervalMs = discoveryIntervalMs;
  }

  /** Start the periodic reaper and discovery. Safe to call multiple times. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.log("info", "reaper_timer_started", { interval_ms: this.intervalMs });
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Don't let the timer keep the process alive during shutdown
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }

    // Bug: 81c9d85 — periodic full discovery alongside reaper ticks
    this.discoveryTimer = setInterval(() => this.discoveryTick(), this.discoveryIntervalMs);
    if (typeof this.discoveryTimer === "object" && "unref" in this.discoveryTimer) {
      this.discoveryTimer.unref();
    }
    this.log("info", "discovery_timer_started", { interval_ms: this.discoveryIntervalMs });
  }

  /** Stop the periodic reaper and discovery. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log("info", "reaper_timer_stopped");
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
      this.log("info", "discovery_timer_stopped");
    }
    await this.discovery.stop();
  }

  private tick(): void {
    const start = Date.now();
    try {
      const reaped = this.discovery.reapDeadSessions();
      const duration = Date.now() - start;
      this._totalReaped += reaped;
      this._totalRuns++;

      if (reaped > 0) {
        this.log("info", "reaper_tick", { reaped, duration_ms: duration });
        broadcast(DOMAIN_EVENTS.REAPER_TICK, {
          reaped,
          duration_ms: duration,
          total_reaped: this._totalReaped,
          total_runs: this._totalRuns,
        });
      }
    } catch (error) {
      this.log("warn", "reaper_tick_error", { error: String(error) });
    }
  }

  // Bug: 81c9d85 — periodic full discovery tick with concurrency guard
  private discoveryTick(): void {
    if (this.discovering) {
      return;
    }
    this.discovering = true;
    void this.discovery
      .discoverSessions()
      .then((result) => {
        if (result.discovered > 0 || result.dead_reaped > 0) {
          this.log("info", "discovery_tick", {
            discovered: result.discovered,
            dead_reaped: result.dead_reaped,
            duration_ms: result.duration_ms,
          });
        }
      })
      .catch((error) => {
        this.log("warn", "discovery_tick_error", { error: String(error) });
      })
      .finally(() => {
        this.discovering = false;
      });
  }
}
