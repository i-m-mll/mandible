import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionRegistry } from "./registry.js";
import type { Logger, NavMetadataStatus } from "./types.js";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 2_000;
const ZELLIJ_TIMEOUT_MS = 1_000;
const ZELLIJ_MAX_BUFFER = 2 * 1024 * 1024;
const FAST_RETRY_MS = 5_000;
const DEGRADED_RETRY_MS = 5 * 60 * 1_000;
const FAIL_AFTER_ATTEMPTS = 9;
const DEGRADE_AFTER_ATTEMPTS = 3;

function parseTabFromLayout(layout: string, paneId: string | null): string | null {
  const lines = layout.split("\n");
  if (paneId) {
    let currentTab: string | null = null;
    for (const line of lines) {
      const tabMatch = line.match(/tab\s+name="([^"]+)"/);
      if (tabMatch) {
        currentTab = tabMatch[1] ?? null;
      }
      if (line.includes("pane") && line.includes(`id="${paneId}"`) && currentTab) {
        return currentTab;
      }
    }
  }

  const focused = layout.match(/tab name="([^"]+)".*focused="true"/);
  if (focused?.[1]) {
    return focused[1];
  }
  const first = layout.match(/tab name="([^"]+)"/);
  return first?.[1] ?? null;
}

function classifyFailureStatus(attempts: number): NavMetadataStatus {
  if (attempts >= FAIL_AFTER_ATTEMPTS) {
    return "failed";
  }
  if (attempts >= DEGRADE_AFTER_ATTEMPTS) {
    return "degraded";
  }
  return "pending";
}

function nextRetryMs(status: NavMetadataStatus): number {
  return status === "pending" ? FAST_RETRY_MS : DEGRADED_RETRY_MS;
}

function withJitter(baseMs: number): number {
  const multiplier = 0.8 + Math.random() * 0.4;
  return Math.round(baseMs * multiplier);
}

export class NavMetadataEnricher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    void this.tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const sessions = this.registry.listSessionsNeedingNavMetadata(20);
      for (const session of sessions) {
        await this.resolveSession(session.id);
      }
    } finally {
      this.running = false;
    }
  }

  private async resolveSession(sessionId: string): Promise<void> {
    const session = this.registry.getSession(sessionId);
    if (!session || session.status !== "active" || session.multiplexer !== "zellij") {
      return;
    }
    if (session.nav_tab) {
      this.registry.updateSessionNavMetadata(session.id, {
        nav_tab: session.nav_tab,
        nav_metadata_status: "ready",
        nav_metadata_attempts: 0,
        nav_metadata_last_error: null,
        nav_metadata_last_attempt_at: new Date().toISOString(),
        nav_metadata_next_retry_at: null,
      });
      return;
    }
    if (!session.nav_session) {
      this.recordFailure(session.id, session.nav_metadata_attempts, "missing nav_session");
      return;
    }

    try {
      const { stdout } = await execFileAsync(
        "zellij",
        ["--session", session.nav_session, "action", "dump-layout"],
        {
          encoding: "utf8",
          timeout: ZELLIJ_TIMEOUT_MS,
          maxBuffer: ZELLIJ_MAX_BUFFER,
          windowsHide: true,
        },
      );
      const tab = parseTabFromLayout(stdout, session.nav_pane_id);
      if (!tab) {
        this.recordFailure(session.id, session.nav_metadata_attempts, "tab not found in zellij layout");
        return;
      }
      this.registry.updateSessionNavMetadata(session.id, {
        nav_tab: tab,
        nav_metadata_status: "ready",
        nav_metadata_attempts: 0,
        nav_metadata_last_error: null,
        nav_metadata_last_attempt_at: new Date().toISOString(),
        nav_metadata_next_retry_at: null,
      });
    } catch (error) {
      this.recordFailure(session.id, session.nav_metadata_attempts, this.describeError(error));
    }
  }

  private recordFailure(sessionId: string, previousAttempts: number, rawError: string): void {
    const attempts = previousAttempts + 1;
    const status = classifyFailureStatus(attempts);
    const retryAt = new Date(Date.now() + withJitter(nextRetryMs(status))).toISOString();
    this.registry.updateSessionNavMetadata(sessionId, {
      nav_metadata_status: status,
      nav_metadata_attempts: attempts,
      nav_metadata_last_error: rawError,
      nav_metadata_last_attempt_at: new Date().toISOString(),
      nav_metadata_next_retry_at: retryAt,
    });
    this.logger(
      status === "pending" ? "debug" : "warn",
      "nav_metadata_resolution_failed",
      {
        session_id: sessionId,
        attempts,
        status,
        error: rawError,
        next_retry_at: retryAt,
      },
    );
  }

  private describeError(error: unknown): string {
    if (!error || typeof error !== "object") {
      return String(error);
    }
    const maybe = error as { killed?: boolean; signal?: string; code?: number | string; stderr?: string };
    if (maybe.killed || maybe.signal === "SIGTERM") {
      return `zellij timeout after ${ZELLIJ_TIMEOUT_MS}ms`;
    }
    if (typeof maybe.code === "number" || typeof maybe.code === "string") {
      const stderr = typeof maybe.stderr === "string" ? maybe.stderr.trim() : "";
      return stderr ? `zellij exit ${String(maybe.code)}: ${stderr}` : `zellij exit ${String(maybe.code)}`;
    }
    return String(error);
  }
}
