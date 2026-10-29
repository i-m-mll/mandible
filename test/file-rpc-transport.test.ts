import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, setDb, type Db } from "../src/db.js";
import { AuthQueue } from "../src/auth-queue.js";
import { FileRpcTransport, defaultFileRpcDirForInstance } from "../src/file-rpc-transport.js";
import { addProject } from "../src/ledger/project-registry.js";
import { registerProjectRoutes } from "../src/routes/projects.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router, type RouteHandler } from "../src/server.js";
import { createLedgerIssue, createLedgerProject, migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { LedgerStore } from "../src/ledger/store.js";
import { systemAction } from "../src/identity/resolver.js";

let tempDir = "";
let policyRouter: Router | null = null;
const CLI = path.join(process.cwd(), "bin", "mandible");

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it("denies the production approval route over file RPC before request lookup", async () => {
  const db = migratedMemoryDb();
  setDb(db);
  const queue = new AuthQueue({ db, backgroundMaintenance: false });
  try {
    const router = new Router();
    registerAuthRoutes(router, queue, {} as never, undefined, inlineLedgerReader(() => queue.db));
    const transport = new FileRpcTransport({ router, dir: tempDir });
    fs.writeFileSync(path.join(tempDir, "denied.request.json"), JSON.stringify({
      id: "denied",
      method: "POST",
      path: "/api/auth/request/not-a-request/approve",
    }));

    await transport.processOnce();

    expect(JSON.parse(fs.readFileSync(path.join(tempDir, "denied.response.json"), "utf8")))
      .toMatchObject({ status: 403 });
  } finally {
    (await queue.dispose());
    db.close();
  }
});

it("persists file-RPC native origin with its authoritative comment revision", async () => {
  const db = migratedMemoryDb();
  try {
    const project = createLedgerProject(db, tempDir);
    const issue = createLedgerIssue(db, { project_id: project.project.id });
    const store = new LedgerStore(db);
    const router = new Router();
    router.post('/api/ledger/issues/:issueId/comments', (_req, res) => {
      res.json(store.addComment(issue.id, { body: 'From file RPC', actor_type: 'system', author_display: 'System', attribution: systemAction() }));
    }, { fileRpc: 'allow', operation: { id: 'fixture.origin-comment', effects: ['ledger:write'], reportingCategory: 'ledger', requestSchema: null } });
    const origin = { provider: 'claude', provider_session_id: 'exact-file-native' };
    fs.writeFileSync(path.join(tempDir, 'origin.request.json'), JSON.stringify({ id: 'origin', method: 'POST',
      path: `/api/ledger/issues/${issue.id}/comments`, request_origin: origin }));
    await new FileRpcTransport({ router, dir: tempDir }).processOnce();
    const response = JSON.parse(fs.readFileSync(path.join(tempDir, 'origin.response.json'), 'utf8'));
    expect(response.status).toBe(200);
    expect(store.listBodyRevisions({ entity_type: 'comment_body', entity_id: response.body.id })[0].request_origin).toEqual(origin);
  } finally { db.close(); }
});

const noop: RouteHandler = (_req, res) => {
  res.json({ ok: true });
};

const legacyAllowedRoutes: Array<[method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string]> = [
  ["GET", "/api/conversations"],
  ["GET", "/api/conversations/sources"],
  ["GET", "/api/conversations/search"],
  ["GET", "/api/conversations/:id"],
  ["GET", "/api/conversations/:id/blocks"],
  ["GET", "/api/conversations/:id/forks"],
  ["GET", "/api/issues"],
  ["POST", "/api/issues/resolutions"],
  ["GET", "/api/ledger/issues/:issueId"],
  ["GET", "/api/ledger/changes"],
  ["PATCH", "/api/ledger/issues/:issueId"],
  ["GET", "/api/ledger/issues/:issueId/umbrella-status"],
  ["POST", "/api/ledger/issues/:issueId/umbrella-adopt"],
  ["POST", "/api/ledger/issues/:issueId/umbrella-manifest-refresh"],
  ["GET", "/api/ledger/issues/:issueId/parent-role"],
  ["POST", "/api/ledger/issues/:issueId/parent-role"],
  ["GET", "/api/ledger/issues/:issueId/head"],
  ["GET", "/api/ledger/issues/:issueId/body/revisions"],
  ["POST", "/api/ledger/issues/:issueId/comments"],
  ["GET", "/api/ledger/issues/:issueId/checkpoints"],
  ["POST", "/api/ledger/issues/:issueId/checkpoints"],
  ["POST", "/api/ledger/relationships"],
  ["POST", "/api/ledger/relationships/unlink"],
  ["POST", "/api/ledger/issues/:issueId/worker-status"],
  ["POST", "/api/ledger/issues/:issueId/branches"],
  ["POST", "/api/ledger/issues/:issueId/labels"],
  ["GET", "/api/ledger/comments/:commentId/revisions"],
  ["PATCH", "/api/ledger/comments/:commentId"],
  ["GET", "/api/ledger/body-revisions/:revisionId"],
  ["GET", "/api/auth/queue"],
  ["GET", "/api/auth/request/:id"],
  ["POST", "/api/auth/check"],
  ["POST", "/api/auth/v2/request"],
  ["POST", "/api/auth/request/:id/withdraw"],
  ["POST", "/api/auth/request/:id/candidate-snapshot-repair/inspect"],
  ["POST", "/api/auth/request/:id/candidate-snapshot-repair/apply"],
  ["POST", "/api/auth/request/:id/replay-codex-archives"],
  ["GET", "/api/auth/request/:id/actions"],
  ["POST", "/api/auth/request/:id/actions"],
  ["PUT", "/api/auth/request/:id/actions/:actionId"],
  ["DELETE", "/api/auth/request/:id/actions/:actionId"],
  ["GET", "/api/inbox"],
  ["GET", "/api/inbox/global"],
  ["GET", "/api/inbox/undelivered"],
  ["POST", "/api/inbox/:type/:id/ack"],
  ["POST", "/api/inbox/delivered/:id"],
  ["GET", "/api/artifacts"],
  ["GET", "/api/artifacts/resolve"],
  ["GET", "/api/artifacts/logical"],
  ["GET", "/api/artifacts/blobs"],
  ["GET", "/api/artifacts/associations"],
  ["POST", "/api/artifacts/associations"],
  ["POST", "/api/artifacts/ingest"],
  ["POST", "/api/artifacts/plan"],
  ["POST", "/api/artifacts/scan-repos"],
  ["POST", "/api/artifacts/link"],
  ["POST", "/api/artifacts/check"],
  ["POST", "/api/artifacts/snapshot"],
  ["POST", "/api/artifacts/bundles"],
  ["GET", "/api/artifacts/bundles/:id"],
  ["POST", "/api/artifacts/bundles/:id/members"],
  ["GET", "/api/artifacts/:id"],
  ["GET", "/api/artifacts/:id/content"],
  ["GET", "/api/artifacts/:id/check"],
  ["GET", "/api/artifacts/versions"],
  ["GET", "/api/artifacts/diff"],
  ["POST", "/api/artifacts/versions"],
  ["GET", "/api/knowledge-backrefs"],
  ["POST", "/api/knowledge-backrefs"],
  ["GET", "/api/projects"],
  ["POST", "/api/projects"],
  ["GET", "/api/projects/audit"],
  ["POST", "/api/projects/repair"],
  ["POST", "/api/projects/checkouts"],
  ["GET", "/api/projects/:ref"],
  ["PATCH", "/api/projects/:ref"],
  ["POST", "/api/projects/:ref/checkouts"],
  ["GET", "/api/system/logs"],
  ["POST", "/api/work-units/claim"],
  ["POST", "/api/work-units/activate"],
  ["POST", "/api/work-units/release"],
  ["GET", "/api/work-units"],
  ["PATCH", "/api/work-units/:id"],
  ["GET", "/api/sessions/by-pid/:pid"],
  ["POST", "/api/sessions/register"],
  ["PATCH", "/api/sessions/:id"],
  ["PATCH", "/api/sessions/:id/end"],
  ["POST", "/api/sessions/:id/issues"],
  ["GET", "/api/sessions/:id/issues"],
  ["GET", "/api/work/repos"],
];

function buildPolicyRouter(): Router {
  const router = new Router();
  for (const [method, routePath] of legacyAllowedRoutes) {
    router[method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete"](
      routePath,
      noop,
      { operation: { id: `fixture:${method}:${routePath}`, effects: [], requestSchema: null, reportingCategory: null }, fileRpc: "allow" },
    );
  }
  router.post(
    "/api/issues/:repoId",
    noop,
    { operation: { id: "fixture:post:/api/issues/:repoId", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "allow" },
  );
  return router;
}

function allowsFileRpcRoute(method: string, pathname: string): boolean {
  policyRouter ??= buildPolicyRouter();
  return policyRouter.resolveFileRpcPolicy(method, pathname);
}

async function runCliWithTransport(
  args: string[],
  transport: FileRpcTransport,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let stopped = false;
  const pump = async () => {
    if (stopped) return;
    await transport.processOnce();
  };
  await pump();
  const timer = setInterval(() => {
    void pump();
  }, 10);

  return await new Promise((resolve) => {
    const child = spawn(CLI, args, {
      env: {
        ...process.env,
        MANDIBLE_BASE: `file://${transport.dir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      stopped = true;
      clearInterval(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("file RPC transport", () => {
  it("uses preview-scoped spools instead of the shared agent-rpc spool for preview instances", () => {
    const shared = path.join(os.homedir(), ".cache", "mandible", "agent-rpc");
    const instance = {
      role: "preview" as const,
      operational_mutations: "reject" as const,
      operational_mutations_overridden: false,
      db_path: path.join(tempDir, "preview.db"),
      db_path_source: "iab-preview-copy",
    };

    expect(defaultFileRpcDirForInstance(instance, {})).toBe(path.join(tempDir, "agent-rpc"));
    expect(defaultFileRpcDirForInstance(instance, { MANDIBLE_FILE_RPC_DIR: shared })).toBe(
      path.join(tempDir, "agent-rpc"),
    );
    expect(defaultFileRpcDirForInstance(instance, { MANDIBLE_FILE_RPC_DIR: path.join(tempDir, "custom") }))
      .toBe(path.join(tempDir, "custom"));
  });

  it("dispatches allowed requests through the router and writes response JSON", async () => {
    const router = new Router();
    router.get("/api/ledger/issues/:issueId", (req, res) => {
      res.json({
        issue_id: req.params.issueId,
        include: req.query.include,
      });
    }, { operation: { id: "fixture:get:/api/ledger/issues/:issueId", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
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
    }, { operation: { id: "fixture:post:/api/work-units/claim", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "allow" });
    router.post("/api/work-units/release", (req, res) => {
      res.json({ ambient_identity: req.ambient_identity, body: req.body });
    }, { operation: { id: "fixture:post:/api/work-units/release", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "allow" });
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
      res.json({ artifact: { id: "artifact:abc123def456", availability: "present", custody_mode: "copy" } });
    }, { operation: { id: "fixture:post:/api/artifacts/ingest", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "allow" });
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
    }, { operation: { id: "fixture:post:/api/artifacts/ingest", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "allow" });
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
    router.post("/api/artifacts/ingest", (_req, res) => res.json({ ok: true }), { operation: { id: "fixture:post:/api/artifacts/ingest", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "allow" });
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
    }, { operation: { id: "fixture:post:/api/auth/request/:id/approve", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "deny" });
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

  it("serves the real mandible CLI through file RPC and registered project routes", async () => {
    const db: Db = new SqliteDatabase(":memory:");
    try {
      migrate(db);
      setDb(db);
      addProject(db, {
        project_key: "feedbax",
        display_name: "Feedbax",
        remote_identity: "git@github.com:mll/feedbax.git",
      });

      const router = new Router();
      registerProjectRoutes(router);
      expect(router.resolveFileRpcPolicy("GET", "/api/projects")).toBe(true);

      const transport = new FileRpcTransport({ router, dir: tempDir, responseTtlMs: 60_000 });
      const result = await runCliWithTransport(["project", "list", "--json"], transport);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        projects: Array<{ project_key: string; display_name: string; remote_identity: string }>;
      };
      expect(body.projects).toEqual([
        expect.objectContaining({
          project_key: "feedbax",
          display_name: "Feedbax",
          remote_identity: "github.com/mll/feedbax",
        }),
      ]);
      expect(fs.readdirSync(tempDir).filter((file) => file.endsWith(".request.json"))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps auth approval and admin endpoints out of the allowlist", () => {
    expect(allowsFileRpcRoute("GET", "/api/conversations")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/conversations/sources")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/conversations/search")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/conversations/conv-1")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/conversations/conv-1/blocks")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/conversations/conv-1/forks")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/work/repos")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/work-units")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/work-units/claim")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/work-units/activate")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/work-units/release")).toBe(true);
    expect(allowsFileRpcRoute("PATCH", "/api/work-units/wu-1")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/sessions/session-1/issues")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/system/logs")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/auth/v2/request")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/auth/request/abc/withdraw")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/auth/request/abc/candidate-snapshot-repair/inspect")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/auth/request/abc/candidate-snapshot-repair/apply")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/auth/request/abc/replay-codex-archives")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/auth/request/abc/actions")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/auth/request/abc/actions")).toBe(true);
    expect(allowsFileRpcRoute("PUT", "/api/auth/request/abc/actions/def")).toBe(true);
    expect(allowsFileRpcRoute("DELETE", "/api/auth/request/abc/actions/def")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/auth/request/abc/actions/def/veto")).toBe(false);
    expect(allowsFileRpcRoute("POST", "/api/auth/check")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/auth/queue")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/resolve")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/logical")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/blobs")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/associations")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/artifacts/associations")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/artifacts/ingest")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/artifacts/scan-repos")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/artifacts/check")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/artifacts/snapshot")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/art-1")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/art-1/content")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/art-1/check")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/artifacts/bundles")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/artifacts/bundles/bundle-1")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/artifacts/bundles/bundle-1/members")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/ledger/issues/abc/umbrella-status")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/ledger/issues/abc/umbrella-adopt")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/ledger/issues/abc/umbrella-manifest-refresh")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/ledger/issues/abc/parent-role")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/ledger/issues/abc/parent-role")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/ledger/issues/abc/checkpoints")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/ledger/issues/abc/checkpoints")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/ledger/relationships")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/ledger/relationships/unlink")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/inbox")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/inbox/global")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/inbox/undelivered")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/inbox/auth_result/auth-1/ack")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/inbox/delivered/auth-1")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/sessions/by-pid/1234")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/sessions/register")).toBe(true);
    expect(allowsFileRpcRoute("PATCH", "/api/sessions/session-1")).toBe(true);
    expect(allowsFileRpcRoute("PATCH", "/api/sessions/session-1/end")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/api/sessions/session-1/issues")).toBe(true);
    expect(allowsFileRpcRoute("GET", "/r/issue/abc")).toBe(false);
    expect(allowsFileRpcRoute("GET", "/r/auth/auth-1")).toBe(false);
    expect(allowsFileRpcRoute("GET", "/r/artifact/abcdef1")).toBe(false);
    expect(allowsFileRpcRoute("POST", "/api/auth/request/abc/approve")).toBe(false);
    expect(allowsFileRpcRoute("GET", "/api/events")).toBe(false);
    expect(allowsFileRpcRoute("PATCH", "/api/conversations/conv-1")).toBe(false);
    expect(allowsFileRpcRoute("POST", "/api/conversations/conv-1/fork")).toBe(false);
    expect(allowsFileRpcRoute("DELETE", "/api/sessions/session-1/issues")).toBe(false);
    expect(allowsFileRpcRoute("PUT", "/api/settings/auto_close_issues_on_merge")).toBe(false);
  });

  it("keeps the daemon-backed CLI route examples available over file RPC", () => {
    const examples: Array<[string, string, string]> = [
      ["GET", "/api/issues", "issue list/auth alias lookup"],
      ["POST", "/api/issues/mandible", "issue new/inbox add"],
      ["GET", "/api/ledger/issues/abc", "issue show/report/title"],
      ["PATCH", "/api/ledger/issues/abc", "issue close/open/description edit"],
      ["POST", "/api/ledger/issues/abc/comments", "issue comment add"],
      ["PATCH", "/api/ledger/comments/comment-1", "issue comment edit"],
      ["GET", "/api/ledger/comments/comment-1/revisions", "issue comment show/history"],
      ["GET", "/api/ledger/body-revisions/rev-1", "issue revision show/diff"],
      ["GET", "/api/projects", "project list"],
      ["PATCH", "/api/projects/mandible", "project update"],
      ["POST", "/api/projects/mandible/checkouts", "project add-checkout"],
      ["POST", "/api/projects/checkouts", "project update-checkout"],
      ["POST", "/api/auth/check", "auth check"],
      ["POST", "/api/auth/v2/request", "auth request --no-watch"],
      ["POST", "/api/auth/request/auth-1/replay-codex-archives", "auth replay-archives"],
      ["GET", "/api/artifacts/art-1", "artifact show"],
      ["GET", "/api/artifacts/art-1/content", "artifact content"],
      ["POST", "/api/artifacts/scan-repos", "artifact scan-repos"],
      ["POST", "/api/artifacts/bundles", "artifact bundle create"],
      ["GET", "/api/artifacts/bundles/bundle-1", "artifact bundle show/check"],
      ["POST", "/api/artifacts/bundles/bundle-1/members", "artifact bundle add"],
      ["GET", "/api/inbox", "inbox check/default"],
      ["POST", "/api/inbox/auth_result/auth-1/ack", "inbox ack"],
      ["GET", "/api/sessions/by-pid/1234", "task lookup"],
      ["PATCH", "/api/sessions/session-1", "task update"],
      ["POST", "/api/sessions/register", "wrap register"],
      ["PATCH", "/api/sessions/session-1/end", "wrap end"],
      ["GET", "/api/work-units", "work-unit find"],
      ["PATCH", "/api/work-units/work-unit-1", "work-unit resolve"],
      ["POST", "/api/sessions/session-1/issues", "session link-issue"],
      ["GET", "/api/conversations/search", "search/conversations search"],
      ["GET", "/api/system/logs", "logs/system log index"],
      ["GET", "/api/work/repos", "repo lookup helpers"],
    ];

    for (const [method, pathname, label] of examples) {
      expect(allowsFileRpcRoute(method, pathname), `${method} ${pathname} (${label})`).toBe(true);
    }
  });

  it("allowlists the knowledge-backrefs return channel (read + write) but nothing else under it", () => {
    expect(allowsFileRpcRoute("GET", "/api/knowledge-backrefs")).toBe(true);
    expect(allowsFileRpcRoute("POST", "/api/knowledge-backrefs")).toBe(true);
    // Per-route, not prefix-wide: parameterized / unrelated shapes stay denied
    // until their owner enumerates them.
    expect(allowsFileRpcRoute("GET", "/api/artifacts/art-1/knowledge-backrefs")).toBe(false);
    expect(allowsFileRpcRoute("DELETE", "/api/knowledge-backrefs")).toBe(false);
    expect(allowsFileRpcRoute("PATCH", "/api/knowledge-backrefs")).toBe(false);
  });

  it("denies the knowledge-backrefs return channel through the transport when method differs", async () => {
    const router = new Router();
    router.put("/api/knowledge-backrefs", (_req, res) => {
      res.json({ ok: true });
    }, { operation: { id: "fixture:put:/api/knowledge-backrefs", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: "deny" });
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
  it("never blanket-allows the /api/spaces prefix (each route is enumerated by its owner)", () => {
    // A space route that nobody has enumerated must be rejected — proves there
    // is no catch-all prefix match.
    const router = new Router();
    router.get("/api/spaces/:id", noop, { operation: { id: "fixture:get:/api/spaces/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
    expect(router.resolveFileRpcPolicy("GET", "/api/spaces/spc-1")).toBe(true);
    expect(router.resolveFileRpcPolicy("GET", "/api/spaces/spc-1/not-a-real-route")).toBe(false);
    expect(router.resolveFileRpcPolicy("POST", "/api/spaces/spc-1/unknown")).toBe(false);
    expect(router.resolveFileRpcPolicy("DELETE", "/api/spaces")).toBe(false);
  });

  it("exposes per-route policy metadata from the router", () => {
    const router = new Router();
    router.get("/api/spaces/:id", noop, { operation: { id: "fixture:get:/api/spaces/:id", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });
    router.get("/api/spaces/:id/items", noop, { operation: { id: "fixture:get:/api/spaces/:id/items", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });
    expect(router.listRoutePolicies()).toMatchObject([
      { method: "GET", path: "/api/spaces/:id", fileRpc: "allow" },
      { method: "GET", path: "/api/spaces/:id/items", fileRpc: "deny" },
    ]);
  });
});
