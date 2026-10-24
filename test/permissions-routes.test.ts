import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntilPasses } from "./helpers/wait-until.js";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { setDb, type Db } from "../src/db.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { systemAction } from "../src/identity/resolver.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { addGrant, setProjectRestricted } from "../src/permissions/store.js";
import { associateProjectArtifact, ingestArtifact } from "../src/provider-artifacts.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { DEFAULT_MANAGED_CHAT_OPTIONS } from "../src/managed-chat-defaults.js";
import { USER_SETTING_KEYS } from "../src/contracts.js";
import { writeUserSetting } from "../src/user-settings.js";
import { registerConsoleRoutes } from "../src/routes/console.js";
import { registerConversationSpawnRoutes } from "../src/routes/conversation-spawn.js";
import { ConversationControlService } from "../src/conversation-control/service.js";
import { CLAUDE_SDK_MANAGED_PROFILE } from "../src/conversation-control/provider-capabilities.js";
import { registerConversationControlRoutes } from "../src/routes/conversation-control.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerSpacesRoutes } from "../src/routes/spaces.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import { registerWorkRoutes } from "../src/routes/work.js";
import { Router } from "../src/server.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import type { ArtifactResolveResult } from "../src/types.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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
    db = migratedMemoryDb();
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

  it("checks canonical project read access before resolving approval references", async () => {
    registerSpacesRoutes(router);
    const project = addProject(db, { project_key: "auth-restricted", display_name: "Restricted approvals" });
    setProjectRestricted(db, project.id, true);
    const agent = createUser(db, { slug: "approval-reader", kind: "agent", display_name: "Approval Reader" });
    const { token } = authenticator.mintApiToken(agent.id);
    const id = "2257522a-39a2-467b-b3f8-491aea66754c";
    db.prepare(`INSERT INTO auth_requests (id, command, title, repo, created_at, updated_at, expires_at)
      VALUES (?, 'true', 'Private approval title', ?, 1, 1, 9999999999999)`).run(id, project.project_key);
    const resolve = (ref: string) => router.invoke({ method: "GET", url: `/api/refs/resolve?ref=${encodeURIComponent(ref)}`, credential: token, transport: "http" });
    for (const ref of [`auth:${id}`, "auth:2257522a", `mandible:///auth?request=${id}`]) {
      const denied = await resolve(ref);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain("Private approval title");
    }
    addGrant(db, { subject_type: "user", subject: agent.id, resource_type: "project", resource: project.id, permission: "read" });
    const allowed = await resolve("auth:2257522a");
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ resolution: { kind: "auth", resolved: true, entity: { id: "2257522a", title: "Private approval title" } } });
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
      runtime_options: { model: "gpt-5.6-sol", effort: "medium", permission_mode: "agent-full-access" },
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
      runtime_options: { model: "claude-opus-5-5", effort: "medium", permission_mode: "bypassPermissions" },
    }), expect.any(Function));

    const chosen = { ...structuredClone(DEFAULT_MANAGED_CHAT_OPTIONS), codex: { model: "gpt-5.6-sol", effort: "high", permission_mode: "read-only" } };
    writeUserSetting(db, agent.id, USER_SETTING_KEYS.managedChatDefaults, JSON.stringify(chosen));
    failNext = true;
    const failed = await router.invoke({
      ...input,
      body: { ...input.body, idempotency_key: "10000000-0000-4000-8000-000000000002" },
    });
    expect(failed.status).toBe(202);
    await waitUntilPasses(() => {
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

    writeUserSetting(db, agent.id, USER_SETTING_KEYS.managedChatDefaults, JSON.stringify(DEFAULT_MANAGED_CHAT_OPTIONS));
    const retried = await router.invoke({
      method: "POST", url: "/api/conversation-spawns/10000000-0000-4000-8000-000000000002/retry",
      body: { expected_generation: 1 }, credential: token, transport: "http",
    });
    expect(retried.status).toBe(202);
    expect(control.acquireNew).toHaveBeenLastCalledWith(expect.objectContaining({ runtime_options: chosen.codex }), expect.any(Function));
    expect(retried.body).toMatchObject({ spawn: { runtime_options: chosen.codex } });

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
    db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, model, created_at, updated_at)
      VALUES (?, 'claude_code', '/tmp/copied-transcript.jsonl', 'hash', 1, 'Copied chat',
      '2026-01-01T00:00:00Z', 0, 'provider-1', 'stored-provider-model', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(conversationId);
    const descriptorService = new ConversationControlService(db);
    const discover = vi.fn(async () => ({ ok: false as const, error: {
      kind: 'adapter-failure' as const, adapter_id: 'copied-controller', code: 'discovery-failed', message: 'Discovery failed', retryable: false,
    } }));
    descriptorService.registerAdapter({ id: 'copied-controller', provider: 'claude_code', capabilities: CLAUDE_SDK_MANAGED_PROFILE.capabilities,
      subscribe: () => () => {}, subscribeProviderEvents: () => () => {}, modelChoices: discover } as never);
    vi.spyOn(descriptorService, 'getSnapshot').mockReturnValue({ ok: true, value: {
      provider: 'claude_code', ownership: { kind: 'mandible', adapter_id: 'copied-controller', generation: 1 }, controller: { kind: 'running' },
    } } as never);
    const controlsWithDescriptors = { ...control, runOptions: descriptorService.runOptions.bind(descriptorService) };
    registerConversationControlRoutes(previewRouter, controlsWithDescriptors as never, { db, instance });
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

    const descriptorRead = await previewRouter.invoke({ method: 'GET', url: `/api/conversations/${conversationId}/control/options`, credential: token, transport: 'http' });
    expect(descriptorRead).toMatchObject({ status: 200, body: { ok: true, value: [
      { id: 'model', choices: expect.arrayContaining([{ value: 'stored-provider-model', label: 'stored-provider-model' }]) },
      { id: 'effort' }, { id: 'permission_mode' },
    ] } });
    expect(discover).not.toHaveBeenCalled();
    expect(instance.allowed_effects).not.toContain('provider:send');
    expect(await descriptorService.runOptions(conversationId, { discoverModels: true })).toMatchObject({ ok: false, error: { code: 'discovery-failed' } });
    expect(discover).toHaveBeenCalledOnce();
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
      getRepoScan: vi.fn(async () => ({ repo, inventory: { known: true, worktrees: [] } })),
      getBranches: () => [],
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
    expect(workScanner.getRepoScan).not.toHaveBeenCalled();

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
    expect(workScanner.getRepoScan).toHaveBeenCalledOnce();
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
