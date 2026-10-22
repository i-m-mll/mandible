import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { ensureArtifactSeries, listArtifactSeries, resolveAndLinkArtifact, resolveArtifactVersionHistory } from "../src/provider-artifacts.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import { Router } from "../src/server.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-series-list-"));
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "artifacts");
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MANDIBLE_ARTIFACT_DIR;
});

function createRouter(): Router {
  const router = new Router();
  registerProviderRoutes(router);
  return router;
}

function createIssue(issueId: string): string {
  db.prepare(
    `INSERT OR IGNORE INTO ledger_projects (
      id, display_name, created_at, updated_at
    ) VALUES ('prj_test', 'mandible', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO ledger_issues (
      id, short_id, project_id, title, status, created_at, updated_at
    ) VALUES (?, ?, 'prj_test', 'Issue', 'open', 1, 1)`,
  ).run(issueId, issueId.slice(0, 7));
  return issueId;
}

describe("artifact series list", () => {
  it("returns one latest-version summary per series and keeps empty series visible", () => {
    const first = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "provider-a",
      logical_name: "older",
      content: "older\n",
      media_type: "text/plain",
      role: "report",
    }, 1000);
    const second = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "provider-b",
      logical_name: "newer",
      content: "newer\n",
      media_type: "text/plain",
      role: "metrics",
    }, 2000);
    const empty = ensureArtifactSeries(db, {
      series_key: "manual:empty",
      source_kind: "managed",
      title: "Empty",
      logical_name: "empty",
    }, 3000);

    const series = listArtifactSeries(db);

    expect(series.map((item) => item.id)).toEqual([empty.id, second.series.id, first.series.id]);
    expect(series[0]).toMatchObject({
      id: empty.id,
      ref: empty.id,
      version_count: 0,
      latest_version: null,
      latest_artifact: null,
      links: [],
    });
    expect(series[1]).toMatchObject({
      id: second.series.id,
      ref: second.series.id,
      latest_version: { id: second.version.id, version_no: 1 },
      latest_artifact: { id: second.artifact.id, role: "metrics" },
    });
    expect(series[1].ref.startsWith("artifact-series:")).toBe(true);
    expect(series[1].ref.startsWith("artifact:sha256:")).toBe(false);
  });

  it("filters against the latest version attributes", () => {
    const series = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "provider-a",
      series_key: "managed:changing",
      logical_name: "changing",
      content: "v1\n",
      media_type: "text/plain",
      role: "old-role",
    }, 1000);
    recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "provider-b",
      series_key: "managed:changing",
      logical_name: "changing",
      content: "v2\n",
      media_type: "text/plain",
      role: "new-role",
    }, 2000);

    expect(listArtifactSeries(db, { role: "new-role" }).map((item) => item.id)).toEqual([series.series.id]);
    expect(listArtifactSeries(db, { role: "old-role" })).toEqual([]);
  });

  it("filters against artifact-scoped links on the latest version", () => {
    const series = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "latest-provider",
      logical_name: "linked-latest",
      content: "linked latest\n",
      media_type: "text/plain",
      role: "latest-role",
    }, 1000);
    resolveAndLinkArtifact(db, {
      ref: series.artifact.id,
      entity_type: "external",
      entity_id: "external-link",
      link_type: "references",
      repo_id: "repo-from-link",
      provider_id: "provider-from-link",
      role: "role-from-link",
    }, 1100);

    expect(listArtifactSeries(db, { repo: "repo-from-link" }).map((item) => item.id)).toEqual([series.series.id]);
    expect(listArtifactSeries(db, { provider: "provider-from-link" }).map((item) => item.id)).toEqual([
      series.series.id,
    ]);
    expect(listArtifactSeries(db, { role: "role-from-link" }).map((item) => item.id)).toEqual([series.series.id]);
  });

  it("exposes series-scoped links separately from latest immutable links", () => {
    const issueId = createIssue("issue-series-link");
    const first = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "provider-a",
      logical_name: "linked",
      content: "v1\n",
      media_type: "text/plain",
    }, 1000);
    const link = resolveAndLinkArtifact(db, {
      ref: first.series.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      link_kind: "living",
    }, 1100).link;
    const second = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "provider-a",
      logical_name: "linked",
      content: "v2\n",
      media_type: "text/plain",
    }, 2000);

    const summaries = listArtifactSeries(db, { linkedEntityType: "issue", linkedEntityId: issueId });
    const history = resolveArtifactVersionHistory(db, first.series.id);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].latest_artifact?.id).toBe(second.artifact.id);
    expect(summaries[0].links).toHaveLength(1);
    expect(summaries[0].links[0]).toMatchObject({
      id: link?.id,
      artifact_id: `artifact-blob:${first.artifact.content_hash}`,
      series_id: first.series.id,
      link_kind: "living",
      entity_id: issueId,
    });
    expect(history?.links.map((item) => item.id)).toEqual([link?.id]);
  });

  it("serves GET /api/artifacts/series before artifact id routes and applies query filters", async () => {
    const selected = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "route-provider",
      logical_name: "route",
      content: "route\n",
      media_type: "text/plain",
      role: "route-role",
    }, 1000);
    recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "other-provider",
      logical_name: "other",
      content: "other\n",
      media_type: "text/plain",
      role: "other-role",
    }, 2000);
    const router = createRouter();

    const response = await router.invoke({
      method: "GET",
      url: "/api/artifacts/series?role=route-role",
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      series: Array<{
        id: string;
        ref: string;
        latest_version: { ref: string };
        latest_artifact: { role: string };
      }>;
    };
    expect(body.series.map((item) => item.id)).toEqual([selected.series.id]);
    expect(body.series[0].ref).toMatch(/^artifact-series:.{12,}$/);
    expect(body.series[0].latest_version.ref).toMatch(/^artifact-version:.{12,}$/);
    expect(body.series[0].latest_artifact.role).toBe("route-role");
  });

  it("serves case-insensitive historical version-id prefix searches", async () => {
    const first = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "route-provider",
      series_key: "managed:route-prefix-search",
      logical_name: "route-prefix-search",
      content: "v1\n",
      media_type: "text/plain",
    }, 1000);
    recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "route-provider",
      series_key: "managed:route-prefix-search",
      logical_name: "route-prefix-search",
      content: "v2\n",
      media_type: "text/plain",
    }, 2000);
    const versionPrefix = first.version.id.replace(/^artifact-version:/, "").slice(0, 4).toUpperCase();
    const router = createRouter();

    const bare = await router.invoke({
      method: "GET",
      url: `/api/artifacts/series?q=${versionPrefix}`,
    });
    const typed = await router.invoke({
      method: "GET",
      url: `/api/artifacts/series?q=ARTIFACT-VERSION%3A${versionPrefix}`,
    });

    expect(bare.status).toBe(200);
    expect((bare.body as { series: Array<{ id: string }> }).series.map((item) => item.id))
      .toContain(first.series.id);
    expect(typed.status).toBe(200);
    expect((typed.body as { series: Array<{ id: string }> }).series.map((item) => item.id))
      .toContain(first.series.id);
  });

  it("serves short artifact-series refs through resolve and history routes", async () => {
    const first = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "route-short-series",
      logical_name: "route-short",
      content: "v1\n",
      media_type: "text/plain",
      role: "report",
    }, 1000);
    const second = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "route-short-series",
      logical_name: "route-short",
      content: "v2\n",
      media_type: "text/plain",
      role: "report",
    }, 2000);
    const router = createRouter();

    const resolved = await router.invoke({
      method: "GET",
      url: "/api/artifacts/resolve?ref=artifact-series%3Aroute-s%402",
    });
    const history = await router.invoke({
      method: "GET",
      url: "/api/artifacts/versions?ref=artifact-series%3Aroute-s%40latest",
    });

    expect(resolved.status).toBe(200);
    expect((resolved.body as any).resolution).toMatchObject({
      status: "resolved",
      artifact: { id: second.version.id },
      logical_artifact: { id: first.series.id.replace("artifact-series:","artifact:") },
      artifact_version: { version_no: 2 },
    });
    expect(history.status).toBe(200);
    expect((history.body as any).history).toMatchObject({
      series: { id: first.series.id, ref: expect.stringMatching(/^artifact-series:.{12,}$/) },
      versions: [
        { id: first.version.id, ref: expect.stringMatching(/^artifact-version:.{12,}$/) },
        { id: second.version.id, ref: expect.stringMatching(/^artifact-version:.{12,}$/) },
      ],
    });
  });

  it("round-trips projected short artifact ids through direct artifact routes", async () => {
    const selected = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "managed:round-trip",
      logical_name: "round-trip",
      content: "round trip\n",
      media_type: "text/plain",
      role: "report",
    }, 1000);
    const router = createRouter();
    const list = await router.invoke({
      method: "GET",
      url: "/api/artifacts/series?summary=true",
    });
    const publicId = (list.body as any).series[0].latest_version.artifact_id as string;
    const encodedId = encodeURIComponent(publicId);

    expect(publicId).toBe(selected.version.id);

    const [detail, content, check] = await Promise.all([
      router.invoke({ method: "GET", url: `/api/artifacts/${encodedId}` }),
      router.invoke({ method: "GET", url: `/api/artifacts/${encodedId}/content` }),
      router.invoke({ method: "GET", url: `/api/artifacts/${encodedId}/check` }),
    ]);

    expect(detail.status).toBe(200);
    expect((detail.body as any).artifact.id).toBe(publicId);
    expect(content.status).toBe(200);
    expect((content.body as any).content.artifact_id).toBe(publicId);
    expect(check.status).toBe(200);
    expect((check.body as any).check.artifact_id).toBe(publicId);
  });
});
