import { inlineLedgerReader, type LedgerReader } from "../ledger-reads/index.js";
import { firstQueryValue, parseQueryParams } from "../graph/spec.js";
import type { RouteRegistrar } from "../server.js";

export function registerGraphRoutes(app: RouteRegistrar, reader: LedgerReader = inlineLedgerReader()): void {
  app.get("/api/graph", async (req, res) => {
    const query = req.query as Record<string, string | string[] | undefined>;
    const params = parseQueryParams(query);
    res.json(await reader.run("graph_payload", {
      params, providerId: firstQueryValue(query, "provider"), root: firstQueryValue(query, "root"),
    }));

  }, { operation: { id: "get:/api/graph", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
}
