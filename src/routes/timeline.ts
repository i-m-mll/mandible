import { getDb } from "../db.js";
import { buildProjectTimelineProjection } from "../ledger/timeline-projection.js";
import type { RouteRegistrar } from "../server.js";
import type { ProjectTimelineInput } from "../types.js";
import { sendJson } from "./http.js";

function getBody(req: unknown): Record<string, unknown> {
  if (!req || typeof req !== "object") return {};
  const body = (req as Record<string, unknown>).body;
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

export function registerTimelineRoutes(router: RouteRegistrar): void {
  router.post("/api/timeline/project", (req, res) => {
    const body = getBody(req) as ProjectTimelineInput;
    try {
      sendJson(res, 200, buildProjectTimelineProjection(getDb(), body));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }, { operation: { id: "post:/api/timeline/project", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
}
