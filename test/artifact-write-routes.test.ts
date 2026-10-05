import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, setDb, type Db } from "../src/db.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { registerBriefingRoutes } from "../src/routes/briefing.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { addGrant, setProjectRestricted } from "../src/permissions/store.js";
import { saveArtifactDraft, getArtifactDraft } from "../src/provider-artifacts.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { getArtifactCurrentSource } from "../src/artifact-source.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { STANDARD_PREVIEW_EFFECTS, validatePreviewWritableRoots } from "../src/security/effect-policy.js";
import { readArtifactBytesFull } from "../src/artifact-content.js";
import { registerProviderRoutes } from "../src/routes/providers.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import type { Router } from "../src/server.js";

let db: Db;
let previewDb: Db | null = null;
let originalArtifactDir: string | undefined;
let restoreArtifactDir = false;
let root: string;
let router: Router;
let agent: ReturnType<typeof createUser>;
let operator: ReturnType<typeof setupOperator>;
function snapshot(database: Db = db, cas = path.join(root, "cas")) {
  const state = Object.fromEntries(["artifact", "artifact_blob", "artifact_version", "artifact_source", "artifact_source_move"]
    .map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  state.custody_files = fs.existsSync(cas) ? fs.readdirSync(cas, { recursive: true }).sort() : [];
  return state;
}
function invoke(method: "GET" | "POST", url: string, body?: unknown) {
  return router.invoke({ method, url, body, transport: "http" });
}
function grant(project: string) {
  addGrant(db, { subject_type: "user", subject: agent.id, resource_type: "project", resource: project, permission: "write" });
}
beforeEach(() => {
  previewDb = null;
  restoreArtifactDir = false;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-write-"));
  db = new SqliteDatabase(path.join(root, "fixture.db")); migrate(db); setDb(db);
  setSetting(db, "artifact_root", path.join(root, "cas"));
  operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
  agent = createUser(db, { slug: "writer", kind: "agent", display_name: "Writer" });
  router = authenticatedTestRouter(agent); registerProviderRoutes(router);
});
afterEach(() => {
  setDb(db);
  previewDb?.close();
  previewDb = null;
  if (restoreArtifactDir) {
    if (originalArtifactDir === undefined) delete process.env.MANDIBLE_ARTIFACT_DIR;
    else process.env.MANDIBLE_ARTIFACT_DIR = originalArtifactDir;
  }
  originalArtifactDir = undefined;
  restoreArtifactDir = false;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("artifact write authorization", () => {
  it("writes inline artifact bytes only to copied preview storage", async () => {
    const sourceCas = path.join(root, "cas");
    const sourceFile = path.join(root, "external-source.md");
    fs.writeFileSync(sourceFile, "unchanged source bytes\n");
    const sourceArtifact = recordArtifactVersion(db, {
      source_kind: "managed", series_key: "source", content: "source artifact bytes", media_type: "text/plain",
    });
    const sourceState = snapshot(db, sourceCas);
    const sourceBytes = fs.readFileSync(sourceFile);
    const sourceDbPath = path.join(root, "source.db");
    await db.backup(sourceDbPath);
    const sourceDbBytes = fs.readFileSync(sourceDbPath);

    const previewRoot = path.join(root, "preview");
    const previewDbPath = path.join(previewRoot, "preview.db");
    const previewCas = path.join(previewRoot, "artifacts");
    const previewPreferences = path.join(previewRoot, "settings", "users");
    fs.mkdirSync(previewCas, { recursive: true });
    fs.mkdirSync(previewPreferences, { recursive: true });
    fs.copyFileSync(sourceDbPath, previewDbPath);
    const previewInstance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_INSTANCE_ID: "preview-0123456789abcdef",
        MANDIBLE_INSTALLATION_ID: "install_test",
        MANDIBLE_PUBLIC_ORIGIN: "https://preview-0123456789abcdef.mandible.localhost:19421",
        MANDIBLE_BACKEND_GENERATION: "preview-test",
        MANDIBLE_PREVIEW_ROOT: previewRoot,
        MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(STANDARD_PREVIEW_EFFECTS),
        MANDIBLE_ARTIFACT_DIR: previewCas,
        MANDIBLE_USER_PREFERENCES_DIR: previewPreferences,
        MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR: sourceCas,
      },
      dbPath: previewDbPath,
      sourceDbPath,
    });
    expect(() => validatePreviewWritableRoots(previewInstance)).not.toThrow();
    previewDb = new SqliteDatabase(previewDbPath);
    setSetting(previewDb, "artifact_root", previewCas);
    originalArtifactDir = process.env.MANDIBLE_ARTIFACT_DIR;
    restoreArtifactDir = true;
    process.env.MANDIBLE_ARTIFACT_DIR = previewCas;
    setDb(previewDb);
    router = authenticatedTestRouter(agent, { instance: previewInstance });
    registerProviderRoutes(router);

    expect((await invoke("POST", "/api/artifacts/ingest", {
      content: "preview bytes", media_type: "text/plain",
    })).status).toBe(200);
    const previewState = snapshot(previewDb, previewCas);
    expect((previewState.custody_files as string[]).length).toBeGreaterThan(0);
    for (const body of [
      { path: sourceFile },
      { content: "ambiguous bytes", path: sourceFile },
    ]) {
      expect((await invoke("POST", "/api/artifacts/ingest", body)).status).toBe(403);
      expect(snapshot(previewDb, previewCas)).toEqual(previewState);
    }

    expect(snapshot(db, sourceCas)).toEqual(sourceState);
    expect(readArtifactBytesFull(db, sourceArtifact.version.id)).toMatchObject({
      ok: true, bytes: Buffer.from("source artifact bytes"),
    });
    expect(fs.readFileSync(sourceFile)).toEqual(sourceBytes);
    expect(fs.readFileSync(sourceDbPath)).toEqual(sourceDbBytes);
    expect(snapshot(previewDb, previewCas)).not.toEqual(sourceState);
  });

  it("denies path, explicit identity, upload and legacy-key updates before any mutation", async () => {
    const project = addProject(db, { project_key: "owner", display_name: "Owner" });
    setProjectRestricted(db, project.id, true);
    const filename = path.join(root, "report.md"); fs.writeFileSync(filename, "original\n");
    const recorded = recordArtifactVersion(db, { source_kind: "local_only", path: filename });
    const id = recorded.series.id.replace(/^artifact-series:/, "artifact:");
    db.prepare("UPDATE artifact SET source_project_id=? WHERE id=?").run(project.id, id);
    fs.writeFileSync(filename, "changed\n");
    const before = snapshot();
    for (const [url, body] of [
      ["/api/artifacts/ingest", { path: filename, allow_local_only: true }],
      ["/api/artifacts/versions", { source_kind: "local_only", path: filename }],
      ["/api/artifacts/versions", { source_kind: "managed", artifact_id: id, content: "new bytes" }],
      ["/api/artifacts/versions", { source_kind: "managed", source: getArtifactCurrentSource(db, id)!.source, content: "uploaded" }],
      ["/api/artifacts/versions", { source_kind: "local_only", path: filename, series_key: recorded.series.series_key }],
    ] as const) {
      const response = await invoke("POST", url, body);
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(snapshot()).toEqual(before);
    }
    grant(project.id);
    expect((await invoke("POST", "/api/artifacts/versions", {
      source_kind: "managed", artifact_id: id, content: "authorized\n",
    })).status).toBe(200);
  });

  it("cannot bypass a registered repository's rights or identity by changing custody labels", async () => {
    const repo = path.join(root, "restricted-repo"); fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: repo, stdio: "pipe" });
    git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    const filename = path.join(repo, "report.md"); fs.writeFileSync(filename, "committed\n");
    git("add", "report.md"); git("commit", "-m", "fixture");
    const project = addProject(db, { project_key: "restricted-repo", display_name: "Restricted repo" });
    addOrUpdateCheckout(db, project.id, { root: fs.realpathSync(repo), work_repo_id: "restricted-repo" });
    setProjectRestricted(db, project.id, true);
    const inputs = [
      { source_kind: "tracked_repo", path: filename },
      { source_kind: "local_only", path: filename },
      { source_kind: "managed", path: filename, series_key: "attempted-custody-fork" },
    ];
    const before = snapshot();
    for (const body of inputs) {
      const response = await invoke("POST", "/api/artifacts/versions", body);
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(snapshot()).toEqual(before);
    }
    grant(project.id);
    const identities: string[] = [];
    for (const body of inputs) {
      const response = await invoke("POST", "/api/artifacts/versions", body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      identities.push((response.body as any).result.series.id);
    }
    expect(new Set(identities).size).toBe(1);
  });

  it("assigns a new uploaded repository source to its project and keeps reads restricted", async () => {
    const project = addProject(db, { project_key: "upload-owner", display_name: "Upload owner" });
    setProjectRestricted(db, project.id, true);
    const body = { source_kind: "managed", source: { kind: "repo", project_id: project.id, path: "uploaded.md" }, content: "private upload" };
    const before = snapshot();
    expect((await invoke("POST", "/api/artifacts/versions", body)).status).toBe(403);
    expect(snapshot()).toEqual(before);
    grant(project.id);
    const response = await invoke("POST", "/api/artifacts/versions", body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const id = (response.body as any).result.series.id.replace(/^artifact-series:/, "artifact:");
    expect(db.prepare("SELECT source_project_id FROM artifact WHERE id=?").get(id)).toEqual({ source_project_id: project.id });
    const reader = createUser(db, { slug: "upload-reader", kind: "agent", display_name: "Upload reader" });
    const readerRouter = authenticatedTestRouter(reader); registerProviderRoutes(readerRouter);
    const read = await readerRouter.invoke({ method: "GET", url: `/api/artifacts/${encodeURIComponent(id)}/content`, transport: "http" });
    expect(read.status).toBe(403);
  });

  it("requires owner, previous source and destination rights; preserves ownership and rejects stale moves", async () => {
    const projects = ["owner", "origin", "destination"].map(project_key => addProject(db, { project_key, display_name: project_key }));
    for (const project of projects) setProjectRestricted(db, project.id, true);
    const recorded = recordArtifactVersion(db, { source_kind: "managed", series_key: "move-test", content: "old\n" });
    const id = recorded.series.id.replace(/^artifact-series:/, "artifact:");
    db.prepare("UPDATE artifact SET source_project_id=? WHERE id=?").run(projects[0].id, id);
    const operatorRouter = authenticatedTestRouter(operator); registerProviderRoutes(operatorRouter);
    const initial = getArtifactCurrentSource(db, id)!;
    const origin = await operatorRouter.invoke({ method: "POST", url: "/api/artifacts/source/move", transport: "http",
      body: { artifact_id: id, expected_revision: initial.revision, source: { kind: "repo", project_id: projects[1].id, path: "old.md" } } });
    expect(origin.status, JSON.stringify(origin.body)).toBe(200);
    const body = { artifact_id: id, expected_revision: getArtifactCurrentSource(db, id)!.revision,
      project: "destination", path: "new.md" };
    for (const project of projects) {
      const before = snapshot();
      expect((await invoke("POST", "/api/artifacts/source/move", body)).status).toBe(403);
      expect(snapshot()).toEqual(before); grant(project.id);
    }
    expect((await invoke("POST", "/api/artifacts/source/move", body)).status).toBe(200);
    const moved = snapshot();
    expect((await invoke("POST", "/api/artifacts/source/move", body)).status).toBe(409);
    expect(snapshot()).toEqual(moved);
    expect(db.prepare("SELECT source_project_id FROM artifact WHERE id=?").get(id)).toEqual({ source_project_id: projects[0].id });
    expect(db.prepare("SELECT actor FROM artifact_source_move ORDER BY rowid DESC LIMIT 1").get()).toEqual({ actor: agent.id });
    const bytes = readArtifactBytesFull(db, recorded.version.id);
    expect(bytes.ok && bytes.bytes.toString()).toBe("old\n");
  });

  it("fails closed on resolution storage errors and invalid supplied projects", async () => {
    const recorded = recordArtifactVersion(db, { source_kind: "managed", series_key: "failure", content: "old\n" });
    const before = snapshot();
    expect((await invoke("POST", "/api/artifacts/versions", {
      source_kind: "managed", artifact_id: recorded.series.id.replace(/^artifact-series:/, "artifact:"), content: "new", project: "missing-project",
    })).status).toBe(404);
    expect(snapshot()).toEqual(before);
    db.exec("DROP TABLE project_artifact_associations");
    expect((await invoke("GET", `/api/artifacts/resolve?ref=${encodeURIComponent(recorded.series.id.replace(/^artifact-series:/, "artifact:"))}`)).status).toBe(500);
    expect((await invoke("POST", "/api/artifacts/versions", {
      source_kind: "managed", artifact_id: recorded.series.id.replace(/^artifact-series:/, "artifact:"), content: "new",
    })).status).toBe(500);
    expect(snapshot()).toEqual(before);
  });

  it("requires the moved source project before publishing a managed draft", async () => {
    const owner = addProject(db, { project_key: "draft-owner", display_name: "Draft owner" });
    const destination = addProject(db, { project_key: "draft-source", display_name: "Draft source" });
    setProjectRestricted(db, owner.id, true); setProjectRestricted(db, destination.id, true);
    const recorded = recordArtifactVersion(db, { source_kind: "managed", series_key: "draft-test", content: "old" });
    const id = recorded.series.id.replace(/^artifact-series:/, "artifact:");
    db.prepare("UPDATE artifact SET source_project_id=? WHERE id=?").run(owner.id, id);
    const operatorRouter = authenticatedTestRouter(operator); registerProviderRoutes(operatorRouter);
    expect((await operatorRouter.invoke({ method: "POST", url: "/api/artifacts/source/move", transport: "http", body: {
      artifact_id: id, expected_revision: getArtifactCurrentSource(db, id)!.revision,
      source: { kind: "repo", project_id: destination.id, path: "draft.md" },
    } })).status).toBe(200);
    saveArtifactDraft(db, { ref: id, base_version_id: recorded.version.id, content: "draft", media_type: "text/plain" });
    grant(owner.id);
    const before = snapshot(); const draft = getArtifactDraft(db, id);
    expect((await invoke("POST", "/api/artifacts/drafts/publish", { ref: id })).status).toBe(403);
    expect(snapshot()).toEqual(before); expect(getArtifactDraft(db, id)).toEqual(draft);
    grant(destination.id);
    const published = await invoke("POST", "/api/artifacts/drafts/publish", { ref: id });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(getArtifactDraft(db, id)).toBeNull();
  });

  it("requires deliberate guarded reconciliation of unresolved source state", async () => {
    const recorded = recordArtifactVersion(db, { source_kind: "managed", series_key: "unresolved", content: "retained" });
    const id = recorded.series.id.replace(/^artifact-series:/, "artifact:");
    db.prepare("UPDATE artifact_source SET source_json=NULL, reconciliation_reason='historical ambiguity' WHERE artifact_id=?").run(id);
    const before = snapshot();
    const body = { artifact_id: id, expected_revision: getArtifactCurrentSource(db, id)!.revision,
      source: { kind: "managed", key: "resolved-source" } };
    expect((await invoke("POST", "/api/artifacts/source/move", body)).status).toBe(409);
    expect(snapshot()).toEqual(before);
    expect((await invoke("POST", "/api/artifacts/source/move", { ...body, reconcile: true })).status).toBe(200);
    expect(getArtifactCurrentSource(db, id)?.reconciliation_reason).toBeNull();
    expect(readArtifactBytesFull(db, recorded.version.id).ok).toBe(true);
  });

  it("keeps explicit byte-only path ingress free of logical versions", async () => {
    const filename = path.join(root, "blob.md"); fs.writeFileSync(filename, "blob bytes");
    const before = snapshot();
    const result = await invoke("POST", "/api/artifacts/ingest", {
      path: filename, custody_mode: "managed", identity_mode: "blob_only",
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const after = snapshot();
    for (const table of ["artifact", "artifact_version", "artifact_source", "artifact_source_move"]) expect(after[table]).toEqual(before[table]);
    expect(after.artifact_blob).toHaveLength(1);
  });

  it("denies recurring publication before artifact, source, run or round mutation", async () => {
    const publisher = createUser(db, { slug: "agent-schedule", kind: "agent", display_name: "Scheduler" });
    router = authenticatedTestRouter(publisher); registerBriefingRoutes(router, db);
    const body = {
      schema: "mandible-briefing-run@1", briefing_key: "permission-report", title: "Report",
      task_identity: "agent-schedule/daily-digest", run_id: "first", run_key: "first",
      responder_user_ids: [operator.id],
      evidence: { series_ref: "artifact-series:digest", version: 1, digest: "a".repeat(64) },
      source_health: { source: "arxiv-scan", status: "healthy", detail: null, observed_at: 100 },
      document: { markdown: '# Report\n\n:::spec-item{key="paper" type="verdict" required="true"}\nKeep?\n:::\n' },
      quiet_reason: null,
      occurrences: [{ directive_key: "paper", evidence_digest: "b".repeat(64), occurred_at: 99, metadata: {} }],
    };
    const initial = await invoke("POST", "/api/briefings/runs", body);
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    const project = addProject(db, { project_key: "private-report", display_name: "Private report" });
    setProjectRestricted(db, project.id, true);
    db.prepare("UPDATE artifact SET source_project_id=?").run(project.id);
    const before = snapshot();
    const briefingBefore = ["briefings", "briefing_runs", "briefing_rounds"].map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const changed = { ...body, run_id: "second", run_key: "second", document: { markdown: body.document.markdown.replace("Keep?", "Changed?") } };
    expect((await invoke("POST", "/api/briefings/runs", changed)).status).toBe(403);
    expect(snapshot()).toEqual(before);
    expect(["briefings", "briefing_runs", "briefing_rounds"].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(briefingBefore);
    addGrant(db, { subject_type: "user", subject: publisher.id, resource_type: "project", resource: project.id, permission: "write" });
    expect((await invoke("POST", "/api/briefings/runs", changed)).status).toBe(200);
  });

  it("validates and authorizes every batch member before custody or metadata mutations", async () => {
    const first = path.join(root, 'first.md'), second = path.join(root, 'second.md');
    fs.writeFileSync(first, 'first'); fs.writeFileSync(second, 'second');
    const owned = recordArtifactVersion(db, { source_kind: 'local_only', path: second });
    const project = addProject(db, { project_key: 'batch-owner', display_name: 'Batch owner' });
    setProjectRestricted(db, project.id, true);
    db.prepare('UPDATE artifact SET source_project_id=? WHERE id=?').run(project.id, owned.series.id.replace('artifact-series:', 'artifact:'));
    fs.writeFileSync(second, 'changed');
    const before = snapshot();
    expect((await invoke('POST', '/api/artifacts/ingest', { paths: [first, second], custody_mode: 'managed' })).status).toBe(403);
    expect(snapshot()).toEqual(before);
    grant(project.id);
    for (const paths of [[first, path.join(root, 'missing.md')], [first, first]]) {
      expect((await invoke('POST', '/api/artifacts/ingest', { paths, custody_mode: 'managed' })).status).toBe(400);
      expect(snapshot()).toEqual(before);
    }
    const result = await invoke('POST', '/api/artifacts/ingest', { paths: [first, second], custody_mode: 'managed' });
    expect(result.status).toBe(200);
    expect((result.body as any).registered.map((r: any) => r.status)).toEqual(['created', 'updated']);
    const after = snapshot();
    const repeated = await invoke('POST', '/api/artifacts/ingest', { paths: [first, second], custody_mode: 'managed' });
    expect((repeated.body as any).registered.map((r: any) => r.status)).toEqual(['unchanged', 'unchanged']);
    expect(snapshot()).toEqual(after);
  });

  it("runs CLI ingest, guarded rename, old-path reuse and exact historical reads against the API", async () => {
    const requests: string[] = [];
    const cliInstance = resolveInstanceInfo({ env: {} });
    router = authenticatedTestRouter(agent, { instance: cliInstance });
    registerProviderRoutes(router);
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/instance") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ instance: cliInstance, operations: router.operationCatalog("test-candidate") }));
        return;
      }
      requests.push(`${req.method} ${req.url}`);
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        void router.invoke({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined, transport: "http" })
          .then(response => { res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response.body)); });
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const cli = (args: string[]) => new Promise<any>((resolve, reject) => {
      const child = spawn(path.join(process.cwd(), "bin/mandible"), ["artifact", ...args, "--json"], {
        cwd: root, env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${port}`,
          MANDIBLE_NO_KEYCHAIN_TOKEN: "1", MANDIBLE_TOKEN: "", MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", x => stdout += x); child.stderr.on("data", x => stderr += x);
      child.on("error", reject); child.on("close", code => {
        try { code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr + stdout)); }
        catch (error) { reject(error); }
      });
    });
    try {
      const oldPath = path.join(root, "old.md"), newPath = path.join(root, "new.md");
      fs.writeFileSync(oldPath, "original\n");
      const first = await cli(["ingest", oldPath, "--managed"]);
      const version = first.registered[0].version;
      const id = first.registered[0].series.id.replace(/^artifact-series:/, "artifact:");
      const uploaded = await cli(["ingest", oldPath, "--managed", "--upload"]);
      expect(uploaded.registered[0].series.id).toBe(first.registered[0].series.id);
      expect(uploaded.registered[0].version.commit_sha).toBeNull();
      fs.renameSync(oldPath, newPath);
      const moveStart = requests.length;
      const moved = await cli(['move', id, '--path', fs.realpathSync(newPath)]);
      expect(requests.slice(moveStart)).toEqual(['POST /api/artifacts/source/move']);
      const stableMove = snapshot();
      expect((await cli(['move', id, '--path', fs.realpathSync(newPath)])).status).toBe('unchanged');
      expect(snapshot()).toEqual(stableMove);
      await expect(cli(['move', id, '--path', oldPath, '--if-revision', String(moved.source.revision - 1)])).rejects.toThrow(/revision changed/);
      expect(snapshot()).toEqual(stableMove);
      fs.writeFileSync(newPath, "updated\n");
      const second = await cli(["ingest", newPath, "--managed", "--artifact", id]);
      expect(second.registered[0].series.id).toBe(first.registered[0].series.id);
      fs.writeFileSync(oldPath, "different document\n");
      const reused = await cli(["ingest", oldPath, "--managed"]);
      expect(reused.registered[0].series.id).not.toBe(first.registered[0].series.id);
      const bytes = readArtifactBytesFull(db, version.id);
      expect(bytes.ok && bytes.bytes.toString()).toBe("original\n");

      const repo = path.join(root, "tracked-repo"); fs.mkdirSync(repo);
      const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: repo, stdio: "pipe" });
      git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
      git("config", "commit.gpgsign", "false");
      const tracked = path.join(repo, "tracked.md"); fs.writeFileSync(tracked, "committed\n");
      fs.writeFileSync(path.join(repo, "forgotten.md"), "historical only\n");
      git("add", "tracked.md", "forgotten.md"); git("commit", "-m", "fixture");
      const project = addProject(db, { project_key: "tracked-repo", display_name: "Tracked repo" });
      addOrUpdateCheckout(db, project.id, { root: fs.realpathSync(repo), work_repo_id: "tracked-repo" });
      const linked = await cli(["ingest", tracked]);
      const trackedId = linked.registered[0].series.id.replace(/^artifact-series:/, "artifact:");
      const copied = await cli(["ingest", tracked, "--managed"]);
      expect(copied.registered[0].series.id).toBe(linked.registered[0].series.id);
      expect(copied.registered[0].version.custody_mode).toBe("managed");
      expect(getArtifactCurrentSource(db, trackedId)?.source).toEqual({ kind: "repo", project_id: project.id, path: "tracked.md" });
      fs.writeFileSync(tracked, "dirty\n");
      const dirty = await cli(["ingest", tracked, "--managed"]);
      expect(dirty.registered[0].series.id).toBe(linked.registered[0].series.id);
      expect(dirty.registered[0].version.commit_sha).toBeNull();
      const historical = readArtifactBytesFull(db, linked.registered[0].version.id);
      expect(historical.ok && historical.bytes.toString()).toBe("committed\n");
      fs.writeFileSync(tracked, 'committed\n');
      const commit = git('rev-parse', 'HEAD').toString().trim();
      git('mv', 'tracked.md', 'renamed.md'); git('rm', 'forgotten.md'); git('commit', '-m', 'rename');
      await cli(['move', trackedId, '--path', 'renamed.md']);
      const sourceBeforeHistory = getArtifactCurrentSource(db, trackedId);
      const historyStart = requests.length, started = performance.now();
      const imported = await cli(['ingest', 'tracked.md', 'forgotten.md', '--project', 'Tracked repo', '--commit', commit]);
      expect(imported.registered[0].version.id).toBe(linked.registered[0].version.id);
      expect(imported.registered[0].status).toBe('unchanged');
      expect(imported.registered[1].status).toBe('created');
      expect(readArtifactBytesFull(db, imported.registered[1].version.id)).toMatchObject({ ok: true, bytes: Buffer.from('historical only\n') });
      expect(requests.slice(historyStart)).toEqual(['POST /api/artifacts/ingest']);
      console.log(`historical CLI: ${Math.round(performance.now() - started)}ms, 1 request`);
      expect(getArtifactCurrentSource(db, trackedId)).toEqual(sourceBeforeHistory);
      fs.writeFileSync(tracked, 'reused path'); git('add', 'tracked.md'); git('commit', '-m', 'reuse');
      const reusedTracked = await cli(['ingest', tracked]);
      const reuseId = reusedTracked.registered[0].series.id.replace('artifact-series:', 'artifact:');
      const ambiguousBefore = snapshot();
      await expect(cli(['ingest', 'tracked.md', '--project', 'tracked-repo', '--commit', commit])).rejects.toThrow(/multiple artifacts/);
      expect(snapshot()).toEqual(ambiguousBefore);
      const selected = await cli(['ingest', 'tracked.md', '--project', 'tracked-repo', '--commit', commit, '--artifact', trackedId]);
      expect(selected.registered[0].version.id).toBe(linked.registered[0].version.id);
      await expect(cli(['ingest', 'tracked.md', '--project', 'tracked-repo', '--commit', commit, '--artifact', id])).rejects.toThrow(/no source lineage/);
      expect(snapshot()).toEqual(ambiguousBefore);
      await expect(cli(['move', trackedId, '--path', 'tracked.md'])).rejects.toThrow(/already belongs/);
      expect(snapshot()).toEqual(ambiguousBefore);
      const other = addProject(db, { project_key: 'other', display_name: 'Other project' });
      const projectOnly = await cli(['move', trackedId, '--project', 'Other project']);
      expect(projectOnly.source.source).toEqual({ kind: 'repo', project_id: other.id, path: 'renamed.md' });
      setProjectRestricted(db, other.id, true);
      const deniedHistory = snapshot();
      await expect(cli(['ingest', 'tracked.md', '--project', 'tracked-repo', '--commit', commit, '--artifact', trackedId, '--managed'])).rejects.toThrow(/403/);
      expect(snapshot()).toEqual(deniedHistory);
      grant(other.id);
      const both = await cli(['move', trackedId, '--project', 'tracked-repo', '--path', 'final.md']);
      expect(both.source.source).toEqual({ kind: 'repo', project_id: project.id, path: 'final.md' });
      expect(db.prepare('SELECT source_project_id FROM artifact WHERE id=?').get(trackedId)).toEqual({ source_project_id: project.id });
      const transportStart = requests.length;
      const uploadedBatch = await cli(['ingest', oldPath, newPath, '--managed', '--upload']);
      expect(uploadedBatch.registered).toHaveLength(2);
      expect(uploadedBatch.failed).toEqual([]);
      expect(requests.slice(transportStart)).toEqual(['POST /api/artifacts/versions', 'POST /api/artifacts/versions']);
      expect(uploadedBatch.atomic).toBeUndefined();
      const unsupportedStart = requests.length;
      await expect(cli(['ingest', oldPath, '--commit', commit, '--managed', '--upload'])).rejects.toThrow(/requires daemon-visible repository paths/);
      expect(requests).toHaveLength(unsupportedStart);
      const batchStart = requests.length, batchTime = performance.now();
      const batch = await cli(['ingest', oldPath, newPath, '--managed']);
      expect(batch.registered).toHaveLength(2);
      expect(requests.slice(batchStart)).toEqual(['POST /api/artifacts/ingest']);
      console.log(`two-path CLI: ${Math.round(performance.now() - batchTime)}ms, 1 request`);
      expect(reuseId).not.toBe(trackedId);

    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 20_000);
});
