import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { systemAction } from "../src/identity/resolver.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { addGrant, setProjectRestricted } from "../src/permissions/store.js";
import { associateProjectArtifact, ingestArtifact } from "../src/provider-artifacts.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { registerConsoleRoutes } from "../src/routes/console.js";
import { registerConversationSpawnRoutes } from "../src/routes/conversation-spawn.js";
import { registerConversationControlRoutes } from "../src/routes/conversation-control.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import { registerWorkRoutes } from "../src/routes/work.js";
import { Router } from "../src/server.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import type { ArtifactResolveResult } from "../src/types.js";
import { createUser, setupOperator } from "../src/users/store.js";

const SYSTEM_ACTOR = { attribution: systemAction() };

const fakeScanner = {
  getRepos: () => [],
  getRepoById: () => undefined,
  getBranches: () => [],
} as never;

describe("restricted project route enforcement", () => {
  let db: Db;
  let tempDir: string;
  let authenticator: ClientAuthenticator;
  let router: Router;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-permission-routes-"));
    db = new SqliteDatabase(":memory:");
    migrate(db);
    setDb(db);
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    authenticator = new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "auth") });
    router = new Router({ clientAuth: authenticator });
    registerIssueRoutes(router, fakeScanner);
    setClientAuthMode(db, "strict");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("denies then restores agent HTTP and file-RPC writes through an agents-group grant", async () => {
    const project = addProject(db, { project_key: "restricted", display_name: "Restricted" });
    setProjectRestricted(db, project.id, true);
    const agent = createUser(db, { slug: "route-agent", kind: "agent", display_name: "Route Agent" });
    const { token } = authenticator.mintApiToken(agent.id);
    const request = (title: string) => ({
      method: "POST",
      url: "/api/issues/anything",
      body: { project: project.id, title, body: "Body", kind: "feature" },
      credential: token,
    } as const);

    expect((await router.invoke({ ...request("HTTP denied"), transport: "http" })).status).toBe(403);
    const rpc = new FileRpcTransport({ router, dir: path.join(tempDir, "rpc") });
    expect((await runFileRpc(rpc, {
      method: "POST",
      path: "/api/issues/anything",
      body: { project: project.id, title: "RPC denied", body: "Body", kind: "feature" },
      capability_token: token,
    })).status).toBe(403);

    addGrant(db, {
      subject_type: "group",
      subject: "agents",
      resource_type: "project",
      resource: project.id,
      permission: "write",
    });
    expect((await router.invoke({ ...request("HTTP granted"), transport: "http" })).status).toBe(200);
    expect((await runFileRpc(rpc, {
      method: "POST",
      path: "/api/issues/anything",
      body: { project: project.id, title: "RPC granted", body: "Body", kind: "feature" },
      capability_token: token,
    })).status).toBe(200);
  });

  it("keeps the operator implicit admin on restricted projects", async () => {
    const project = addProject(db, { project_key: "restricted", display_name: "Restricted" });
    setProjectRestricted(db, project.id, true);
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const { token } = authenticator.mintApiToken(operator.id);
    const response = await router.invoke({
      method: "POST",
      url: "/api/issues/anything",
      body: { project: project.id, title: "Operator write", body: "Body" },
      credential: token,
      transport: "http",
    });
    expect(response.status).toBe(200);
  });

  it("denies agent conversation spawn until spawn_console is granted", async () => {
    const project = addProject(db, { project_key: "spawn-project", display_name: "Spawn Project" });
    db.prepare(`INSERT INTO ledger_project_checkouts
      (id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at)
      VALUES ('spawn-checkout', ?, 'spawn-project', '/work/spawn-project', 'Spawn Project', 'main', '', 1, 1)`)
      .run(project.id);
    const agent = createUser(db, { slug: "console-agent", kind: "agent", display_name: "Console Agent" });
    const { token } = authenticator.mintApiToken(agent.id);
    let failNext = false;
    let waitForCancellation = false;
    const control = {
      acquireNew: vi.fn(async (request, commit) => {
        if (waitForCancellation) {
          await new Promise<void>((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
          return { ok: false, error: {
            kind: "adapter-failure",
            adapter_id: "native-test",
            code: "acquisition-aborted",
            message: "cancelled",
            retryable: true,
          } };
        }
        if (failNext) {
          failNext = false;
          return { ok: false, error: {
            kind: "adapter-failure",
            adapter_id: "native-test",
            code: "startup-failed",
            message: "raw native provider secret",
            retryable: true,
          } };
        }
        const lease = {
          adapter_id: request.provider === "codex" ? "codex-app-server-v2" : "claude-stream-json-v1",
          controller_instance_id: `controller-${request.conversation_id}`,
          provider_session_id: `provider-${request.conversation_id}`,
        };
        commit(lease);
        return { ok: true, value: lease };
      }),
    };
    registerConversationSpawnRoutes(router, db, control as never);
    const input = {
      method: "POST",
      url: "/api/conversation-spawns",
      body: {
        schema: "mandible-conversation-spawn-request@3",
        idempotency_key: "10000000-0000-4000-8000-000000000001",
        provider: "codex",
        placement: { kind: "project", project_id: project.id, checkout_id: "spawn-checkout" },
      },
      credential: token,
      transport: "http" as const,
    };
    expect((await router.invoke(input)).status).toBe(403);
    expect(control.acquireNew).not.toHaveBeenCalled();
    addGrant(db, {
      subject_type: "user",
      subject: agent.id,
      resource_type: "global",
      permission: "spawn_console",
    });
    const allowed = await router.invoke(input);
    expect(allowed.status).toBe(202);
    expect(allowed.body).toMatchObject({
      conversation_id: "10000000-0000-4000-8000-000000000001",
      spawn: { state: "ready", native_session_id: "provider-10000000-0000-4000-8000-000000000001" },
    });
    expect(control.acquireNew).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "10000000-0000-4000-8000-000000000001",
      provider: "codex",
      generation: 1,
      cwd: "/work/spawn-project",
      runtime_options: { model: "gpt-5.6-sol", permission_mode: "agent-full-access" },
      signal: expect.any(AbortSignal),
    }), expect.any(Function));
    expect(db.prepare("SELECT source, session_id, cwd FROM conversations WHERE id = ?")
      .get("10000000-0000-4000-8000-000000000001")).toEqual({
        source: "codex",
        session_id: "provider-10000000-0000-4000-8000-000000000001",
        cwd: "/work/spawn-project",
      });
    expect(db.prepare("SELECT COUNT(*) AS count FROM console_sessions").get()).toEqual({ count: 0 });

    const claude = await router.invoke({
      ...input,
      body: {
        ...input.body,
        idempotency_key: "10000000-0000-4000-8000-000000000004",
        provider: "claude_code",
      },
    });
    expect(claude.status).toBe(202);
    expect(control.acquireNew).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "claude_code",
      cwd: "/work/spawn-project",
      runtime_options: { model: "claude-opus-5", permission_mode: "bypassPermissions" },
    }), expect.any(Function));

    failNext = true;
    const failed = await router.invoke({
      ...input,
      body: { ...input.body, idempotency_key: "10000000-0000-4000-8000-000000000002" },
    });
    expect(failed.status).toBe(202);
    await vi.waitFor(() => {
      const row = db.prepare("SELECT state, error_json FROM conversation_spawn_requests WHERE id = ?")
        .get("10000000-0000-4000-8000-000000000002") as { state: string; error_json: string };
      expect(row.state).toBe("failed");
      expect(JSON.parse(row.error_json)).toMatchObject({
        code: "provider_startup_failed",
        message: "The native conversation controller failed before readiness.",
        retryable: true,
      });
      expect(row.error_json).not.toContain("secret");
    });

    waitForCancellation = true;
    const starting = await router.invoke({
      ...input,
      body: { ...input.body, idempotency_key: "10000000-0000-4000-8000-000000000003" },
    });
    expect(starting.status).toBe(202);
    const cancelled = await router.invoke({
      method: "DELETE",
      url: "/api/conversation-spawns/10000000-0000-4000-8000-000000000003",
      body: { expected_generation: 1 },
      credential: token,
      transport: "http",
    });
    expect(cancelled.status).toBe(200);
    const abortedRow = db.prepare(
      "SELECT state, native_session_id, error_json FROM conversation_spawn_requests WHERE idempotency_key = ?",
    ).get("10000000-0000-4000-8000-000000000003") as { state: string; native_session_id: string | null; error_json: string | null };
    expect(abortedRow.state).toBe("cancelled");
    expect(abortedRow.native_session_id).toBeNull();
    expect(JSON.parse(abortedRow.error_json!)).toMatchObject({ code: "provider_startup_cancelled" });
  });

  it("denies preview provider sends even for a preview-created controller", async () => {
    const previewRoot = path.join(tempDir, "preview");
    fs.mkdirSync(previewRoot);
    const previewDb = path.join(previewRoot, "mandible.db");
    const sourceDb = path.join(tempDir, "source.db");
    fs.writeFileSync(previewDb, "preview");
    fs.writeFileSync(sourceDb, "source");
    const userPreferencesRoot = path.join(previewRoot, "settings", "users");
    fs.mkdirSync(userPreferencesRoot, { recursive: true });
    const instance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_INSTANCE_ID: "preview-permissions",
        MANDIBLE_INSTALLATION_ID: "test-installation",
        MANDIBLE_PUBLIC_ORIGIN: "https://preview-permissions.mandible.localhost:19421",
        MANDIBLE_BACKEND_GENERATION: "test-generation",
        MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(["ledger:read", "ledger:write", "files:preview"]),
        MANDIBLE_WRITABLE_ROOTS: JSON.stringify([previewRoot]),
        MANDIBLE_INSTANCE_DB_PATH_SOURCE: "iab-preview-copy",
        MANDIBLE_PREVIEW_ROOT: previewRoot,
        MANDIBLE_USER_PREFERENCES_DIR: userPreferencesRoot,
      },
      dbPath: previewDb,
      sourceDbPath: sourceDb,
    });
    const previewRouter = new Router({ clientAuth: authenticator, instance });
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const { token } = authenticator.mintApiToken(operator.id);
    const conversationId = "10000000-0000-4000-8000-000000000099";
    db.prepare(`INSERT INTO conversation_spawn_requests (
      id, schema_version, idempotency_key, request_digest, request_json, provider,
      project_id, checkout_id, topology_kind, state, attempt_count,
      native_session_id, provider_session_id, initial_message_state, created_at, updated_at
    ) VALUES (?, 'mandible-conversation-spawn-request@3', ?, ?, ?, 'codex',
      NULL, NULL, 'top-level', 'ready', 1, 'controller-1', 'provider-1', NULL, 1, 1)`)
      .run(conversationId, conversationId, "d".repeat(64), JSON.stringify({
        schema: "mandible-conversation-spawn-request@3",
        idempotency_key: conversationId,
        provider: "codex",
        placement: { kind: "projectless" },
      }));
    let owned = false;
    const control = {
      ownsController: vi.fn(async (_id: string, generation: number) => owned && generation === 1),
      submit: vi.fn(async () => ({ ok: true, value: { kind: "accepted", delivery_id: "delivery-1", turn_id: "turn-1", snapshot: {} } })),
      stop: vi.fn(async () => ({ ok: true, value: undefined })),
      getSnapshot: vi.fn(() => ({ ok: false, error: { kind: "conversation-not-found" } })),
      getLiveProjection: vi.fn(() => ({ ok: false, error: { kind: "conversation-not-found" } })),
    };
    registerConversationControlRoutes(previewRouter, control as never, { db, instance });
    const submit = (id = conversationId, generation = 1) => previewRouter.invoke({
      method: "POST",
      url: `/api/conversations/${id}/control/submit`,
      credential: token,
      transport: "http",
      body: {
        operation: "send",
        expected_revision: 2,
        expected_generation: generation,
        message: "hello",
        idempotency_key: "submission-1",
      },
    });

    expect(await submit()).toMatchObject({
      status: 403,
      body: { error: "effect_forbidden" },
    });
    owned = true;
    expect((await submit()).status).toBe(403);
    expect((await submit("copied-historical-chat")).status).toBe(403);
    expect((await submit(conversationId, 2)).status).toBe(403);
    expect((await previewRouter.invoke({
      method: "POST",
      url: `/api/conversations/${conversationId}/control/stop`,
      credential: token,
      transport: "http",
      body: { generation: 1 },
    })).status).toBe(403);
    expect(control.submit).not.toHaveBeenCalled();
    expect(control.stop).not.toHaveBeenCalled();
  });

  it("denies restricted issue, artifact, and work reads and restores them with read access", async () => {
    const project = addProject(db, { project_key: "read-guard", display_name: "Read Guard" });
    setProjectRestricted(db, project.id, true);
    const issue = new LedgerStore(db).createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.id,
      title: "Restricted issue",
      body: "secret issue body",
      aliases: [{ alias_kind: "git_bug_short", alias: "read123" }],
    });
    const artifact = ingestArtifact(db, {
      role: "report",
      media_type: "text/plain",
      content: "secret artifact bytes",
    }, 1000, tempDir);
    associateProjectArtifact(db, {
      project_ref: project.id,
      target_type: "artifact",
      target_id: artifact.id,
      source: "system",
    });
    const repo = {
      id: "read-repo",
      name: "Read Repo",
      root: path.join(tempDir, "read-repo"),
      exists: true,
      default_branch: "main",
      excluded: false,
      user_modified: false,
      last_scanned_at: null,
    };
    db.prepare(
      `INSERT INTO ledger_project_checkouts (
         id, project_id, root, name, work_repo_id, default_branch, remote_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'main', '', 1000, 1000)`,
    ).run("checkout-read-repo", project.id, repo.root, repo.name, repo.id);
    const workScanner = {
      getRepos: () => [repo],
      getRepoById: (id: string) => id === repo.id ? repo : undefined,
      refreshRepoAsync: vi.fn(async () => repo),
      getBranches: () => [],
      getWorktreeInventory: () => ({ known: true, worktrees: [] }),
      scanAllAsync: vi.fn(async () => ({ scanned_repos: 0 })),
    };
    registerProviderRoutes(router);
    registerWorkRoutes(router, workScanner as never);

    const agent = createUser(db, { slug: "read-agent", kind: "agent", display_name: "Read Agent" });
    const { token } = authenticator.mintApiToken(agent.id);
    const invoke = (url: string) => router.invoke({
      method: "GET",
      url,
      credential: token,
      transport: "http",
    });
    expect((await invoke(`/api/ledger/issues/${issue.id}`)).status).toBe(403);
    expect((await invoke(`/api/artifacts/${encodeURIComponent(artifact.id)}/content`)).status).toBe(403);
    expect((await invoke(`/api/work/repos/${repo.id}/audit`)).status).toBe(403);
    expect(workScanner.refreshRepoAsync).not.toHaveBeenCalled();

    addGrant(db, {
      subject_type: "user",
      subject: agent.id,
      resource_type: "project",
      resource: project.id,
      permission: "read",
    });
    expect((await invoke(`/api/ledger/issues/${issue.id}`)).status).toBe(200);
    expect((await invoke(`/api/artifacts/${encodeURIComponent(artifact.id)}/content`)).status).toBe(200);
    expect((await invoke(`/api/work/repos/${repo.id}/audit`)).status).toBe(200);
    expect(workScanner.refreshRepoAsync).toHaveBeenCalledOnce();
  });

  it("authorizes artifact content against the original pinned version ref", async () => {
    const project = addProject(db, { project_key: "version-project", display_name: "Version Project" });
    setProjectRestricted(db, project.id, true);
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed", provider_id: "permission-route-test", content: "pinned bytes\n",
      media_type: "text/plain", logical_name: "pinned-document",
    }, 1_000, tempDir);
    associateProjectArtifact(db, { project_ref: project.id, target_type: "artifact_version",
      target_id: recorded.version.id, source: "system" });
    registerProviderRoutes(router);
    const agent = createUser(db, { slug: "version-reader", kind: "agent", display_name: "Version Reader" });
    const { token } = authenticator.mintApiToken(agent.id);
    const invoke = () => router.invoke({
      method: "GET",
      url: `/api/artifacts/${encodeURIComponent(recorded.version.id)}/content`,
      credential: token,
      transport: "http",
    });
    expect((await invoke()).status).toBe(403);
    addGrant(db, {
      subject_type: "user", subject: agent.id, resource_type: "project",
      resource: project.id, permission: "read",
    });
    expect((await invoke()).status).toBe(200);
  });

  // Before the legacy artifact model was retired this gate read the deprecated
  // compatibility `version`/`artifact` records off the resolve result. For a
  // logical or series ref `version` was null and `artifact.id` was a
  // content-addressed compatibility id that `resolveArtifactProject` cannot
  // match, so the gate resolved `unassociated` and allowed every request. It
  // now reads the canonical logical artifact, which is the only id that reaches
  // artifact-level `project_artifact_associations` rows.
  it("denies logical and series refs whose artifact is associated to a restricted project", async () => {
    const project = addProject(db, { project_key: "ref-guard", display_name: "Ref Guard" });
    setProjectRestricted(db, project.id, true);
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed", provider_id: "permission-route-test", content: "restricted bytes\n",
      media_type: "text/plain", logical_name: "restricted-document",
    }, 1_000, tempDir);
    const logicalId = recorded.series.id.replace(/^artifact-series:/, "artifact:");
    associateProjectArtifact(db, {
      project_ref: project.id,
      target_type: "artifact",
      target_id: logicalId,
      source: "system",
    });
    registerProviderRoutes(router);
    const agent = createUser(db, { slug: "ref-reader", kind: "agent", display_name: "Ref Reader" });
    const { token } = authenticator.mintApiToken(agent.id);
    const resolve = (ref: string) => router.invoke({
      method: "GET",
      url: `/api/artifacts/resolve?ref=${encodeURIComponent(ref)}`,
      credential: token,
      transport: "http",
    });

    expect((await resolve(logicalId)).status).toBe(403);
    expect((await resolve(recorded.series.id)).status).toBe(403);
    expect((await resolve(recorded.version.id)).status).toBe(403);
    expect((await resolve(`artifact-blob:${recorded.artifact.content_hash}`)).status).toBe(403);
    expect((await resolve(`artifact:sha256:${recorded.artifact.content_hash}`)).status).toBe(403);

    addGrant(db, {
      subject_type: "user", subject: agent.id, resource_type: "project",
      resource: project.id, permission: "read",
    });
    const granted = await resolve(logicalId);
    expect(granted.status).toBe(200);
    const { resolution } = (granted.body as { resolution: ArtifactResolveResult });
    expect(resolution.logical_artifact?.id).toBe(logicalId);
    expect(resolution.artifact_version?.id).toBe(recorded.version.id);
    expect(resolution.series?.id).toBe(recorded.series.id);
    expect(resolution.version?.id).toBe(recorded.version.id);
    expect((await resolve(`artifact-blob:${recorded.artifact.content_hash}`)).status).toBe(200);
  });
});

async function runFileRpc(
  transport: FileRpcTransport,
  request: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  fs.mkdirSync(transport.dir, { recursive: true });
  const id = `permission-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(path.join(transport.dir, `${id}.request.json`), JSON.stringify({ id, ...request }));
  await transport.processOnce();
  return JSON.parse(fs.readFileSync(path.join(transport.dir, `${id}.response.json`), "utf8")) as {
    status: number;
    body: unknown;
  };
}
