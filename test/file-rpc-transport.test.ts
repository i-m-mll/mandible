import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRpcTransport, isAllowedFileRpcRoute } from "../src/file-rpc-transport.js";
import { Router } from "../src/server.js";
import { readFileSync } from "node:fs";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("file RPC transport", () => {
  it("dispatches allowed requests through the router and writes response JSON", async () => {
    const router = new Router();
    router.get("/api/ledger/issues/:issueId", (req, res) => {
      res.json({
        issue_id: req.params.issueId,
        include: req.query.include,
      });
    });
    const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });

    fs.writeFileSync(
      path.join(tempDir, "req-1.request.json"),
      JSON.stringify({
        id: "req-1",
        method: "GET",
        path: "/api/ledger/issues/abc",
        query: { include: "comments" },
      }),
      "utf8",
    );

    await transport.processOnce();

    expect(fs.existsSync(path.join(tempDir, "req-1.request.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(tempDir, "req-1.response.json"), "utf8"))).toEqual({
      id: "req-1",
      status: 200,
      body: {
        issue_id: "abc",
        include: "comments",
      },
    });
  });

  it("passes explicit ambient identity through allowed file-RPC work-unit mutations", async () => {
    const router = new Router();
    router.post("/api/work-units/claim", (req, res) => {
      res.json({ ambient_identity: req.ambient_identity });
    });
    router.post("/api/work-units/release", (req, res) => {
      res.json({ ambient_identity: req.ambient_identity, body: req.body });
    });
    const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });

    fs.writeFileSync(
      path.join(tempDir, "req-work.request.json"),
      JSON.stringify({
        id: "req-work",
        method: "POST",
        path: "/api/work-units/claim",
        ambient_identity: { provider: "codex", provider_session_id: "thread-file-rpc" },
        body: { issue_id: "abc123", repo_id: "mandible" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempDir, "req-release.request.json"),
      JSON.stringify({
        id: "req-release",
        method: "POST",
        path: "/api/work-units/release",
        ambient_identity: { provider: "codex", provider_session_id: "thread-release-rpc" },
        body: { issue_id: "abc123", repo_id: "mandible" },
      }),
      "utf8",
    );

    await transport.processOnce();

    const response = JSON.parse(fs.readFileSync(path.join(tempDir, "req-work.response.json"), "utf8"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ambient_identity: { provider: "codex", provider_session_id: "thread-file-rpc" },
    });
    const release = JSON.parse(fs.readFileSync(path.join(tempDir, "req-release.response.json"), "utf8"));
    expect(release.status).toBe(200);
    expect(release.body).toEqual({
      ambient_identity: { provider: "codex", provider_session_id: "thread-release-rpc" },
      body: { issue_id: "abc123", repo_id: "mandible" },
    });
  });

  it("injects a spool attachment as a daemon-visible content_path and cleans it up (issue 833e972)", async () => {
    const router = new Router();
    let seenBody: Record<string, unknown> | undefined;
    let attachmentBytes = "";
    router.post("/api/artifacts/ingest", (req, res) => {
      seenBody = req.body as Record<string, unknown>;
      const contentPath = (req.body as Record<string, unknown>).content_path as string;
      attachmentBytes = fs.readFileSync(contentPath, "utf8");
      res.json({ artifact: { id: "artifact:sha256:abc", availability: "present", custody_mode: "copy" } });
    });
    const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });

    fs.writeFileSync(path.join(tempDir, "req-art.attach-content_path"), "PK big zip bytes", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "req-art.request.json"),
      JSON.stringify({
        id: "req-art",
        method: "POST",
        path: "/api/artifacts/ingest",
        body: { custody_mode: "copy", filename: "packet.zip" },
        attachments: { content_path: "req-art.attach-content_path" },
      }),
      "utf8",
    );

    await transport.processOnce();

    // The route saw an absolute content_path inside the spool dir, not inline bytes.
    expect(seenBody).toMatchObject({ custody_mode: "copy", filename: "packet.zip" });
    expect(typeof seenBody?.content_path).toBe("string");
    expect(path.dirname(seenBody?.content_path as string)).toBe(path.resolve(tempDir));
    expect(attachmentBytes).toBe("PK big zip bytes");
    const response = JSON.parse(fs.readFileSync(path.join(tempDir, "req-art.response.json"), "utf8"));
    expect(response.status).toBe(200);
    // Attachment is removed after dispatch; the request file is consumed.
    expect(fs.existsSync(path.join(tempDir, "req-art.attach-content_path"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "req-art.request.json"))).toBe(false);
  });

  it("strips a client-supplied content_path so the daemon never reads an arbitrary host path (issue 833e972)", async () => {
    const router = new Router();
    let seenBody: Record<string, unknown> | undefined;
    router.post("/api/artifacts/ingest", (req, res) => {
      seenBody = req.body as Record<string, unknown>;
      res.json({ ok: true });
    });
    const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });

    fs.writeFileSync(
      path.join(tempDir, "req-evil.request.json"),
      JSON.stringify({
        id: "req-evil",
        method: "POST",
        path: "/api/artifacts/ingest",
        body: { custody_mode: "copy", content_path: "/etc/passwd", content_buffer: "x" },
      }),
      "utf8",
    );

    await transport.processOnce();

    expect(seenBody).toEqual({ custody_mode: "copy" });
    expect(seenBody).not.toHaveProperty("content_path");
    expect(seenBody).not.toHaveProperty("content_buffer");
  });

  it("rejects attachment names that escape the spool dir or target non-allowlisted fields (issue 833e972)", async () => {
    const router = new Router();
    router.post("/api/artifacts/ingest", (_req, res) => res.json({ ok: true }));
    const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });

    fs.writeFileSync(
      path.join(tempDir, "req-trav.request.json"),
      JSON.stringify({
        id: "req-trav",
        method: "POST",
        path: "/api/artifacts/ingest",
        body: { custody_mode: "copy" },
        attachments: { content_path: "../../../etc/passwd" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempDir, "req-field.request.json"),
      JSON.stringify({
        id: "req-field",
        method: "POST",
        path: "/api/artifacts/ingest",
        body: { custody_mode: "copy" },
        attachments: { repo_locator: "req-field.attach" },
      }),
      "utf8",
    );

    await transport.processOnce();

    const traversal = JSON.parse(fs.readFileSync(path.join(tempDir, "req-trav.response.json"), "utf8"));
    expect(traversal.status).toBe(400);
    expect(traversal.body).toMatchObject({ error: "bad_file_rpc_request" });
    expect(traversal.body.detail).toMatch(/attachment_name_invalid/);
    const field = JSON.parse(fs.readFileSync(path.join(tempDir, "req-field.response.json"), "utf8"));
    expect(field.status).toBe(400);
    expect(field.body.detail).toMatch(/attachment_field_not_allowed/);
  });

  it("denies routes outside the file transport allowlist", async () => {
    const router = new Router();
    router.post("/api/auth/request/:id/approve", (_req, res) => {
      res.json({ ok: true });
    });
    const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });

    fs.writeFileSync(
      path.join(tempDir, "req-2.request.json"),
      JSON.stringify({
        id: "req-2",
        method: "POST",
        path: "/api/auth/request/auth-1/approve",
      }),
      "utf8",
    );

    await transport.processOnce();

    const response = JSON.parse(fs.readFileSync(path.join(tempDir, "req-2.response.json"), "utf8"));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "file_rpc_route_denied" });
  });

  it("keeps auth approval and admin endpoints out of the allowlist", () => {
    expect(isAllowedFileRpcRoute("GET", "/api/conversations")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/conversations/sources")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/conversations/search")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/conversations/conv-1")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/conversations/conv-1/blocks")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/conversations/conv-1/forks")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/work/repos")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/work-units")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/work-units/claim")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/work-units/activate")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/work-units/release")).toBe(true);
    expect(isAllowedFileRpcRoute("PATCH", "/api/work-units/wu-1")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/sessions/session-1/issues")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/system/logs")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/request")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/auth/request/abc/actions")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/request/abc/actions")).toBe(true);
    expect(isAllowedFileRpcRoute("PUT", "/api/auth/request/abc/actions/def")).toBe(true);
    expect(isAllowedFileRpcRoute("DELETE", "/api/auth/request/abc/actions/def")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/request/abc/actions/def/veto")).toBe(false);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/check")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/auth/queue")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/artifacts/resolve")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/artifacts/logical")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/artifacts/blobs")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/artifacts/associations")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/artifacts/associations")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/artifacts/ingest")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/artifacts/check")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/artifacts/snapshot")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/ledger/issues/abc/umbrella-status")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/ledger/issues/abc/umbrella-adopt")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/ledger/issues/abc/umbrella-reconcile")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/ledger/issues/abc/umbrella-manifest-refresh")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/ledger/issues/abc/parent-role")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/ledger/issues/abc/parent-role")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/ledger/issues/abc/checkpoints")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/ledger/issues/abc/checkpoints")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/ledger/relationships")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/ledger/relationships/unlink")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/r/issue/abc")).toBe(false);
    expect(isAllowedFileRpcRoute("GET", "/r/auth/auth-1")).toBe(false);
    expect(isAllowedFileRpcRoute("GET", "/r/artifact/abcdef1")).toBe(false);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/request/abc/approve")).toBe(false);
    expect(isAllowedFileRpcRoute("PATCH", "/api/conversations/conv-1")).toBe(false);
    expect(isAllowedFileRpcRoute("POST", "/api/conversations/conv-1/fork")).toBe(false);
    expect(isAllowedFileRpcRoute("DELETE", "/api/sessions/session-1/issues")).toBe(false);
    expect(isAllowedFileRpcRoute("PUT", "/api/settings/auto_close_issues_on_merge")).toBe(false);
    expect(isAllowedFileRpcRoute("POST", "/api/issues/scan")).toBe(false);
  });

  it("allowlists the knowledge-backrefs return channel (read + write) but nothing else under it", () => {
    expect(isAllowedFileRpcRoute("GET", "/api/knowledge-backrefs")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/knowledge-backrefs")).toBe(true);
    // Per-route, not prefix-wide: parameterized / unrelated shapes stay denied
    // until their owner enumerates them.
    expect(isAllowedFileRpcRoute("GET", "/api/artifacts/art-1/knowledge-backrefs")).toBe(false);
    expect(isAllowedFileRpcRoute("DELETE", "/api/knowledge-backrefs")).toBe(false);
    expect(isAllowedFileRpcRoute("PATCH", "/api/knowledge-backrefs")).toBe(false);
  });

  it("denies the knowledge-backrefs return channel through the transport when method differs", async () => {
    const router = new Router();
    router.put("/api/knowledge-backrefs", (_req, res) => {
      res.json({ ok: true });
    });
    const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });
    fs.writeFileSync(
      path.join(tempDir, "req-kb.request.json"),
      JSON.stringify({ id: "req-kb", method: "PUT", path: "/api/knowledge-backrefs" }),
      "utf8",
    );
    await transport.processOnce();
    const response = JSON.parse(fs.readFileSync(path.join(tempDir, "req-kb.response.json"), "utf8"));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "file_rpc_route_denied" });
  });
});

describe("file RPC per-route allowlist convention", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src", "file-rpc-transport.ts"),
    "utf8",
  );

  it("never blanket-allows the /api/spaces prefix (each route is enumerated by its owner)", () => {
    // A space route that nobody has enumerated must be rejected — proves there
    // is no catch-all prefix match.
    expect(isAllowedFileRpcRoute("GET", "/api/spaces/spc-1/not-a-real-route")).toBe(false);
    expect(isAllowedFileRpcRoute("POST", "/api/spaces/spc-1/unknown")).toBe(false);
    expect(isAllowedFileRpcRoute("DELETE", "/api/spaces")).toBe(false);

    // And the allowlist body must not contain a blanket prefix construct: no
    // `startsWith("/api/spaces"...)` and no unanchored `/^\/api\/spaces/` catch-all
    // (every enumerated spaces regex is anchored with a trailing `$`).
    const allowFn = source.slice(source.indexOf("export function isAllowedFileRpcRoute"));
    expect(allowFn).not.toMatch(/startsWith\(\s*["'`]\/api\/spaces/);
    expect(allowFn).not.toMatch(/\/\^\\\/api\\\/spaces\\\/\.\*\//);
    expect(allowFn).not.toMatch(/\/\^\\\/api\\\/spaces\/\.test/);
  });

  it("documents the per-route self-allowlist convention", () => {
    expect(source).toMatch(/per-route file-RPC allowlist/i);
    expect(source).toMatch(/self-allowlist/i);
    expect(source).toMatch(/does NOT blanket-allow/);
  });
});
