import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import type {
  RequestLike,
  ResponseLike,
  RouteHandler,
  RouteRegistrar,
} from "../src/server.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import { registerGraphRoutes } from "../src/routes/graph.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import {
  ensureArtifactSeries,
  registerArtifactLink,
  resolveAndLinkArtifact,
  snapshotArtifactBytes,
} from "../src/provider-artifacts.js";
import { appendArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import type { ArtifactRecord } from "../src/types.js";
import {
  insertRawLedgerIssue,
  insertRawLedgerProject,
  migratedMemoryDb,
} from "./helpers/ledger-fixtures.js";
import { authenticatedTestIdentity } from "./helpers/authenticated-router.js";
import { setupOperator } from "../src/users/store.js";

// --- id-formula replicas (must stay byte-identical to artifactRegistryId) -----
// artifactRegistryId("artifact_link", parts) = `artifact_link:${sha256(JSON.stringify(parts)).slice(0,32)}`.
// stableJson on a string[] is the identity, so JSON.stringify here matches exactly.
function registryId(parts: unknown[]): string {
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.from(JSON.stringify(parts), "utf8"))
    .digest("hex")
    .slice(0, 32);
  return `artifact_link:${hash}`;
}
function pinnedLinkId(
  artifactId: string,
  entityType: string,
  entityId: string,
  linkType: string,
  role: string | null,
): string {
  return registryId([artifactId, entityType, entityId, linkType, role ?? ""]);
}
function livingLinkId(
  seriesId: string,
  entityType: string,
  entityId: string,
  linkType: string,
  role: string | null,
): string {
  return registryId([seriesId, entityType, entityId, linkType, role ?? "", "living"]);
}

// --- minimal route harness ----------------------------------------------------
class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();
  get(p: string, h: RouteHandler): void { this.handlers.set(`GET ${p}`, h); }
  post(p: string, h: RouteHandler): void { this.handlers.set(`POST ${p}`, h); }
  put(p: string, h: RouteHandler): void { this.handlers.set(`PUT ${p}`, h); }
  patch(p: string, h: RouteHandler): void { this.handlers.set(`PATCH ${p}`, h); }
  delete(p: string, h: RouteHandler): void { this.handlers.set(`DELETE ${p}`, h); }
  handler(method: string, p: string): RouteHandler {
    const h = this.handlers.get(`${method} ${p}`);
    if (!h) throw new Error(`Missing handler for ${method} ${p}`);
    return h;
  }
}

function createResponse(): ResponseLike & { statusCode: number; payload: unknown } {
  return {
    statusCode: 200,
    payload: undefined,
    status(code: number): ResponseLike {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown): void {
      this.payload = payload;
    },
  };
}

async function postRoute(routePath: string, body: Record<string, unknown>): Promise<{ statusCode: number; payload: any }> {
  const routes = new TestRoutes();
  registerProviderRoutes(routes, inlineLedgerReader());
  const req = {
    method: "POST",
    url: routePath,
    params: {},
    query: {},
    body,
    client_identity: authenticatedTestIdentity(operator),
  } as RequestLike;
  const res = createResponse();
  // Several artifact routes (ingest/plan/snapshot/bundles) are async because
  // their file read+hash runs in the off-thread ingest pool; await the handler.
  await routes.handler("POST", routePath)(req, res);
  return { statusCode: res.statusCode, payload: res.payload };
}
function getRoute(
  routePath: string,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): { statusCode: number; payload: any } {
  const routes = new TestRoutes();
  registerProviderRoutes(routes, inlineLedgerReader());
  const req = { method: "GET", url: routePath, params, query } as RequestLike;
  const res = createResponse();
  routes.handler("GET", routePath)(req, res);
  return { statusCode: res.statusCode, payload: res.payload };
}
async function getGraphRoute(query: Record<string, string>): Promise<{ statusCode: number; payload: any }> {
  const routes = new TestRoutes();
  registerGraphRoutes(routes, inlineLedgerReader());
  const req = { method: "GET", url: "/api/graph", params: {}, query } as RequestLike;
  const res = createResponse();
  await routes.handler("GET", "/api/graph")(req, res);
  return { statusCode: res.statusCode, payload: res.payload };
}
function postLink(body: Record<string, unknown>): Promise<{ statusCode: number; payload: any }> {
  return postRoute("/api/artifacts/link", body);
}

// --- ledger fixtures ----------------------------------------------------------
function createLedgerIssue(issueId: string, projectName = "mandible"): string {
  const projectId = insertRawLedgerProject(db, { name: projectName });
  return insertRawLedgerIssue(db, { id: issueId, projectId });
}

let counter = 0;
function makeArtifact(content: string): ArtifactRecord {
  return snapshotArtifactBytes(db, { content, media_type: "text/plain" }, 1000 + counter++);
}

// Build a managed series with one head version (returns the series id + head artifact).
function makeSeriesWithHead(key: string, content: string): { seriesId: string; head: ArtifactRecord } {
  const head = makeArtifact(content);
  const series = ensureArtifactSeries(db, { series_key: key, source_kind: "managed" });
  appendArtifactVersion(db, {
    series_id: series.id,
    artifact_id: head.id,
    source_kind: "managed",
    content_hash: head.content_hash,
    natural_key: `${key}:1`,
  });
  return { seriesId: series.id, head };
}

let tempDir = "";
let db: Db;
let operator: ReturnType<typeof setupOperator>;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    MANDIBLE_HOME: process.env.MANDIBLE_HOME,
    MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-link-typed-"));
  process.env.HOME = path.join(tempDir, "home");
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "artifacts");
  delete process.env.MANDIBLE_HOME;
  counter = 0;
  db = migratedMemoryDb();
  setDb(db); // wire getDb() for the route handlers
  operator = setupOperator(db, { display_name: "Artifact route test operator" });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("registerArtifactLink: pinned id stability + typed columns", () => {
  it("keeps the pinned link id byte-identical to the legacy formula and stores pinned/null", () => {
    const issueId = createLedgerIssue("issuelink1");
    const art = makeArtifact("alpha\n");
    const link = registerArtifactLink(db, art.id, {
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "report",
    }, 1000)!;
    expect(link.id).toBe(pinnedLinkId(art.id, "issue", issueId, "references", "report"));
    expect(link.link_kind).toBe("pinned");
    expect(link.series_id).toBeNull();
    expect(link.series_ref).toBeNull();
    expect(link.artifact_id).toBe(art.id);
  });

  it("rejects a direct living registration without a series id", () => {
    const art = makeArtifact("beta\n");
    expect(() =>
      registerArtifactLink(db, art.id, {
        entity_type: "issue",
        entity_id: "x",
        link_type: "references",
        link_kind: "living",
      }),
    ).toThrow(/living_link_requires_series/);
  });

  it("living link id is keyed by series + 'living', not by artifact", () => {
    const issueId = createLedgerIssue("issuelink2");
    const { seriesId, head } = makeSeriesWithHead("series-live-id", "v1\n");
    const link = registerArtifactLink(db, head.id, {
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      link_kind: "living",
      series_id: seriesId,
      series_ref: seriesId,
    }, 1000)!;
    expect(link.id).toBe(livingLinkId(seriesId, "issue", issueId, "references", null));
    expect(link.link_kind).toBe("living");
    expect(link.series_id).toBe(seriesId);
    expect(link.series_ref).toBe(seriesId);
  });
});

describe("NO SILENT RETARGET: artifact_id is never rewritten on conflict", () => {
  it("re-submitting a living link after the series head advances keeps the stored artifact_id", () => {
    const issueId = createLedgerIssue("issueretarget");
    const { seriesId, head } = makeSeriesWithHead("series-retarget", "v1\n");

    const l1 = registerArtifactLink(db, head.id, {
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      link_kind: "living",
      series_id: seriesId,
      series_ref: seriesId,
    }, 1000)!;
    expect(l1.artifact_id).toBe(head.id);

    // Advance the series head, then re-submit the SAME living link (series-keyed
    // id collides). artifact_id must NOT be retargeted to the new head.
    const head2 = makeArtifact("v2\n");
    appendArtifactVersion(db, {
      series_id: seriesId,
      artifact_id: head2.id,
      source_kind: "managed",
      content_hash: head2.content_hash,
      natural_key: "series-retarget:2",
    });

    const l2 = registerArtifactLink(db, head2.id, {
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      link_kind: "living",
      series_id: seriesId,
      series_ref: seriesId,
    }, 2000)!;
    expect(l2.id).toBe(l1.id);
    expect(l2.artifact_id).toBe(head.id); // unchanged — no silent retarget
    expect(l2.updated_at).toBe(2000);
    const count = db.prepare("SELECT COUNT(*) AS n FROM artifact_links WHERE id = ?").get(l1.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it("a pinned re-submission to a different artifact creates a distinct row, never retargets", () => {
    const issueId = createLedgerIssue("issuepinnedretarget");
    const a = makeArtifact("a\n");
    const b = makeArtifact("b\n");
    const la = registerArtifactLink(db, a.id, { entity_type: "issue", entity_id: issueId, link_type: "references" }, 1000)!;
    const lb = registerArtifactLink(db, b.id, { entity_type: "issue", entity_id: issueId, link_type: "references" }, 1001)!;
    expect(la.id).not.toBe(lb.id);
    // The original pinned row still points at a — it was never rewritten.
    const reread = db.prepare("SELECT blob_id, target_id FROM artifact_links WHERE id = ?").get(la.id) as {
      blob_id: string;
      target_id: string;
    };
    expect(reread).toEqual({
      blob_id: `artifact-blob:${a.content_hash}`,
      target_id: `artifact-blob:${a.content_hash}`,
    });
  });
});

describe("resolveAndLinkArtifact: pinned vs living", () => {
  it("pinned (default) on a series ref pins to the latest artifact and surfaces series_latest_not_pinned", () => {
    const issueId = createLedgerIssue("issuepin");
    const { seriesId, head } = makeSeriesWithHead("series-pin", "v1\n");
    const { resolution, link } = resolveAndLinkArtifact(db, {
      ref: seriesId,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
    }, 1000);
    expect(resolution.warnings ?? []).toContain("series_latest_not_pinned");
    expect(link!.link_kind).toBe("pinned");
    expect(link!.artifact_id).toBe(head.id);
    expect(link!.series_id).toBeNull();
    expect(link!.metadata.artifact_ref).toBe(seriesId); // provenance preserved
  });

  it("living on a series ref stores series_id, the author ref, and the latest-at-creation fallback", () => {
    const issueId = createLedgerIssue("issuelive");
    const { seriesId, head } = makeSeriesWithHead("series-live", "v1\n");
    const { link } = resolveAndLinkArtifact(db, {
      ref: seriesId,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      link_kind: "living",
    }, 1000);
    expect(link!.link_kind).toBe("living");
    expect(link!.series_id).toBe(seriesId);
    expect(link!.series_ref).toBe(seriesId); // original author ref
    expect(link!.artifact_id).toBe(head.id); // latest-at-creation fallback
    expect(link!.metadata.artifact_ref).toBe(seriesId);
  });
});

describe("living write requires a single resolvable series", () => {
  it("rejects living when the ref resolves to no series (plain content ref)", () => {
    const issueId = createLedgerIssue("issuenoseries");
    const orphan = makeArtifact("no-series\n"); // a snapshot row, not wrapped in any series
    expect(() =>
      resolveAndLinkArtifact(db, {
        ref: orphan.id,
        entity_type: "issue",
        entity_id: issueId,
        link_kind: "living",
      }),
    ).toThrow(/living_link_requires_series/);
  });

  it("rejects living when the content resolves to more than one series (ambiguous)", () => {
    const issueId = createLedgerIssue("issueambig");
    const shared = makeArtifact("shared\n");
    for (const key of ["series-amb-a", "series-amb-b"]) {
      const series = ensureArtifactSeries(db, { series_key: key, source_kind: "managed" });
      appendArtifactVersion(db, {
        series_id: series.id,
        artifact_id: shared.id,
        source_kind: "managed",
        content_hash: shared.content_hash,
        natural_key: `${key}:1`,
      });
    }
    expect(() =>
      resolveAndLinkArtifact(db, {
        ref: shared.id,
        entity_type: "issue",
        entity_id: issueId,
        link_kind: "living",
      }),
    ).toThrow(/living_link_requires_series/);
  });
});

describe("evidence links must be pinned", () => {
  it("rejects a living issue-evidence link in the BACKEND (resolveAndLinkArtifact)", () => {
    const issueId = createLedgerIssue("issueevidence");
    const { seriesId } = makeSeriesWithHead("series-evidence", "v1\n");
    expect(() =>
      resolveAndLinkArtifact(db, {
        ref: seriesId,
        entity_type: "issue",
        entity_id: issueId,
        link_type: "evidence",
        link_kind: "living",
      }),
    ).toThrow(/evidence_links_must_be_pinned/);
  });

  it("the route creates a living references link end to end", async () => {
    const issueId = createLedgerIssue("issuerouteok");
    const { seriesId, head } = makeSeriesWithHead("series-route-ok", "v1\n");
    const res = await postLink({
      ref: seriesId,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      link_kind: "living",
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload.link.link_kind).toBe("living");
    expect(res.payload.link.series_id).toBe(seriesId);
    expect(res.payload.link.artifact_id).toBe(`artifact-blob:${head.content_hash}`);
  });
});

// The authoritative invariant lives in registerArtifactLink so /api/artifacts/
// ingest (which forwards caller-supplied link/links straight to the upsert)
// cannot bypass the route + resolveAndLinkArtifact guards.
describe("chokepoint enforcement in registerArtifactLink", () => {
  it("projects provider manifest ingest and provider detail responses", async () => {
    const body = {
      provider_id: "provider-public-ids",
      manifest: {
        provider: { id: "provider-public-ids", name: "Public IDs" },
        artifacts: [{ id: "report", content: "report\n" }],
      },
    };
    const registered = await postRoute("/api/providers/register-manifest", body);
    const ingested = await postRoute("/api/provider-manifests/ingest", body);
    const detail = getRoute("/api/providers/:id", { id: "provider-public-ids" });

    for (const response of [registered, ingested, detail]) {
      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(response.payload)).not.toContain("artifact:sha256:");
    }
    expect(registered.payload.manifest.blob_id).toMatch(/^artifact-blob:[a-f0-9]{12,64}$/);
    expect(ingested.payload.manifest.blob_id).toMatch(/^artifact-blob:[a-f0-9]{12,64}$/);
    expect(detail.payload.manifests[0].blob_id).toMatch(/^artifact-blob:[a-f0-9]{12,64}$/);
    expect(detail.payload.artifacts.every((artifact: { id: string }) =>
      /^artifact-(?:blob|version):[a-f0-9]{12,64}$/.test(artifact.id))).toBe(true);

    const graph = await getGraphRoute({ mode: "provider-lineage", provider: "provider-public-ids" });
    expect(graph.statusCode).toBe(200);
    expect(JSON.stringify(graph.payload)).not.toContain("artifact:sha256:");
  });

  it("rejects a living link whose series_id does not contain the artifact (non-member)", () => {
    const issueId = createLedgerIssue("issuenonmember");
    const { seriesId } = makeSeriesWithHead("series-member", "v1\n");
    const stranger = makeArtifact("not-a-member\n"); // never appended to seriesId
    expect(() =>
      registerArtifactLink(db, stranger.id, {
        entity_type: "issue",
        entity_id: issueId,
        link_type: "references",
        link_kind: "living",
        series_id: seriesId,
      }),
    ).toThrow(/living_link_series_mismatch/);
  });
});
