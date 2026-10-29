import type { LedgerReader } from "../ledger-reads/index.js";
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

export function registerTimelineRoutes(router: RouteRegistrar, reader: LedgerReader): void {
  router.post("/api/timeline/project", async (req, res) => {
    const body = getBody(req) as ProjectTimelineInput;
    try {
      sendJson(res, 200, await reader.run("timeline_projection", body));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "post:/api/timeline/project", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
}
