import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { getArtifactDraft, rebaseArtifactDraft, saveArtifactDraft } from "../src/provider-artifacts.js";
import { publishArtifactDraft, recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();
  get(pathname: string, handler: RouteHandler): void { this.handlers.set(`GET ${pathname}`, handler); }
  post(pathname: string, handler: RouteHandler): void { this.handlers.set(`POST ${pathname}`, handler); }
  put(pathname: string, handler: RouteHandler): void { this.handlers.set(`PUT ${pathname}`, handler); }
  patch(pathname: string, handler: RouteHandler): void { this.handlers.set(`PATCH ${pathname}`, handler); }
  delete(pathname: string, handler: RouteHandler): void { this.handlers.set(`DELETE ${pathname}`, handler); }
  handle(method: string, pathname: string, req: Partial<RequestLike> = {}): { statusCode: number; payload: any } {
    const handler = this.handlers.get(`${method} ${pathname}`);
    if (!handler) throw new Error(`missing handler for ${method} ${pathname}`);
    const res = createResponse();
    handler({
      method,
      url: pathname,
      params: {},
      query: {},
      body: {},
      ...req,
    } as RequestLike, res);
    return { statusCode: res.statusCode, payload: res.payload };
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

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-drafts-"));
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "artifacts");
  db = migratedMemoryDb();
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MANDIBLE_ARTIFACT_DIR;
});

function managedVersion(content: string, now: number) {
  return recordArtifactVersion(db, {
    source_kind: "managed",
    provider_id: "test",
    logical_name: "notes.md",
    media_type: "text/markdown",
    content,
  }, now);
}

describe("artifact drafts", () => {
  it("saves one server-side draft per series and marks stale bases", () => {
    const v1 = managedVersion("# v1\n", 1000);
    const draft = saveArtifactDraft(db, {
      ref: v1.series.id,
      base_version_id: v1.version.id,
      content: "# draft\n",
      media_type: "text/markdown",
    }, 1100);

    expect(draft).toMatchObject({
      series_id: v1.series.id,
      base_version_id: v1.version.id,
      base_version_no: 1,
      stale: false,
      content: "# draft\n",
    });

    const v2 = managedVersion("# v2\n", 1200);
    const stale = getArtifactDraft(db, v1.series.id);
    expect(stale).toMatchObject({
      base_version_id: v1.version.id,
      latest_version_id: v2.version.id,
      latest_version_no: 2,
      stale: true,
    });
  });

  it("rebases stale drafts with conflict markers and publishes with a parent pointer", () => {
    const v1 = managedVersion("a\nb\n", 1000);
    saveArtifactDraft(db, {
      ref: v1.series.id,
      base_version_id: v1.version.id,
      content: "a\nours\n",
      media_type: "text/markdown",
    }, 1100);
    managedVersion("a\ntheirs\n", 1200);

    const rebased = rebaseArtifactDraft(db, v1.series.id, 1300);
    expect(rebased.stale).toBe(false);
    expect(rebased.content).toContain("<<<<<<< draft");
    expect(rebased.content).toContain(">>>>>>> latest v2");

    const published = publishArtifactDraft(db, {
      ref: v1.series.id,
      label: "resolved",
    }, 1400);
    expect(published.result.version.version_no).toBe(3);
    expect(published.result.version.parent_version_id).toBe(rebased.base_version_id);
    expect(published.result.version.label).toBe("resolved");
    expect(getArtifactDraft(db, v1.series.id)).toBeNull();
  });

  it("exposes draft save, read, publish, and delete through provider routes", () => {
    const v1 = managedVersion("hello\n", 1000);
    const routes = new TestRoutes();
    registerProviderRoutes(routes, inlineLedgerReader());

    const saved = routes.handle("POST", "/api/artifacts/drafts", {
      body: {
        ref: v1.series.id,
        base_version_id: v1.version.id,
        content: "hello edited\n",
        media_type: "text/markdown",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.payload.draft.content).toBe("hello edited\n");

    const read = routes.handle("GET", "/api/artifacts/drafts", {
      query: { ref: v1.series.id },
    });
    expect(read.payload.draft.base_version_id).toBe(v1.version.id);

    const published = routes.handle("POST", "/api/artifacts/drafts/publish", {
      body: { ref: v1.series.id, label: "ui" },
    });
    expect(published.payload.result.version.parent_version_id).toBe(v1.version.id);

    saveArtifactDraft(db, {
      ref: v1.series.id,
      base_version_id: published.payload.result.version.id,
      content: "second draft\n",
      media_type: "text/markdown",
    }, 1500);
    const deleted = routes.handle("DELETE", "/api/artifacts/drafts", {
      query: { ref: v1.series.id },
    });
    expect(deleted.payload.deleted).toBe(true);
    expect(getArtifactDraft(db, v1.series.id)).toBeNull();
  });
});
