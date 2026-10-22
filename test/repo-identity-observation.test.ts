// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW, approveFixtureRequest, awaitFixtureResolution, commitOnBranch, createAuthCheckRepo, createMigratedDb, createLedgerProject, createLedgerIssue, createNoopHookManager, insertWorkUnit, publishFixtureExecution, registerWorkRepo, git } from "./helpers/auth-queue-fixtures.js";
import { canonicalRepoKeyForPath, clearRepoIdentityCache, observeRepoIdentities } from "../src/repo-identity.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { setDb } from "../src/db.js";
import { WorkUnitReconciler } from "../src/work-unit-reconciler.js";
import { AuthQueue } from "../src/auth-queue.js";
import { registerWorkUnitRoutes } from "../src/routes/work-units.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { addAttributionEvidence, addCredential, createUser, getAttributionEvidence, getOperator } from "../src/users/store.js";
import { addOrUpdateCheckout } from "../src/ledger/project-registry.js";

vi.setConfig({ testTimeout: 5000 });

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { identityChildren } = await import("./helpers/git-identity-barrier.js");
  return identityChildren.instrument(actual);
});
import { identityChildren as observation, holdIdentity } from "./helpers/git-identity-barrier.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function responsiveCheckpoint() {
  const server = http.createServer((_request, response) => response.end("responsive"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    expect(await response.text()).toBe("responsive");
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function stagedExecutions(paths: string[]) {
  const db = createMigratedDb();
  const started: string[] = [];
  const running = new Set<string>();
  const runningAtStart = new Map<string, string[]>();
  const signals = new Map<string, { entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier> }>();
  const queue = new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager(), executor: async options => {
    started.push(options.request_id);
    runningAtStart.set(options.request_id, [...running]);
    running.add(options.request_id);
    signals.get(options.request_id)!.entered.resolve();
    await signals.get(options.request_id)!.release.promise;
    running.delete(options.request_id);
    return { exit_code: 1, signal: null, stdout: "", stderr: "Stopped private fixture", output: "", started_at: Date.now(), finished_at: Date.now() };
  } });
  const admit = (queue as any).executeInBackground.bind(queue) as (request: any) => Promise<void>;
  // Retain genuine signed executing rows, then exercise their real admission together.
  const stage = vi.spyOn(queue as any, "executeInBackground").mockResolvedValue(undefined);
  const requests = [];
  try {
    for (const [index, cwd] of paths.entries()) {
      const request = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", command: `private fixture ${index}`, title: `Private admission ${index}`, cwd });
      signals.set(request.id, { entered: barrier(), release: barrier() });
      await approveFixtureRequest(queue, request.id);
      requests.push(queue.getRequestExact(request.id)!);
    }
  } catch (error) { await queue.dispose(); db.close(); throw error; }
  finally { stage.mockRestore(); }
  return { db, queue, requests, admit, started, runningAtStart, signals,
    async close() { signals.forEach(signal => signal.release.resolve()); await queue.dispose(); db.close(); } };
}

afterEach(() => { observation.reset(); clearRepoIdentityCache(); vi.restoreAllMocks(); });

it.each(["cold", "expired", "new alias", "transient failure"])("keeps a timer and HTTP read responsive during %s real Git identity observation", async mode => {
  clearRepoIdentityCache();
  const repo = createAuthCheckRepo();
  const canonical = fs.realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  let input = repo;
  if (mode !== "cold") await canonicalRepoKeyForPath(repo);
  if (mode === "new alias") { input = path.join(testRuntimeRoot, "new-identity-alias"); fs.symlinkSync(repo, input); }
  if (mode === "expired" || mode === "transient failure") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
  if (mode === "transient failure") fs.renameSync(path.join(repo, ".git"), path.join(repo, ".git-held"));
  const server = http.createServer((_request, response) => response.end("responsive"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const hold = holdIdentity();
  observation.synchronous = 0;
  observation.trace = true;
  let settled = false;
  const pending = canonicalRepoKeyForPath(input);
  void pending.then(() => { settled = true; });
  try {
    await hold.reached(pending);
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    expect(await response.text()).toBe("responsive");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(observation.synchronous).toBe(0);
    hold.release();
    await expect(pending).resolves.toBe(canonical);
  } finally {
    observation.trace = false;
    hold.release();
    await pending;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (mode === "transient failure") fs.renameSync(path.join(repo, ".git-held"), path.join(repo, ".git"));
  }
});

it("keeps the first cold merge submission responsive through real identity observation", async () => {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  registerWorkRepo(db, repo);
  createLedgerProject(db, repo);
  commitOnBranch(repo, "feature/cold", { "cold.txt": "cold submission\n" });
  const head = git(repo, ["rev-parse", "feature/cold"]);
  const queue = new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager() });
  clearRepoIdentityCache();
  const hold = holdIdentity(fs.realpathSync(repo));
  observation.synchronous = 0;
  observation.trace = true;
  const pending = queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: "Cold submission", command: "mandible auth merge feature/cold --into main",
    repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/cold", merge_head_sha: head });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await hold.reached(pending);
    await responsiveCheckpoint();
    expect(settled).toBe(false);
    expect(observation.synchronous).toBe(0);
    observation.trace = false;
    hold.release();
    await expect(pending).resolves.toMatchObject({ status: "pending" });
  } finally { observation.trace = false; hold.release(); await pending.catch(() => undefined); await queue.dispose(); db.close(); }
});

it.each(["custody", "registry", "continuation"])("binds original submission authority across cold identity observation: %s", async change => {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  setDb(db);
  registerWorkRepo(db, repo);
  const project = createLedgerProject(db, repo).project;
  const otherProject = createLedgerProject(db, createAuthCheckRepo()).project;
  const issue = createLedgerIssue(db, project.id, "c01d123", "Private cold submission");
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, { type: "api_token", fingerprint: `submit-owner-${change}` });
  const branch = "feature/authority";
  commitOnBranch(repo, branch, { "authority.txt": "reviewed authority\n" });
  db.prepare(`INSERT INTO work_units (id,issue_id,ledger_issue_id,repo_id,branch,kind,state,created_at,owner_user_id,owner_credential_id,custody_generation)
    VALUES ('submission-unit','c01d123',?,?,?,'solo','committed',0,?,?,1)`)
    .run(issue.id, project.project_key, branch, operator.id, credential.id);
  const router = authenticatedTestRouter(operator, { credentialId: credential.id });
  registerWorkUnitRoutes(router, {} as never);
  const queue = new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager() });
  const head = git(repo, ["rev-parse", branch]);
  const beforePins = git(repo, ["for-each-ref", "--format=%(refname)", "refs/mandible/auth-candidates/"]);
  clearRepoIdentityCache();
  const hold = holdIdentity(repo);
  const pending = queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: "Original delivery authority", command: `mandible auth merge ${branch} --into main`,
    repo: project.project_key, cwd: repo, base_branch: "main", head_branch: branch, merge_head_sha: head,
    require_delivery_custody: true, issue_references: [issue.id], requester_evidence_method: "api_token", requester_credential_id: credential.id,
  }, operator.id);
  void pending.catch(() => undefined);
  try {
    await hold.reached(pending);
    if (change === "registry") addOrUpdateCheckout(db, otherProject.id, { root: repo, name: "Explicit reassociation", default_branch: "main" });
    else {
      const response = await router.invoke({ method: "PATCH", url: "/api/work-units/submission-unit", body: {
        expected_generation: 1, ...(change === "custody" ? { state: "abandoned" } : { continuation: "Continue the same authority" }),
      } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    hold.release();
    if (change === "continuation") {
      const request = await pending;
      expect(request.status).toBe("pending");
      expect(db.prepare("SELECT auth_request_id,continuation FROM work_units WHERE id = 'submission-unit'").get())
        .toEqual({ auth_request_id: request.id, continuation: "Continue the same authority" });
    } else {
      await expect(pending).rejects.toMatchObject({ code: change === "custody" ? "custody_conflict" : "lifecycle_conflict" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_requests").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT auth_request_id FROM work_units WHERE id = 'submission-unit'").get()).toEqual({ auth_request_id: null });
      expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/mandible/auth-candidates/"])).toBe(beforePins);
    }
  } finally { hold.release(); await pending.catch(() => undefined); await queue.dispose(); db.close(); }
});

it.each(["continuation", "authority"])("validates bound custody at cold admission and accepts its owned resolution successor: %s", async change => {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  setDb(db);
  registerWorkRepo(db, repo);
  const project = createLedgerProject(db, repo).project;
  const issue = createLedgerIssue(db, project.id, "c0570d2", "Private owned successor");
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, { type: "api_token", fingerprint: `bound-owner-${change}` });
  const branch = "feature/bound-custody";
  commitOnBranch(repo, branch, { "custody.txt": "reviewed custody\n" });
  db.prepare(`INSERT INTO work_units (id,issue_id,ledger_issue_id,repo_id,branch,kind,state,created_at,owner_user_id,owner_credential_id,custody_generation)
    VALUES ('bound-unit','c0570d2',?,?,?,'solo','committed',0,?,?,1)`)
    .run(issue.id, project.project_key, branch, operator.id, credential.id);
  const router = authenticatedTestRouter(operator, { credentialId: credential.id });
  registerWorkUnitRoutes(router, {} as never);
  const enteredExecutor = barrier();
  const releaseExecutor = barrier();
  const admissionEntered = barrier();
  let hold: ReturnType<typeof holdIdentity> | undefined;
  let executions = 0;
  let resolvedState: string | undefined;
  let resolutions = 0;
  const queue = new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager(),
    broadcast: event => {
      if (event.event === "auth:resolved") {
        resolutions++;
        resolvedState = (db.prepare("SELECT state FROM work_units WHERE id = 'bound-unit'").get() as { state: string }).state;
      }
    },
    executor: async options => { executions++; enteredExecutor.resolve(); await releaseExecutor.promise; return publishFixtureExecution(queue, options); },
  });
  const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: "Owned custody transition", command: `mandible auth merge ${branch} --into main`,
    repo: project.project_key, cwd: repo, base_branch: "main", head_branch: branch, merge_head_sha: git(repo, ["rev-parse", branch]),
    require_delivery_custody: true, issue_references: [issue.id], requester_evidence_method: "api_token", requester_credential_id: credential.id,
  }, operator.id);
  const actualAdmission = (queue as any).executeInBackground.bind(queue);
  const spy = vi.spyOn(queue as any, "executeInBackground").mockImplementation((...args: any[]) => {
    clearRepoIdentityCache();
    hold = holdIdentity(repo);
    admissionEntered.resolve();
    return actualAdmission(...args);
  });
  const approval = approveFixtureRequest(queue, request.id);
  void approval.catch(() => undefined);
  try {
    await Promise.race([admissionEntered.promise, approval.then(() => { throw new Error("Approval completed before admission"); })]);
    await hold!.reached(approval);
    if (change === "continuation") {
      const response = await router.invoke({ method: "PATCH", url: "/api/work-units/bound-unit", body: { continuation: "Continue without changing authority" } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    } else {
      const replacement = addCredential(db, operator.id, { type: "api_token", fingerprint: "replacement-bound-owner" });
      // Storage adversary isolates a credential change without a generation increment.
      db.prepare("UPDATE work_units SET owner_credential_id = ? WHERE id = 'bound-unit'").run(replacement.id);
    }
    hold!.release();
    if (change === "authority") {
      await expect(approval).rejects.toMatchObject({ code: "lifecycle_conflict" });
      expect(executions).toBe(0);
      expect(resolutions).toBe(0);
      expect(queue.getRequestExact(request.id)).toMatchObject({ status: "executing", exit_code: null });
    } else {
      await approval;
      await enteredExecutor.promise;
      const runner = (queue as any).inFlight.get(request.id) as Promise<void>;
      releaseExecutor.resolve();
      await runner;
      expect(queue.getRequestExact(request.id)).toMatchObject({ status: "completed", exit_code: 0 });
      expect(resolutions).toBe(1);
      expect(resolvedState).toBe("resolved");
    }
  } finally { spy.mockRestore(); hold?.release(); releaseExecutor.resolve(); await approval.catch(() => undefined); await queue.dispose(); db.close(); }
});

it("keeps cold execution admission responsive and reserves duplicate admission before awaiting identity", async () => {
  const f = await stagedExecutions([createAuthCheckRepo()]);
  clearRepoIdentityCache();
  const request = f.requests[0]!;
  const hold = holdIdentity(request.target_repo_root ?? request.cwd!);
  const pending = f.admit(request);
  try {
    await hold.reached(pending);
    expect((f.queue as any).inFlight.has(request.id)).toBe(true);
    await f.admit(request);
    await responsiveCheckpoint();
    expect(f.started).toEqual([]);
    hold.release();
    await pending;
    await f.signals.get(request.id)!.entered.promise;
    expect(f.started).toEqual([request.id]);
  } finally { hold.release(); await pending.catch(() => undefined); await f.close(); }
});

it("preserves alias invocation order when identity answers reverse, while another repository executes concurrently", async () => {
  const repo = createAuthCheckRepo();
  const alias = path.join(testRuntimeRoot, "reverse-admission-alias");
  fs.symlinkSync(repo, alias);
  const f = await stagedExecutions([repo, alias, createAuthCheckRepo()]);
  clearRepoIdentityCache();
  const holds = f.requests.map(request => holdIdentity({ exactPath: request.target_repo_root ?? request.cwd! }));
  const admissions = f.requests.map(request => f.admit(request));
  try {
    await Promise.all(holds.map((hold, index) => hold.reached(admissions[index]!)));
    holds[1]!.release(); holds[2]!.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.started).toEqual([]);
    holds[0]!.release();
    await Promise.all(admissions);
    const [first, second, distinct] = f.requests;
    await Promise.all([f.signals.get(first!.id)!.entered.promise, f.signals.get(distinct!.id)!.entered.promise]);
    expect(new Set(f.started)).toEqual(new Set([first!.id, distinct!.id]));
    expect(f.runningAtStart.get(distinct!.id)?.includes(first!.id) || f.runningAtStart.get(first!.id)?.includes(distinct!.id)).toBe(true);
    f.signals.get(first!.id)!.release.resolve();
    await f.signals.get(second!.id)!.entered.promise;
    expect(f.started.indexOf(first!.id)).toBeLessThan(f.started.indexOf(second!.id));
    expect(f.started).toHaveLength(3);
    expect(f.runningAtStart.get(second!.id)).not.toContain(first!.id);
  } finally { holds.forEach(hold => hold.release()); await Promise.allSettled(admissions); await f.close(); }
});

it.each(["dispose", "revise"])("rejects a pending identity admission after its owner must %s", async scenario => {
  const f = await stagedExecutions([createAuthCheckRepo()]);
  clearRepoIdentityCache();
  const request = f.requests[0]!;
  const hold = holdIdentity(request.target_repo_root ?? request.cwd!);
  const pending = f.admit(request);
  void pending.catch(() => undefined);
  let stopped: Promise<void> | undefined;
  try {
    await hold.reached(pending);
    if (scenario === "dispose") {
      let settled = false;
      stopped = f.queue.dispose().then(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } else {
      await f.queue.setResult(request.id, 1, "Explicit private cancellation");
    }
    hold.release();
    await expect(pending).rejects.toBeDefined();
    await stopped;
    expect(f.started).toEqual([]);
    expect((f.queue as any).inFlight.size).toBe(0);
    expect((f.queue as any).queuedAdmissions.size).toBe(0);
  } finally { hold.release(); await pending.catch(() => undefined); await stopped; await f.close(); }
});

it("shares a pending child without letting one canceled consumer cancel another", async () => {
  clearRepoIdentityCache();
  const repo = createAuthCheckRepo();
  const hold = holdIdentity();
  const controller = new AbortController();
  const first = canonicalRepoKeyForPath(repo, controller.signal);
  const second = canonicalRepoKeyForPath(repo);
  void first.catch(() => undefined);
  try {
    await hold.reached(first);
    const cancellation = new Error("Caller canceled");
    controller.abort(cancellation);
    await expect(first).rejects.toBe(cancellation);
    hold.release();
    await expect(second).resolves.toBe(fs.realpathSync(path.join(repo, ".git")));
  } finally { hold.release(); await Promise.allSettled([first, second]); }
});

it("waits for every canceled identity child before rejecting the batch", async () => {
  clearRepoIdentityCache();
  const db = migratedMemoryDb();
  const firstRepo = createAuthCheckRepo();
  const secondRepo = createAuthCheckRepo();
  const firstHold = holdIdentity(firstRepo);
  const secondHold = holdIdentity(secondRepo);
  const controller = new AbortController();
  const pending = observeRepoIdentities(db, [], [firstRepo, secondRepo], controller.signal);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.all([firstHold.reached(pending), secondHold.reached(pending)]);
    const cancellation = new Error("Owner disposed");
    controller.abort(cancellation);
    firstHold.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    secondHold.release();
    await expect(pending).rejects.toBe(cancellation);
  } finally { firstHold.release(); secondHold.release(); await pending.catch(() => undefined); db.close(); }
});

it("reaps all pending auth-pipeline identity observations before reconciler stop completes", async () => {
  clearRepoIdentityCache();
  const db = createMigratedDb();
  setDb(db);
  const repos = [createAuthCheckRepo(), createAuthCheckRepo()];
  const aliases = repos.map((repo, index) => {
    const alias = path.join(testRuntimeRoot, `pipeline-alias-${index}`);
    fs.symlinkSync(repo, alias);
    return alias;
  });
  for (const [index, repo] of repos.entries()) {
    const project = createLedgerProject(db, repo).project;
    insertWorkUnit(db, { id: `pipeline-unit-${index}`, issueShortId: `private-${index}`, ledgerIssueId: null as any,
      repoId: project.project_key!, assignedSessionId: "", authRequestId: null as any });
    const branch = `feature/missing-${index}`;
    db.prepare("UPDATE work_units SET branch = ?, assigned_session_id = NULL WHERE id = ?").run(branch, `pipeline-unit-${index}`);
    db.prepare(`INSERT INTO auth_requests (id,type,command,title,status,repo,cwd,head_branch,created_at,updated_at,expires_at)
      VALUES (?, 'merge', 'private retained merge', 'Private pipeline', 'pending', ?, ?, ?, ?, ?, ?)`)
      .run(`pipeline-auth-${index}`, project.project_key, aliases[index], branch, Date.now() + 1000, Date.now(), Date.now() + 60_000);
    await canonicalRepoKeyForPath(repo);
  }
  const holds = aliases.map(holdIdentity);
  const reconciler = new WorkUnitReconciler(() => undefined, {
    archiver: { archive: async () => undefined, unarchive: async () => undefined },
    resolveSession: () => undefined,
  });
  const pass = reconciler.reconcile();
  let stopped = false;
  let stop: Promise<void> | undefined;
  try {
    await Promise.all(holds.map(hold => hold.reached(pass)));
    stop = reconciler.stop().then(() => { stopped = true; });
    holds[0]!.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    holds[1]!.release();
    await stop;
    expect(db.prepare("SELECT state FROM work_units ORDER BY id").all()).toEqual([{ state: "committed" }, { state: "committed" }]);
  } finally { holds.forEach(hold => hold.release()); await (stop ?? reconciler.stop()); await pass; db.close(); }
});

it.each(["auto-commit", "abandon"])("preserves explicit work-unit changes during %s identity observation", async passName => {
  const db = createMigratedDb();
  setDb(db);
  const repo = createAuthCheckRepo();
  const project = createLedgerProject(db, repo).project;
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, { type: "api_token", fingerprint: `reconciler-owner-${passName}` });
  const branch = passName === "auto-commit" ? "feature/ahead" : "feature/missing";
  db.prepare(`INSERT INTO work_units (id,issue_id,repo_id,branch,kind,state,created_at,owner_user_id,owner_credential_id,custody_generation)
    VALUES ('racing-unit','private',?,?,'solo',?,0,?,?,1)`)
    .run(project.project_key, branch, passName === "auto-commit" ? "open" : "committed", operator.id, credential.id);
  if (passName === "auto-commit") db.prepare("INSERT INTO branches (repo_root,branch,ahead_default) VALUES (?,?,1)").run(repo, branch);
  const router = authenticatedTestRouter(operator, { credentialId: credential.id });
  registerWorkUnitRoutes(router, {} as never);
  clearRepoIdentityCache();
  const hold = holdIdentity(repo);
  const reconciler = new WorkUnitReconciler(() => undefined, {
    archiver: { archive: async () => undefined, unarchive: async () => undefined },
    resolveSession: (_db, id) => id === "new-live-holder" ? { liveness: "live" } as any : null,
  });
  const pass = reconciler.reconcile();
  try {
    await hold.reached(pass);
    const response = await router.invoke({ method: "PATCH", url: "/api/work-units/racing-unit", body: {
      expected_generation: 1, ...(passName === "auto-commit" ? { state: "resolved" } : { assigned_session_id: "new-live-holder" }),
    } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    hold.release();
    await pass;
    expect(db.prepare("SELECT state,assigned_session_id FROM work_units WHERE id = 'racing-unit'").get())
      .toEqual(passName === "auto-commit" ? { state: "resolved", assigned_session_id: null } : { state: "committed", assigned_session_id: "new-live-holder" });
  } finally { hold.release(); await pass; await reconciler.stop(); db.close(); }
});

it("does not repopulate a cleared cache from an older pending generation", async () => {
  clearRepoIdentityCache();
  const repo = createAuthCheckRepo();
  const firstHold = holdIdentity();
  const first = canonicalRepoKeyForPath(repo);
  await firstHold.reached(first);
  clearRepoIdentityCache();
  firstHold.release();
  await first;
  const secondHold = holdIdentity();
  const second = canonicalRepoKeyForPath(repo);
  try { await secondHold.reached(second); secondHold.release(); await expect(second).resolves.toBe(await first); }
  finally { secondHold.release(); await second; }
});

it("rejects a captured registry decision after a checkout binding changes", async () => {
  clearRepoIdentityCache();
  const db = migratedMemoryDb();
  const repo = createAuthCheckRepo();
  const { project } = resolveProjectForCheckout(db, { root: repo, name: path.basename(repo), defaultBranch: "main", remoteUrl: "" });
  const hold = holdIdentity();
  const pending = observeRepoIdentities(db, [project.project_key]);
  try {
    await hold.reached(pending);
    db.prepare("UPDATE ledger_project_checkouts SET root = ? WHERE project_id = ?").run(path.join(testRuntimeRoot, "rebound-checkout"), project.id);
    hold.release();
    const identity = await pending;
    expect(() => identity.assertCurrent()).toThrow("registry changed");
  } finally { hold.release(); await pending; db.close(); }
});

it.each(["bookkeeping", "reviewed head", "approver", "recorded SHA"])("guards recorded merge evidence while allowing unrelated finalizer progress: %s", async change => {
  const db = createMigratedDb();
  const historyRepo = createAuthCheckRepo();
  const probeRepo = createAuthCheckRepo();
  for (const repo of [historyRepo, probeRepo]) { registerWorkRepo(db, repo); createLedgerProject(db, repo); }
  const queue = new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager(), executor: options => publishFixtureExecution(queue, options) });
  let hold: ReturnType<typeof holdIdentity> | undefined;
  let pending: Promise<any> | undefined;
  try {
    const submit = async (repo: string, branch: string) => {
      commitOnBranch(repo, branch, { "evidence.txt": `${branch}\n` });
      return queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: branch, command: `mandible auth merge ${branch} --into main`,
        repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: branch, merge_head_sha: git(repo, ["rev-parse", branch]) });
    };
    const historical = await submit(historyRepo, "feature/history");
    await awaitFixtureResolution(queue, historical.id, () => approveFixtureRequest(queue, historical.id));
    await queue.drainFinalizers();
    const completed = queue.getRequestExact(historical.id)!;
    expect(completed).toMatchObject({ status: "completed", exit_code: 0 });
    const probe = await submit(probeRepo, "feature/probe");
    clearRepoIdentityCache();
    hold = holdIdentity(probeRepo);
    pending = (queue as any).recordedQueueMerges(queue.getRequestExact(probe.id)!);
    void pending!.catch(() => undefined);
    await hold.reached(pending!);
    if (change === "bookkeeping") db.prepare("UPDATE auth_requests SET merge_finalizer_state = ?, updated_at = ? WHERE id = ?")
      .run('{"archive_worker_threads":{"state":"done","attempts":2}}', Date.now() + 1, historical.id);
    if (change === "reviewed head") db.prepare("UPDATE auth_requests SET merge_head_sha = ? WHERE id = ?").run("b".repeat(40), historical.id);
    if (change === "approver") {
      const other = createUser(db, { slug: "other-historical-approver", kind: "human", display_name: "Other approver" });
      db.prepare("UPDATE auth_requests SET approved_by_user_id = ? WHERE id = ?").run(other.id, historical.id);
    }
    if (change === "recorded SHA") {
      const previous = getAttributionEvidence(db, completed.execution_evidence_id!)!;
      const replacement = addAttributionEvidence(db, { evidence_method: "credential_signature", credential_id: previous.credential_id,
        details: { commit_sha: "b".repeat(40) } });
      db.prepare("UPDATE auth_requests SET execution_evidence_id = ? WHERE id = ?").run(replacement.id, historical.id);
    }
    hold.release();
    if (change === "bookkeeping") {
      const evidence = await pending;
      expect(() => evidence.assertCurrent()).not.toThrow();
      db.prepare("UPDATE auth_requests SET updated_at = ? WHERE id = ?").run(Date.now() + 2, historical.id);
      expect(() => evidence.assertCurrent()).not.toThrow();
    } else await expect(pending).rejects.toThrow("Recorded merge evidence changed");
  } finally { hold?.release(); await pending?.catch(() => undefined); await queue.dispose(); db.close(); }
});

it("does not retire a negative ancestry candidate whose authority changes while identity is held", async () => {
  const db = createMigratedDb();
  const repo = createAuthCheckRepo();
  registerWorkRepo(db, repo); createLedgerProject(db, repo);
  commitOnBranch(repo, "feature/negative", { "negative.txt": "not merged\n" });
  commitOnBranch(repo, "feature/candidate", { "candidate.txt": "candidate\n" });
  const queue = new AuthQueue({ db, now: () => 10_000, backgroundMaintenance: false, workUnitAbandonedScanRetentionMs: 1000, hookManager: createNoopHookManager() });
  const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: "Negative ancestry", command: "mandible auth merge feature/candidate --into main",
    repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/candidate", merge_head_sha: git(repo, ["rev-parse", "feature/candidate"]) });
  db.prepare(`INSERT INTO work_units (id,issue_id,repo_id,branch,kind,state,created_at) VALUES ('negative-unit','private',?,'feature/negative','solo','abandoned',0)`).run(path.basename(repo));
  clearRepoIdentityCache();
  const hold = holdIdentity(repo);
  const scan = (queue as any).resolveAncestryWorkUnitsOnMerge(queue.getRequestExact(request.id)!) as Promise<string[]>;
  void scan.catch(() => undefined);
  try {
    await hold.reached(scan);
    db.prepare("UPDATE work_units SET branch = 'feature/changed-negative', custody_generation = custody_generation + 1 WHERE id = 'negative-unit'").run();
    hold.release();
    await expect(scan).rejects.toThrow("changed during");
    expect(db.prepare("SELECT state,merge_scan_retired_at FROM work_units WHERE id = 'negative-unit'").get())
      .toEqual({ state: "abandoned", merge_scan_retired_at: null });
    await (queue as any).resolveAncestryWorkUnitsOnMerge(queue.getRequestExact(request.id)!);
    expect(db.prepare("SELECT state,merge_scan_retired_at FROM work_units WHERE id = 'negative-unit'").get())
      .toEqual({ state: "abandoned", merge_scan_retired_at: 10_000 });
  } finally { hold.release(); await scan.catch(() => undefined); await queue.dispose(); db.close(); }
});
