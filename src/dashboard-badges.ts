import { DOMAIN_EVENTS, type DashboardBadgeCounts, type MandibleEventType } from "./contracts.js";
import { getDb, type Db } from "./db.js";
import { countOperationalIncidents } from "./operational-incidents.js";
import { countGlobalInboxBadge } from "./routes/inbox.js";
import type { SseManager } from "./sse.js";
import { countActiveTaskActivationConditions } from "./task-inventory.js";
import type { Logger } from "./types.js";

export function readDashboardBadgeCounts(db: Db = getDb()): DashboardBadgeCounts {
  const count = (sql: string) => Number((db.prepare(sql).get() as { count: number }).count);
  return {
    auth: count("SELECT COUNT(*) AS count FROM auth_requests WHERE status IN ('pending', 'needs_rebase')"),
    inbox: countGlobalInboxBadge(db),
    work: count(
      `SELECT COUNT(*) AS count
       FROM branches AS branch
       JOIN work_repos AS repo ON repo.root = branch.repo_root
       WHERE branch.is_dirty = 1 AND repo.excluded = 0 AND repo.dir_exists = 1`,
    ),
    briefing: count(
      `SELECT COUNT(*) AS count FROM briefings b
        JOIN briefing_rounds r ON r.id = b.latest_round_id
       WHERE NOT EXISTS (SELECT 1 FROM briefing_submissions s WHERE s.round_id = r.id)`,
    ),
    incidents: countOperationalIncidents(db).active_unacknowledged,
    tasks: countActiveTaskActivationConditions(db),
  };
}

/**
 * High-rate events that never move a dashboard count, including the push
 * itself. Every other broadcast may, so it schedules a recomputation.
 */
const COUNT_NEUTRAL_EVENTS: ReadonlySet<MandibleEventType> = new Set<MandibleEventType>([
  DOMAIN_EVENTS.HEARTBEAT,
  DOMAIN_EVENTS.DASHBOARD_BADGES,
  DOMAIN_EVENTS.AUTH_OUTPUT,
  DOMAIN_EVENTS.CONSOLE_STREAM_EVENT,
  DOMAIN_EVENTS.CONSOLE_TELEMETRY,
  DOMAIN_EVENTS.CONVERSATION_NEW,
  DOMAIN_EVENTS.CONVERSATION_UPDATED,
  DOMAIN_EVENTS.CONVERSATION_PROVIDER_EVENT,
  DOMAIN_EVENTS.CONVERSATION_CONTROL_UPDATED,
  DOMAIN_EVENTS.SESSION_EXECUTION_UPDATED,
  DOMAIN_EVENTS.PUSH_REPO_PROGRESS,
]);

export const DASHBOARD_BADGE_PUSH_DELAY_MS = 500;

function sameCounts(a: DashboardBadgeCounts, b: DashboardBadgeCounts): boolean {
  return a.auth === b.auth && a.inbox === b.inbox && a.work === b.work
    && a.briefing === b.briefing && a.incidents === b.incidents && a.tasks === b.tasks;
}

/**
 * Push `dashboard:badges` to every SSE client. A count-affecting broadcast
 * arms one trailing timer; when it fires the counts are computed once,
 * however many clients are connected, and broadcast only if they differ from
 * the last computation. With no client connected nothing is computed; a
 * client that connects later reads the counts on mount. Returns the disposer.
 */
export function attachDashboardBadgePublisher(
  sse: Pick<SseManager, "observe" | "broadcast" | "count">,
  read: () => DashboardBadgeCounts,
  logger: Logger,
  delayMs = DASHBOARD_BADGE_PUSH_DELAY_MS,
): () => void {
  let last: DashboardBadgeCounts | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = () => {
    timer = null;
    if (sse.count() === 0) {
      last = null;
      return;
    }
    let counts: DashboardBadgeCounts;
    try {
      counts = read();
    } catch (error) {
      logger("warn", "dashboard_badges_push_failed", { error: String(error) });
      return;
    }
    if (last !== null && sameCounts(last, counts)) return;
    last = counts;
    sse.broadcast({ type: DOMAIN_EVENTS.DASHBOARD_BADGES, data: counts, timestamp: new Date().toISOString() });
  };

  const unobserve = sse.observe((type) => {
    if (timer !== null || COUNT_NEUTRAL_EVENTS.has(type)) return;
    timer = setTimeout(publish, delayMs);
    timer.unref?.();
  });

  return () => {
    unobserve();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
