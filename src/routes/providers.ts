import { getDb } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import {
  getArtifact,
  getProviderDetail,
  ingestArtifact,
  ingestProviderManifest,
  listProviders,
  registerProvider,
} from "../provider-artifacts.js";

function sendJson(res: ResponseLike, code: number, payload: unknown): void {
  res.status(code).json(payload);
}

function bodyRecord(req: RequestLike): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function handleError(res: ResponseLike, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 400, { error: message });
}

export function registerProviderRoutes(app: RouteRegistrar): void {
  app.get("/api/providers", (_req, res) => {
    sendJson(res, 200, { providers: listProviders(getDb()) });
  });

  app.get("/api/providers/:id", (req, res) => {
    const detail = getProviderDetail(getDb(), req.params.id);
    if (!detail) {
      sendJson(res, 404, { error: "provider not found" });
      return;
    }
    sendJson(res, 200, detail);
  });

  app.post("/api/providers/register", (req, res) => {
    try {
      const provider = registerProvider(getDb(), bodyRecord(req));
      sendJson(res, 200, { provider });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/artifacts/ingest", (req, res) => {
    try {
      const artifact = ingestArtifact(getDb(), bodyRecord(req));
      sendJson(res, 200, { artifact });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/artifacts/:id", (req, res) => {
    const artifact = getArtifact(getDb(), req.params.id);
    if (!artifact) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }
    sendJson(res, 200, { artifact });
  });

  app.post("/api/provider-manifests/ingest", (req, res) => {
    try {
      const manifest = ingestProviderManifest(getDb(), bodyRecord(req));
      sendJson(res, 200, { manifest });
    } catch (error) {
      handleError(res, error);
    }
  });
}
