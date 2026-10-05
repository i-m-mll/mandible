import { DOMAIN_EVENTS } from "./contracts.js";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import { SessionRegistry, readPidStartTime } from "./registry.js";
import { broadcast } from "./sse.js";
import { WorkScanner } from "./work-scanner.js";
import type { Db } from "./db.js";
import type { Logger } from "./types.js";

const execFileAsync = promisify(execFile);

export interface DiscoveryResult {
  discovered: number;
  dead_reaped: number;
  already_tracked: number;
  processes_found: number;
  duration_ms: number;
}

interface WorktreeInfo {
  path: string;
  branch: string | null;
}

interface AgentProcess {
  pid: number;
  app: string;
  cwd: string;
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
  private readonly db: Db;
  private readonly registry: SessionRegistry;
  private readonly workScanner: WorkScanner;
  private readonly log: Logger;

  constructor(
    db: Db,
    registry: SessionRegistry,
    workScanner: WorkScanner,
    logger: Logger,
  ) {
    this.db = db;
    this.registry = registry;
    this.workScanner = workScanner;
    this.log = logger;
  }

  /** Run a full discovery pass: find new sessions and reap dead ones. */
  async discoverSessions(): Promise<DiscoveryResult> {
    const start = Date.now();
    let discovered = 0;
    let alreadyTracked = 0;

    // 1. Gather all known worktree paths from the work scanner's repos
    const worktrees = await this.getWorktreePaths();

    // 2. Find running agent processes
    const processes = await this.findAgentProcesses();

    // 3. Match processes to worktrees and register unknown sessions
    for (const proc of processes) {
      const matchingWorktree = worktrees.find(
        (wt) => proc.cwd === wt.path || proc.cwd.startsWith(wt.path + "/"),
      );
      if (!matchingWorktree) {
        continue;
      }

      // Check if already tracked by PID
      const existing = this.registry.getSessionByPid(proc.pid);
      if (existing) {
        alreadyTracked++;
        continue;
      }

      // Create new session record for this discovered process
      const sessionId = `discovered-${crypto.randomUUID()}`;
      const pidStart = readPidStartTime(proc.pid);

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

  /** Mark active sessions whose PIDs are no longer alive as dead. */
  reapDeadSessions(): number {
    const activeSessions = this.db
      .prepare(
        "SELECT id, pid FROM sessions WHERE status = 'active' AND pid IS NOT NULL",
      )
      .all() as Array<{ id: string; pid: number }>;

    let count = 0;
    for (const session of activeSessions) {
      // Only proven death reaps. An unprovable probe leaves the session
      // active and logs; a wrongly-reaped live session is the worse error.
      if (this.probeProcess(session.pid) === "dead") {
        const now = new Date().toISOString();
        this.db
          .prepare(
            "UPDATE sessions SET status = 'dead', ended_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(now, now, session.id);
        count++;

        this.log("info", "session_reaped", {
          session_id: session.id,
          pid: session.pid,
        });
      }
    }

    return count;
  }

  /**
   * Collect all worktree paths from every repo the work scanner knows about.
   * Uses `git worktree list --porcelain` the same way WorkScanner does.
   */
  private async getWorktreePaths(): Promise<WorktreeInfo[]> {
    const repos = this.workScanner.getRepos();
    const result: WorktreeInfo[] = [];

    for (const repo of repos) {
      if (!repo.exists) {
        continue;
      }

      let stdout: string;
      try {
        const output = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
          cwd: repo.root,
          encoding: "utf8",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          maxBuffer: 16 * 1024 * 1024,
        });
        stdout = output.stdout;
      } catch {
        continue;
      }

      if (!stdout) {
        continue;
      }

      const worktrees = parseWorktreeList(stdout);
      result.push(...worktrees);
    }

    return result;
  }

  /**
   * Find running agent processes (claude, codex) and resolve their cwds.
   * Uses `ps` + `lsof` on macOS.
   */
  private async findAgentProcesses(): Promise<AgentProcess[]> {
    const results: AgentProcess[] = [];

    // Get process list — use `ps axo pid,comm` for concise output
    let psOutput: string;
    try {
      const output = await execFileAsync("ps", ["axo", "pid,comm"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      psOutput = output.stdout;
    } catch {
      this.log("warn", "session_discovery_ps_failed");
      return results;
    }

    const lines = psOutput.split("\n");
    const candidates: Array<{ pid: number; app: string }> = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        continue;
      }

      const pidStr = trimmed.slice(0, spaceIdx).trim();
      const comm = trimmed.slice(spaceIdx + 1).trim().toLowerCase();
      const pid = Number.parseInt(pidStr, 10);

      if (!Number.isInteger(pid) || pid <= 0) {
        continue;
      }

      // Skip our own process
      if (pid === process.pid) {
        continue;
      }

      for (const pattern of AGENT_PATTERNS) {
        if (pattern.pattern.test(comm)) {
          candidates.push({ pid, app: pattern.app });
          break;
        }
      }
    }

    // Resolve every candidate cwd in a single batched lsof invocation.
    const cwdByPid = await this.resolveProcessCwds(candidates.map((c) => c.pid));
    for (const candidate of candidates) {
      const cwd = cwdByPid.get(candidate.pid);
      if (cwd) {
        results.push({ pid: candidate.pid, app: candidate.app, cwd });
      }
    }

    return results;
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
    if (pids.length === 0) {
      return cwdByPid;
    }

    let output = "";
    try {
      const result = await execFileAsync(
        "/usr/sbin/lsof",
        ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"],
        { encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
      );
      output = result.stdout;
    } catch (error) {
      const partial = (error as { stdout?: string }).stdout;
      if (typeof partial === "string" && partial.length > 0) {
        output = partial;
      } else {
        // lsof may fail for permission reasons or if every process exited.
        this.log("debug", "session_discovery_lsof_failed", {
          pid_count: pids.length,
          error: error instanceof Error ? error.message : String(error),
        });
        return cwdByPid;
      }
    }

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

  /**
   * Three states, because `process.kill(pid, 0)` has three outcomes and only
   * one of them means the process is gone.
   *
   * ESRCH is the only proof of death. EPERM means the process is alive but
   * owned by another uid — which is the normal case for a session started
   * under a different user — and every other errno (EINVAL, EAGAIN under
   * process exhaustion) is not evidence either way. Collapsing all three to
   * `false` reaped live sessions as `dead`. `delegated-signing-resource.ts`
   * already made exactly this distinction for signer liveness.
   */
  private probeProcess(pid: number): "alive" | "dead" | "unprovable" {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "dead";
      if (code === "EPERM") return "alive";
      this.log("warn", "session_liveness_unprovable", {
        pid,
        code: code ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unprovable";
    }
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
  stop(): void {
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

/**
 * Parse `git worktree list --porcelain` output into path+branch pairs.
 * Mirrors the parsing logic in work-scanner.ts.
 */
function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const lines = output.split("\n");
  let current: Partial<WorktreeInfo> = {};

  const flush = () => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? null,
      });
    }
    current = {};
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      current.path = value;
    } else if (key === "branch") {
      const normalized = value.startsWith("refs/heads/")
        ? value.slice("refs/heads/".length)
        : value;
      current.branch = normalized;
    }
  }
  flush();
  return worktrees;
}
