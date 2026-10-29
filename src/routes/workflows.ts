import { getDb } from "../db.js";
import { getWorkflowRun, listWorkflowRuns } from "../workflows.js";
import type { RouteRegistrar } from "../server.js";
import { sendJson } from "./http.js";

export function registerWorkflowRoutes(server: RouteRegistrar): void {
  const db = getDb();

  server.get("/api/workflows", (req, res) => {
    const query = req.query ?? {};
    const sessionId = typeof query.session_id === "string" && query.session_id.trim()
      ? query.session_id.trim()
      : null;
    sendJson(res, 200, {
      workflows: listWorkflowRuns(db, { sessionId }),
    });
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/workflows", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.get("/api/workflows/:id", (req, res) => {
    const id = req.params.id;
    if (!id) {
      sendJson(res, 400, { error: "Missing workflow id" });
      return;
    }
    const workflow = getWorkflowRun(db, id);
    if (!workflow) {
      sendJson(res, 404, { error: "Workflow run not found" });
      return;
    }
    sendJson(res, 200, { workflow });
  }, { localCliCredential: {"mode":"omit"}, operation: { id: "get:/api/workflows/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
}
