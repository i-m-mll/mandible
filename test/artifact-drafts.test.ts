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
import { createMigratedDbWithSeeds, migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { runCli, startStubDaemon } from "./helpers/cli-process.js";
import type { ResolvedClientIdentity } from "../src/server.js";

class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();
  get(pathname: string, handler: RouteHandler): void { this.handlers.set(`GET ${pathname}`, handler); }
  post(pathname: string, handler: RouteHandler): void { this.handlers.set(`POST ${pathname}`, handler); }
  put(pathname: string, handler: RouteHandler): void { this.handlers.set(`PUT ${pathname}`, handler); }
  patch(pathname: string, handler: RouteHandler): void { this.handlers.set(`PATCH ${pathname}`, handler); }
  delete(pathname: string, handler: RouteHandler): void { this.handlers.set(`DELETE ${pathname}`, handler); }
  async handle(method: string, pathname: string, req: Partial<RequestLike> = {}): Promise<{ statusCode: number; payload: any }> {
    const handler = this.handlers.get(`${method} ${pathname}`);
    if (!handler) throw new Error(`missing handler for ${method} ${pathname}`);
    const res = createResponse();
    await handler({
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

function managedVersion(content: string, now: number, format = { logical_name: "notes.md", media_type: "text/markdown" }) {
  return recordArtifactVersion(db, {
    source_kind: "managed",
    provider_id: "test",
    ...format,
    content,
  }, now);
}

function operatorIdentity(): ResolvedClientIdentity {
  db.close();
  const seeded = createMigratedDbWithSeeds({ operator: { slug: "reviewer", display_name: "Reviewer" }, setGlobal: true });
  db = seeded.db;
  return { user_id: seeded.seeds.operator!.id, slug: "reviewer", method: "local_os_user",
    source: "local_os_user", credential_id: null, effect_ceiling: ["ledger:read", "ledger:write"] };
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

  it("lets the author update a carried note while the CLI retains its original range", async () => {
    const actor = operatorIdentity();
    const format = { logical_name: "notes.txt", media_type: "text/plain" };
    const v1 = managedVersion("header\nline under review\nfooter\n", 1000, format);
    const routes = new TestRoutes();
    registerProviderRoutes(routes, inlineLedgerReader());
    const route = "/api/artifacts/:id/notes";
    const post = (id: string, body: Record<string, unknown>) => routes.handle("POST", route, {
      params: { id }, client_identity: actor, body,
    });
    const get = (id: string, anchors: boolean) => routes.handle("GET", route, { params: { id },
      client_identity: actor, query: anchors ? { anchors: "true" } : {},
    });

    const note = await post(v1.version.id, { kind: "add", start_offset: 1, end_offset: 2,
      quote: "line under review\n", body: "Check this" });
    expect(note.statusCode).toBe(200);
    const id = note.payload.id;
    const v2 = managedVersion("new header\nheader\nline awaiting review\nchanged footer\n", 1100, format);

    expect((await post(v2.version.id, { kind: "edit", id, body: "Verified" })).statusCode).toBe(200);
    expect((await post(v2.version.id, { kind: "resolve", id })).statusCode).toBe(200);
    expect((await get(v2.version.id, true)).payload.notes).toMatchObject([{ id, resolved: true }]);

    const original = await get(v1.series.id, false);
    const stub = await startStubDaemon(request => request.method === "GET" && request.url.endsWith("/notes")
      ? { body: original.payload } : { status: 404, body: {} });
    try {
      const output = await runCli(["artifact", "notes", v1.series.id], { cwd: tempDir, env: stub.env });
      expect(output.status, output.stderr).toBe(0);
      expect(output.stdout).toContain("line 2\n> line under review");
      expect(output.stdout).toContain("Verified");
    } finally {
      await stub.close();
    }
    expect((await post(v2.version.id, { kind: "retract", id })).statusCode).toBe(200);
    expect((await get(v1.version.id, false)).payload.notes).toEqual([]);
  });

  it("keeps pinned Markdown bytes through route load, draft save, and publish", async () => {
    const actor = operatorIdentity();
    const source = "\uFEFF# Draft\r\nEmoji 😀\nLast line";
    const v1 = managedVersion(source, 1000);
    const v2 = managedVersion("newer version", 1100);
    const routes = new TestRoutes();
    registerProviderRoutes(routes, inlineLedgerReader());

    const original = await routes.handle("GET", "/api/artifacts/:id/text", { params: { id: v1.version.id } });
    expect(original.statusCode).toBe(200);
    expect(Buffer.from(original.payload.text)).toEqual(Buffer.from(source));

    const saved = await routes.handle("POST", "/api/artifacts/drafts", {
      body: {
        ref: v1.series.id,
        base_version_id: v2.version.id,
        content: original.payload.text,
        media_type: "text/markdown",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.payload.draft.content).toBe(source);

    const read = await routes.handle("GET", "/api/artifacts/drafts", {
      query: { ref: v1.series.id },
    });
    expect(read.payload.draft.base_version_id).toBe(v2.version.id);

    const originalQuote = "Emoji 😃";
    const savedQuote = "Emoji 😀";
    const reviewSource = "\uFEFFTemporary\n" + source.slice(1).replace(savedQuote, originalQuote);
    saveArtifactDraft(db, { ref: v1.series.id, base_version_id: v2.version.id, content: reviewSource, media_type: "text/markdown" });
    const stage = (quote: string) => {
      const start = reviewSource.slice(1).indexOf(quote);
      return routes.handle("POST", "/api/artifacts/drafts/standing-notes", {
        client_identity: actor, body: { ref: v1.series.id, kind: "add", expected_source: reviewSource,
          start_offset: start, end_offset: start + quote.length, quote, body: quote },
      });
    };
    expect((await stage(originalQuote)).statusCode).toBe(200);
    expect((await stage("Temporary")).statusCode).toBe(200);
    saveArtifactDraft(db, { ref: v1.series.id, base_version_id: v2.version.id, content: source, media_type: "text/markdown" });
    const reloaded = getArtifactDraft(db, v1.series.id);
    expect(reloaded?.standing_notes).toMatchObject([
      { quote: originalQuote },
      { quote: "Temporary", anchor: { status: "detached" } },
    ]);

    const published = await routes.handle("POST", "/api/artifacts/drafts/publish", {
      body: { ref: v1.series.id, label: "ui" },
    });
    expect(published.payload.result.version.parent_version_id).toBe(v2.version.id);
    const publishedText = await routes.handle("GET", "/api/artifacts/:id/text", {
      params: { id: published.payload.result.version.id },
    });
    expect(Buffer.from(publishedText.payload.text)).toEqual(Buffer.from(source));
    const notes = await routes.handle("GET", "/api/artifacts/:id/notes", {
      params: { id: published.payload.result.version.id }, query: { anchors: "true" },
    });
    expect(notes.payload.notes).toMatchObject([
      { source_order: 3, quote: savedQuote, start_offset: source.slice(1).indexOf(savedQuote) },
      { source_order: 3, quote: "Temporary", draft_origin: { base_version_id: v2.version.id }, anchor: { status: "detached" } },
    ]);

    saveArtifactDraft(db, {
      ref: v1.series.id,
      base_version_id: published.payload.result.version.id,
      content: "second draft\n",
      media_type: "text/markdown",
    }, 1500);
    const deleted = await routes.handle("DELETE", "/api/artifacts/drafts", {
      query: { ref: v1.series.id },
    });
    expect(deleted.payload.deleted).toBe(true);
    expect(getArtifactDraft(db, v1.series.id)).toBeNull();
  });
});
