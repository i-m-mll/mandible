import type { AuthQueue } from "../auth-queue.js";
import { getDb, type Db } from "../db.js";
import type { RouteRegistrar } from "../server.js";
import { countGlobalInboxBadge } from "./inbox.js";
import { sendJson } from "./http.js";

export type DashboardBadgeCounts = {
  auth: number;
  inbox: number;
  work: number;
};

export function readDashboardBadgeCounts(
  authQueue: Pick<AuthQueue, "listActive">,
  db: Db = getDb(),
): DashboardBadgeCounts {
  const auth = authQueue.listActive().filter((request) => {
    const status = request.status?.toLowerCase();
    return status === "pending" || status === "needs_rebase";
  }).length;
  const dirtyWork = db.prepare(
    `SELECT COUNT(*) AS count
     FROM branches AS branch
     JOIN work_repos AS repo ON repo.root = branch.repo_root
     WHERE branch.is_dirty = 1 AND repo.excluded = 0 AND repo.dir_exists = 1`,
  ).get() as { count: number };

  return {
    auth,
    inbox: countGlobalInboxBadge(db),
    work: Number(dirtyWork.count),
  };
}

export function registerDashboardRoutes(
  server: RouteRegistrar,
  authQueue: Pick<AuthQueue, "listActive">,
  db: Db = getDb(),
): void {
  server.get("/api/dashboard/badges", (_req, res) => {
    sendJson(res, 200, readDashboardBadgeCounts(authQueue, db));
  }, { fileRpc: "allow" });
}
