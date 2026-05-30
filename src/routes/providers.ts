import { getDb } from "../db.js";
import {
  createKnowledgeBackref,
  listKnowledgeBackrefs,
} from "../knowledge-backrefs.js";
import { scanRepoArtifacts, type RepoArtifactRoot } from "../repo-artifact-scanner.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { getArtifactContent } from "../artifact-content.js";
import {
  getArtifact,
  getProviderCapabilities,
  getProviderDetail,
  getProviderHealth,
  ingestArtifact,
  ingestProviderManifest,
  ingestProviderManifestFile,
  listArtifacts,
  listProviders,
  registerProvider,
  resolveArtifactRef,
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

function queryString(req: RequestLike, key: string): string | undefined {
  const value = req.query?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryNumber(req: RequestLike, key: string): number | undefined {
  const value = queryString(req, key);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bodyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function bodyRepoRoots(value: unknown): Array<string | RepoArtifactRoot> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string | RepoArtifactRoot => {
    if (typeof item === "string") return Boolean(item.trim());
    return Boolean(item && typeof item === "object" && typeof (item as RepoArtifactRoot).root === "string");
  });
}

function linkedEntityQuery(req: RequestLike): { type?: string; id?: string } {
  const type = queryString(req, "entity_type") ?? queryString(req, "linked_entity_type");
  const id = queryString(req, "entity_id") ?? queryString(req, "linked_entity_id");
  const combined = queryString(req, "linked_entity");
  if (!combined || type || id) return { type, id };
  const colon = combined.indexOf(":");
  if (colon > 0 && colon < combined.length - 1) {
    return { type: combined.slice(0, colon), id: combined.slice(colon + 1) };
  }
  return { id: combined };
}

export function registerProviderRoutes(app: RouteRegistrar): void {
  app.get("/api/providers", (_req, res) => {
    sendJson(res, 200, { providers: listProviders(getDb()) });
  });

  app.get("/api/providers/:id/capabilities", (req, res) => {
    const capabilities = getProviderCapabilities(getDb(), req.params.id);
    if (!capabilities) {
      sendJson(res, 404, { error: "provider not found" });
      return;
    }
    sendJson(res, 200, capabilities);
  });

  app.get("/api/providers/:id/health", (req, res) => {
    const health = getProviderHealth(getDb(), req.params.id);
    if (!health) {
      sendJson(res, 404, { error: "provider not found" });
      return;
    }
    sendJson(res, 200, health);
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

  app.post("/api/providers/register-manifest", (req, res) => {
    try {
      const body = bodyRecord(req);
      if (typeof body.path === "string" && body.path.trim()) {
        const manifest = ingestProviderManifestFile(getDb(), body.path);
        sendJson(res, 200, { manifest });
        return;
      }
      const manifest = ingestProviderManifest(getDb(), body);
      sendJson(res, 200, { manifest });
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

  app.post("/api/artifacts/scan-repos", (req, res) => {
    try {
      const body = bodyRecord(req);
      const result = scanRepoArtifacts(getDb(), {
        roots: bodyRepoRoots(body.roots) ?? bodyRepoRoots(body.repo_roots),
        repoIds: bodyStringArray(body.repo_ids),
        maxDepth: typeof body.max_depth === "number" ? body.max_depth : undefined,
        maxFileBytes: typeof body.max_file_bytes === "number" ? body.max_file_bytes : undefined,
      });
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/artifacts", (req, res) => {
    const linked = linkedEntityQuery(req);
    const artifacts = listArtifacts(getDb(), {
      q: queryString(req, "q"),
      hashPrefix: queryString(req, "hash") ?? queryString(req, "hash_prefix"),
      repo: queryString(req, "repo"),
      provider: queryString(req, "provider"),
      role: queryString(req, "role"),
      custody: queryString(req, "custody"),
      availability: queryString(req, "availability"),
      scheme: queryString(req, "scheme"),
      location: queryString(req, "location"),
      linkedEntityType: linked.type,
      linkedEntityId: linked.id,
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    sendJson(res, 200, { artifacts });
  });

  app.get("/api/artifacts/resolve", (req, res) => {
    try {
      const ref = queryString(req, "ref") ?? queryString(req, "uri");
      if (!ref) {
        sendJson(res, 400, { error: "ref query parameter required" });
        return;
      }
      sendJson(res, 200, { resolution: resolveArtifactRef(getDb(), ref) });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/knowledge-backrefs", (req, res) => {
    const backrefs = listKnowledgeBackrefs(getDb(), {
      sourceType: queryString(req, "source_type"),
      sourceId: queryString(req, "source_id"),
      providerId: queryString(req, "provider") ?? queryString(req, "provider_id"),
      refType: queryString(req, "ref_type"),
      externalRef: queryString(req, "external_ref"),
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    sendJson(res, 200, { backrefs });
  });

  app.post("/api/knowledge-backrefs", (req, res) => {
    try {
      const backref = createKnowledgeBackref(getDb(), bodyRecord(req));
      sendJson(res, 200, { backref });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/artifacts/:id/content", (req, res) => {
    const content = getArtifactContent(getDb(), req.params.id);
    if (!content) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }
    sendJson(res, 200, { content });
  });

  app.get("/api/artifacts/:id/knowledge-backrefs", (req, res) => {
    const backrefs = listKnowledgeBackrefs(getDb(), {
      sourceType: "artifact",
      sourceId: req.params.id,
      providerId: queryString(req, "provider") ?? queryString(req, "provider_id"),
      refType: queryString(req, "ref_type"),
      limit: queryNumber(req, "limit"),
      offset: queryNumber(req, "offset"),
    });
    sendJson(res, 200, { backrefs });
  });

  app.post("/api/artifacts/:id/knowledge-backrefs", (req, res) => {
    try {
      const backref = createKnowledgeBackref(getDb(), {
        ...bodyRecord(req),
        source_type: "artifact",
        source_id: req.params.id,
      });
      sendJson(res, 200, { backref });
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
