import { getDb } from "../db.js";
import {
  createKnowledgeBackref,
  listKnowledgeBackrefs,
} from "../knowledge-backrefs.js";
import { scanRepoArtifacts, type RepoArtifactRoot } from "../repo-artifact-scanner.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { checkArtifactMaterialization, diffArtifacts, getArtifactContent } from "../artifact-content.js";
import {
  addArtifactBundleMembers,
  createArtifactBundle,
  getArtifactBundle,
  getArtifact,
  getProviderCapabilities,
  getProviderDetail,
  getProviderHealth,
  ingestArtifact,
  ingestProviderManifest,
  ingestProviderManifestFile,
  listArtifactSeries,
  listArtifacts,
  listProviders,
  planLocalArtifactPath,
  recordArtifactVersion,
  registerLocalArtifactPath,
  registerProvider,
  resolveAndLinkArtifact,
  resolveArtifactRef,
  resolveArtifactVersionHistory,
  snapshotArtifactBytes,
} from "../provider-artifacts.js";
import type { ArtifactVersionSourceKind } from "../types.js";

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

function queryBoolean(req: RequestLike, key: string): boolean | undefined {
  const value = queryString(req, key);
  if (!value) return undefined;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return undefined;
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

function bodyBoolean(body: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
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
      const body = bodyRecord(req);
      const localPath = typeof body.path === "string" && body.path.trim()
        ? body.path
        : typeof body.local_path === "string" && body.local_path.trim()
          ? body.local_path
          : undefined;
      if (localPath) {
        const result = registerLocalArtifactPath(getDb(), { ...body, path: localPath });
        sendJson(res, 200, result);
        return;
      }
      const artifact = ingestArtifact(getDb(), body);
      sendJson(res, 200, { artifact });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/artifacts/plan", (req, res) => {
    try {
      const body = bodyRecord(req);
      const localPath = typeof body.path === "string" && body.path.trim()
        ? body.path
        : typeof body.local_path === "string" && body.local_path.trim()
          ? body.local_path
          : undefined;
      if (!localPath) {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const plan = planLocalArtifactPath(getDb(), { ...body, path: localPath });
      sendJson(res, 200, { plan });
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
        register: bodyBoolean(body, "register"),
        discoveryOnly: bodyBoolean(body, "discovery_only"),
        dryRun: bodyBoolean(body, "dry_run", "dryRun"),
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
      summary: queryBoolean(req, "summary"),
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

  app.get("/api/artifacts/series", (req, res) => {
    const linked = linkedEntityQuery(req);
    const series = listArtifactSeries(getDb(), {
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
    sendJson(res, 200, { series });
  });

  app.post("/api/artifacts/link", (req, res) => {
    try {
      const body = bodyRecord(req);
      // Evidence links on issues must pin a concrete artifact version. Reject a
      // living evidence link at the route boundary (issue 10960ea) so the
      // contract is enforced at the HTTP edge, not only later in the CLI; the
      // backend (resolveAndLinkArtifact) enforces the same rule as defense in
      // depth for every other caller.
      const linkKind = typeof body.link_kind === "string" ? body.link_kind.trim() : undefined;
      const linkType = typeof body.link_type === "string" && body.link_type.trim()
        ? body.link_type.trim()
        : "references";
      const entityType = typeof body.entity_type === "string" && body.entity_type.trim()
        ? body.entity_type.trim()
        : (typeof body.issue === "string" && body.issue.trim() ? "issue" : undefined);
      if (linkKind === "living" && entityType === "issue" && linkType === "evidence") {
        sendJson(res, 400, { error: "evidence_links_must_be_pinned" });
        return;
      }
      const result = resolveAndLinkArtifact(getDb(), body);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/artifacts/check", (req, res) => {
    try {
      const body = bodyRecord(req);
      const refs = bodyStringArray(body.refs)
        ?? bodyStringArray(body.artifact_refs)
        ?? (typeof body.ref === "string" && body.ref.trim() ? [body.ref] : undefined);
      if (!refs?.length) {
        sendJson(res, 400, { error: "ref or refs is required" });
        return;
      }
      const checks = refs.map((ref) => {
        const resolution = resolveArtifactRef(getDb(), ref);
        const check = resolution.artifact
          ? checkArtifactMaterialization(getDb(), resolution.artifact.id, { ref })
          : null;
        return { ref, resolution, check };
      });
      sendJson(res, 200, { checks });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/artifacts/snapshot", (req, res) => {
    try {
      const artifact = snapshotArtifactBytes(getDb(), bodyRecord(req));
      sendJson(res, 200, { artifact });
    } catch (error) {
      handleError(res, error);
    }
  });

  // Read-only version history for a logical artifact series. `ref` may be a
  // series id, series_key, version id, or any artifact ref (resolves to the
  // most recent series pinning that immutable artifact).
  app.get("/api/artifacts/versions", (req, res) => {
    try {
      const ref = queryString(req, "ref") ?? queryString(req, "series");
      if (!ref) {
        sendJson(res, 400, { error: "ref query parameter required" });
        return;
      }
      const history = resolveArtifactVersionHistory(getDb(), ref);
      if (!history) {
        sendJson(res, 404, { error: "no artifact version series found for ref" });
        return;
      }
      sendJson(res, 200, { history });
    } catch (error) {
      handleError(res, error);
    }
  });

  // Read-only text/JSON/Markdown diff derived from two artifacts' full snapshot
  // bytes. Accepts any resolvable refs (hash, version, or series selectors).
  app.get("/api/artifacts/diff", (req, res) => {
    try {
      const refA = queryString(req, "a") ?? queryString(req, "from");
      const refB = queryString(req, "b") ?? queryString(req, "to");
      if (!refA || !refB) {
        sendJson(res, 400, { error: "a and b query parameters required" });
        return;
      }
      sendJson(res, 200, { diff: diffArtifacts(getDb(), refA, refB) });
    } catch (error) {
      handleError(res, error);
    }
  });

  // EXPLICIT version recording — the only write path into the version tables.
  app.post("/api/artifacts/versions", (req, res) => {
    try {
      const body = bodyRecord(req);
      const sourceKind = typeof body.source_kind === "string" ? body.source_kind : undefined;
      if (!sourceKind) {
        sendJson(res, 400, { error: "source_kind is required (tracked_repo, local_only, or managed)" });
        return;
      }
      const result = recordArtifactVersion(getDb(), {
        ...body,
        source_kind: sourceKind as ArtifactVersionSourceKind,
      });
      sendJson(res, 200, { result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/artifacts/bundles", (req, res) => {
    try {
      const result = createArtifactBundle(getDb(), bodyRecord(req) as unknown as Parameters<typeof createArtifactBundle>[1]);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/artifacts/bundles/:id/members", (req, res) => {
    try {
      const body = bodyRecord(req);
      const members = Array.isArray(body.members) ? body.members : [];
      const result = addArtifactBundleMembers(getDb(), req.params.id, members as Parameters<typeof addArtifactBundleMembers>[2]);
      sendJson(res, 200, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/artifacts/bundles/:id", (req, res) => {
    const bundle = getArtifactBundle(getDb(), req.params.id);
    if (!bundle) {
      sendJson(res, 404, { error: "bundle not found" });
      return;
    }
    sendJson(res, 200, bundle);
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

  app.get("/api/artifacts/:id/check", (req, res) => {
    const check = checkArtifactMaterialization(getDb(), req.params.id);
    if (!check) {
      sendJson(res, 404, { error: "artifact not found" });
      return;
    }
    sendJson(res, 200, { check });
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
