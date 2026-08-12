// Periodic expiry sweep for briefing candidates (umbrella 99b74d6 / ce22a3a).
//
// Unreviewed candidates do not linger in the badge forever: once a candidate's
// current revision has not been seen for the expiry horizon, the sweep appends
// a system `expire` decision event (NULL actor) so the candidate presents as
// `expired_unreviewed` and leaves the pending count. The sweep is a normal
// operational mutation, so the daemon only starts it on instances that allow
// operational mutations.

import { sweepExpiredBriefingCandidates } from "./briefing.js";
import { BRIEFING_EVENTS } from "./contracts.js";
import type { Db } from "./db.js";
import { broadcast } from "./sse.js";

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

export function startBriefingExpirySweep(
  db: Db,
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void,
  options: { intervalMs?: number; startupDelayMs?: number } = {},
): void {
  stopBriefingExpirySweep();
  const run = () => {
    try {
      const result = sweepExpiredBriefingCandidates(db);
      if (result.expired > 0) {
        log("info", "briefing_expiry_sweep", {
          subsystem: "briefing",
          expired: result.expired,
        });
        broadcast(BRIEFING_EVENTS.expired, {
          expired: result.expired,
          candidate_ids: result.candidate_ids,
        });
      }
    } catch (error) {
      log("warn", "briefing_expiry_sweep_failed", {
        subsystem: "briefing",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  startupTimer = setTimeout(run, options.startupDelayMs ?? 30_000);
  sweepTimer = setInterval(run, options.intervalMs ?? 60 * 60 * 1_000);
  startupTimer.unref?.();
  sweepTimer.unref?.();
}

export function stopBriefingExpirySweep(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
