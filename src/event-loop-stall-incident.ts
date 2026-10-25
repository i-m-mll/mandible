import type { Db } from "./db.js";
import type { EventLoopLagSnapshot } from "./daemon-event-loop.js";
import { openDaemonIncident, raiseDaemonIncident, resolveDaemonIncident } from "./operational-incidents.js";
import { EVENT_LOOP_STALL_BUDGET_MS } from "./runtime-health-contract.js";
import type { Logger } from "./types.js";

export const EVENT_LOOP_STALL_TASK = "daemon-event-loop-stall";
const CLEAN_WINDOWS_TO_RESOLVE = 2;

/**
 * Turns health-window samples into one daemon incident per stall episode. A
 * window stalls when its longest turn reaches the stall budget or lag is in
 * warning; the incident this daemon holds resolves after consecutive clean
 * windows. An incident left open by a previous process is adopted at start.
 */
export class EventLoopStallIncident {
  private incidentId: string | null;
  private cleanWindows = 0;

  constructor(private readonly db: Db, private readonly logger: Logger) {
    this.incidentId = openDaemonIncident(db, EVENT_LOOP_STALL_TASK);
  }

  observe(window: EventLoopLagSnapshot): void {
    try {
      if (window.maxMs >= EVENT_LOOP_STALL_BUDGET_MS || window.warning) {
        this.cleanWindows = 0;
        this.incidentId = raiseDaemonIncident(this.db, {
          task: EVENT_LOOP_STALL_TASK,
          exitClass: "budget",
          observedAt: window.intervalEndedAt,
          measurements: {
            max_ms: window.maxMs,
            p95_ms: window.p95Ms,
            budget_ms: EVENT_LOOP_STALL_BUDGET_MS,
            interval_started_at: window.intervalStartedAt,
            interval_ended_at: window.intervalEndedAt,
          },
        }).incident_id;
        return;
      }
      if (this.incidentId === null || ++this.cleanWindows < CLEAN_WINDOWS_TO_RESOLVE) return;
      const incidentId = this.incidentId;
      this.incidentId = null;
      this.cleanWindows = 0;
      resolveDaemonIncident(this.db, { incidentId, task: EVENT_LOOP_STALL_TASK, observedAt: window.intervalEndedAt });
    } catch (error) {
      this.logger("error", "daemon_event_loop_stall_incident_failed", { error: String(error) });
    }
  }
}
