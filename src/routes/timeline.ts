import { getDb } from "../db.js";
import { buildProjectTimelineProjection } from "../ledger/timeline-projection.js";
import type { RouteRegistrar } from "../server.js";
import type { ProjectTimelineInput } from "../types.js";

function sendJson(res: unknown, status: number, payload: unknown): void {
  if (!res || typeof res !== "object") return;
  const record = res as Record<string, unknown>;
  if (typeof record.status === "function") {
    (record.status as (code: number) => unknown)(status);
  } else if (typeof record.code === "function") {
    (record.code as (code: number) => unknown)(status);
  }
  if (typeof record.json === "function") {
    (record.json as (body: unknown) => unknown)(payload);
  } else if (typeof record.send === "function") {
    (record.send as (body: unknown) => unknown)(payload);
  } else if (typeof record.end === "function") {
    (record.end as (body: string) => unknown)(JSON.stringify(payload));
  }
}

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
  });
}
