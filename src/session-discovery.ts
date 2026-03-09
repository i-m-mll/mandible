import { execSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { SessionRegistry, readPidStartTime } from "./registry.js";
import { broadcast } from "./sse.js";
import { WorkScanner } from "./work-scanner.js";
import type { Db } from "./db.js";
import type { Logger } from "./types.js";

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
  discoverSessions(): DiscoveryResult {
    const start = Date.now();
    let discovered = 0;
    let alreadyTracked = 0;

    // 1. Gather all known worktree paths from the work scanner's repos
    const worktrees = this.getWorktreePaths();

    // 2. Find running agent processes
    const processes = this.findAgentProcesses();

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

    broadcast("session:discovery:completed", result);

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
      if (!this.isProcessAlive(session.pid)) {
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
  private getWorktreePaths(): WorktreeInfo[] {
    const repos = this.workScanner.getRepos();
    const result: WorktreeInfo[] = [];

    for (const repo of repos) {
      if (!repo.exists) {
        continue;
      }

      const output = spawnSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repo.root,
        encoding: "utf8",
      });

      if (output.status !== 0 || !output.stdout) {
        continue;
      }

      const worktrees = parseWorktreeList(output.stdout);
      result.push(...worktrees);
    }

    return result;
  }

  /**
   * Find running agent processes (claude, codex) and resolve their cwds.
   * Uses `ps` + `lsof` on macOS.
   */
  private findAgentProcesses(): AgentProcess[] {
    const results: AgentProcess[] = [];

    // Get process list — use `ps axo pid,comm` for concise output
    let psOutput: string;
    try {
      psOutput = execSync("ps axo pid,comm", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
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

    // For each candidate, try to resolve its cwd via lsof
    for (const candidate of candidates) {
      const cwd = this.getProcessCwd(candidate.pid);
      if (cwd) {
        results.push({ pid: candidate.pid, app: candidate.app, cwd });
      }
    }

    return results;
  }

  /**
   * Get the current working directory of a process.
   * On macOS, `lsof -a -p PID -d cwd -Fn` is the reliable approach.
   */
  private getProcessCwd(pid: number): string | null {
    try {
      const output = execSync(`/usr/sbin/lsof -a -p ${pid} -d cwd -Fn`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });

      // lsof output format: lines starting with 'n' contain the name (path)
      for (const line of output.split("\n")) {
        if (line.startsWith("n") && line.length > 1) {
          const cwdPath = line.slice(1);
          // Validate it's a real directory
          if (fs.existsSync(cwdPath)) {
            return cwdPath;
          }
        }
      }
    } catch (error) {
      // lsof may fail for permission reasons or if the process exited
      this.log("debug", "session_discovery_lsof_failed", {
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// --- Reaper status types ---

export interface ReaperStatus {
  running: boolean;
  interval_ms: number;
  last_run_at: string | null;
  last_run_duration_ms: number | null;
  last_run_reaped: number | null;
  next_run_at: string | null;
  total_reaped: number;
  total_runs: number;
}

/**
 * Periodic reaper that automatically marks dead sessions.
 * Runs on a configurable interval (default 60s) and exposes status
 * for the GET /api/reaper/status endpoint.
 */
export class ReaperTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly discovery: SessionDiscovery;
  private readonly log: Logger;
  private readonly intervalMs: number;

  // Tracked state for the status endpoint
  private _lastRunAt: string | null = null;
  private _lastRunDurationMs: number | null = null;
  private _lastRunReaped: number | null = null;
  private _totalReaped = 0;
  private _totalRuns = 0;

  constructor(discovery: SessionDiscovery, logger: Logger, intervalMs = 60_000) {
    this.discovery = discovery;
    this.log = logger;
    this.intervalMs = intervalMs;
  }

  /** Start the periodic reaper. Safe to call multiple times. */
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
  }

  /** Stop the periodic reaper. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log("info", "reaper_timer_stopped");
    }
  }

  /** Get current reaper status for the API endpoint. */
  getStatus(): ReaperStatus {
    const nextRunAt = this.timer && this._lastRunAt
      ? new Date(new Date(this._lastRunAt).getTime() + this.intervalMs).toISOString()
      : this.timer
        ? new Date(Date.now() + this.intervalMs).toISOString()
        : null;

    return {
      running: this.timer !== null,
      interval_ms: this.intervalMs,
      last_run_at: this._lastRunAt,
      last_run_duration_ms: this._lastRunDurationMs,
      last_run_reaped: this._lastRunReaped,
      next_run_at: nextRunAt,
      total_reaped: this._totalReaped,
      total_runs: this._totalRuns,
    };
  }

  private tick(): void {
    const start = Date.now();
    try {
      const reaped = this.discovery.reapDeadSessions();
      const duration = Date.now() - start;
      this._lastRunAt = new Date().toISOString();
      this._lastRunDurationMs = duration;
      this._lastRunReaped = reaped;
      this._totalReaped += reaped;
      this._totalRuns++;

      if (reaped > 0) {
        this.log("info", "reaper_tick", { reaped, duration_ms: duration });
        broadcast("reaper:tick", {
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
