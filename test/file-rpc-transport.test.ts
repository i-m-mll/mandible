import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRpcTransport, isAllowedFileRpcRoute } from "../src/file-rpc-transport.js";
import { Router } from "../src/server.js";

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
    expect(isAllowedFileRpcRoute("POST", "/api/auth/request")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/auth/request/abc/actions")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/request/abc/actions")).toBe(true);
    expect(isAllowedFileRpcRoute("PUT", "/api/auth/request/abc/actions/def")).toBe(true);
    expect(isAllowedFileRpcRoute("DELETE", "/api/auth/request/abc/actions/def")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/request/abc/actions/def/veto")).toBe(false);
    expect(isAllowedFileRpcRoute("POST", "/api/auth/check")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/auth/queue")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/artifacts/resolve")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/artifacts/ingest")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/artifacts/check")).toBe(true);
    expect(isAllowedFileRpcRoute("POST", "/api/artifacts/snapshot")).toBe(true);
    expect(isAllowedFileRpcRoute("GET", "/api/ledger/issues/abc/umbrella-status")).toBe(true);
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
    expect(isAllowedFileRpcRoute("PUT", "/api/settings/auto_close_issues_on_merge")).toBe(false);
    expect(isAllowedFileRpcRoute("POST", "/api/issues/scan")).toBe(false);
  });
});
