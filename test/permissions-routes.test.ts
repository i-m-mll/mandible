import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { systemAction } from "../src/identity/resolver.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { addGrant, setProjectRestricted } from "../src/permissions/store.js";
import { associateProjectArtifact, ingestArtifact, recordArtifactVersion } from "../src/provider-artifacts.js";
import { registerConsoleRoutes } from "../src/routes/console.js";
import { registerIssueRoutes } from "../src/routes/issues.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import { registerWorkRoutes } from "../src/routes/work.js";
import { Router } from "../src/server.js";
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
    db = new Database(":memory:");
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
      body: { project: project.id, title, body: "Body" },
      credential: token,
    } as const);

    expect((await router.invoke({ ...request("HTTP denied"), transport: "http" })).status).toBe(403);
    const rpc = new FileRpcTransport({ router, dir: path.join(tempDir, "rpc") });
    expect((await runFileRpc(rpc, {
      method: "POST",
      path: "/api/issues/anything",
      body: { project: project.id, title: "RPC denied", body: "Body" },
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
      body: { project: project.id, title: "RPC granted", body: "Body" },
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

  it("denies agent console spawn until spawn_console is granted", async () => {
    const agent = createUser(db, { slug: "console-agent", kind: "agent", display_name: "Console Agent" });
    const { token } = authenticator.mintApiToken(agent.id);
    const manager = {
      create: vi.fn(() => ({ id: "console-1" })),
      start: vi.fn(),
      get: vi.fn(() => ({ meta: { id: "console-1" } })),
      waitForInitialRunOptions: vi.fn(async () => ({
        backendType: "spawn",
        command: "bash",
        phase: "declared",
        revision: 0,
        options: [],
      })),
    };
    registerConsoleRoutes(router, manager as never);
    const input = {
      method: "POST",
      url: "/api/console/sessions",
      body: { label: "Agent", command: "bash" },
      credential: token,
      transport: "http" as const,
    };
    expect((await router.invoke(input)).status).toBe(403);
    expect(manager.create).not.toHaveBeenCalled();
    addGrant(db, {
      subject_type: "user",
      subject: agent.id,
      resource_type: "global",
      permission: "spawn_console",
    });
    expect((await router.invoke(input)).status).toBe(201);
    expect(manager.create).toHaveBeenCalledOnce();
    expect(manager.waitForInitialRunOptions).toHaveBeenCalledWith("console-1");
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
    db.prepare("UPDATE artifact_version SET source_project_id = ? WHERE id = ?")
      .run(project.id, recorded.version.id);
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

    addGrant(db, {
      subject_type: "user", subject: agent.id, resource_type: "project",
      resource: project.id, permission: "read",
    });
    const granted = await resolve(logicalId);
    expect(granted.status).toBe(200);
    const { resolution } = (granted.body as { resolution: ArtifactResolveResult });
    expect(resolution.logical_artifact?.id).toBe(logicalId);
    expect(resolution.series?.id).toBe(recorded.series.id);
    expect(resolution.version?.id).toBe(recorded.version.id);
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
