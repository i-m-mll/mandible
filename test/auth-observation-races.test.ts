import fs from "node:fs";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { waitUntil } from "./helpers/wait-until.js";
import { AuthQueue } from "../src/auth-queue.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { appendAuthLifecycleEvent } from "../src/auth-lifecycle.js";
import { systemAction } from "../src/identity/resolver.js";
import { addDelegatedSigningLease } from "../src/users/store.js";
import { publishTestCandidate } from "./helpers/auth-delivery-fixtures.js";
import {
  AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW, advanceMainViaAuthorizedMerge, commitOnBranch,
  configureSigningCredential, createAuthCheckRepo, createLedgerIssue, createLedgerProject,
  createMigratedDb, createNoopHookManager, git, insertWorkUnit,
  recordPassingCandidateAcceptance, registerWorkRepo, tamperLooseGitObject,
  registerTestDelegatedLease,
} from "./helpers/auth-queue-fixtures.js";

const gate = vi.hoisted(() => ({ current: null as any }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const take = (kind: string, program: string, args: readonly string[]) => {
    const held = gate.current;
    if (!held?.matches(kind, program, args)) return null;
    gate.current = null;
    return held;
  };
  const execFile = ((...args: any[]) => {
    const held = take("execFile", String(args[0]), args[1] ?? []);
    const callback = args.at(-1);
    if (held && typeof callback === "function") args[args.length - 1] = (...values: any[]) => held.complete(() => callback(...values));
    return (actual.execFile as any)(...args);
  }) as typeof actual.execFile;
  const custom = Object.getOwnPropertyDescriptor(actual.execFile, Symbol.for("nodejs.util.promisify.custom"));
  if (custom) Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), custom);
  const spawn = ((...args: any[]) => {
    const held = take("spawn", String(args[0]), args[1] ?? []);
    const child = (actual.spawn as any)(...args);
    if (held) {
      const emit = child.emit.bind(child);
      child.emit = (event: string, ...values: any[]) => {
        if (event === "close") { held.complete(() => emit(event, ...values)); return true; }
        return emit(event, ...values);
      };
    }
    return child;
  }) as typeof actual.spawn;
  return { ...actual, execFile, spawn };
});

function holdChild(matches: (kind: string, program: string, args: readonly string[]) => boolean) {
  let reached!: () => void;
  let resume: (() => void) | undefined;
  let released = false;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const state = { matches, complete(callback: () => void) { reached(); if (released) callback(); else resume = callback; } };
  gate.current = state;
  return {
    ready,
    release() { released = true; if (gate.current === state) gate.current = null; const callback = resume; resume = undefined; callback?.(); },
  };
}

async function reached(hold: ReturnType<typeof holdChild>, operation: Promise<unknown>) {
  await Promise.race([hold.ready, operation.then(() => { throw new Error("Operation completed before its child barrier."); })]);
}

async function fixture(signingType: "ssh_key" | "delegated_ssh_key" = "ssh_key") {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  registerWorkRepo(db, repo);
  const project = createLedgerProject(db, repo).project;
  commitOnBranch(repo, "feature/target", { "target.txt": "target\n" });
  commitOnBranch(repo, "feature/other", { "other.txt": "other\n" });
  const signing = configureSigningCredential(db, repo, signingType);
  git(repo, ["config", "core.hooksPath", ".git/hooks"]);
  let release!: () => void;
  let started!: () => void;
  let executionCalls = 0;
  let output: ((text: string) => void) | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const queue = new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager(), executor: async options => {
    executionCalls++;
    output = text => options.onOutput?.({ request_id: options.request_id, stream: "stdout", text, timestamp: Date.now() });
    started();
    await pending;
    return { exit_code: 1, signal: null, stdout: "", stderr: "private stopped executor", output: "", started_at: 0, finished_at: 1 };
  } });
  const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: "Private observation race",
    command: "mandible auth merge feature/target --into main", repo: path.basename(repo), cwd: repo,
    base_branch: "main", head_branch: "feature/target", merge_head_sha: git(repo, ["rev-parse", "feature/target"]) });
  recordPassingCandidateAcceptance(db, request.id);
  let closed = false;
  const closeDb = () => { if (!closed) { db.close(); closed = true; } };
  return { repo, db, queue, request, signing, project, ready, release, closeDb,
    calls: () => executionCalls, output: (text: string) => output?.(text),
    async close() { release(); await queue.dispose(); closeDb(); fs.rmSync(repo, { recursive: true, force: true }); } };
}

it("rechecks the pending queue before inserting a concurrently observed merge", async () => {
  const f = await fixture();
  await f.queue.reject(f.request.id, "Replace the setup candidate.");
  await Promise.all([...(f.queue as any).candidateChains.values()]);
  commitOnBranch(f.repo, "feature/conflict-a", { "collision.txt": "a\n" });
  commitOnBranch(f.repo, "feature/conflict-b", { "collision.txt": "b\n" });
  const submit = (branch: string) => f.queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", title: branch,
    command: `mandible auth merge ${branch} --into main`, repo: path.basename(f.repo), cwd: f.repo,
    base_branch: "main", head_branch: branch, merge_head_sha: git(f.repo, ["rev-parse", branch]) });
  const held = holdChild((kind, _program, args) => kind === "execFile" && args[0] === "merge-tree");
  const first = submit("feature/conflict-a");
  try {
    await reached(held, first);
    const second = await submit("feature/conflict-b");
    held.release();
    await expect(first).rejects.toMatchObject({ code: "merge_check_failed" });
    expect((await f.queue.listPending()).map(request => request.id)).toEqual([second.id]);
  } finally { held.release(); await first.catch(() => undefined); await f.close(); }
});

for (const cancellation of ["result", "dispose"] as const) {
  it(`settles a queued admission cancelled by ${cancellation} without starting its executor`, async () => {
    const f = await fixture();
    await f.queue.approveWithOperatorProof(f.request.id, f.signing.operatorId);
    await f.ready;
    const first = (f.queue as any).inFlight.get(f.request.id) as Promise<void>;
    const original = (f.queue as any).executeInBackground;
    let settlements = 0;
    const launch = vi.spyOn(f.queue as any, "executeInBackground").mockImplementation((request: any, settle?: () => Promise<void>) =>
      original.call(f.queue, request, async () => { settlements++; await settle?.(); }));
    try {
      const follower = await f.queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", title: "Queued command",
        command: "echo private follower", cwd: f.repo, target_repo_root: f.repo });
      const leaseId = `private-queued-${cancellation}`;
      registerTestDelegatedLease(f.db, leaseId);
      await f.queue.approve(follower.id, { source: "auto_lease", leaseId, approverUserId: f.signing.operatorId, env: { PRIVATE_QUEUED_ENV: "owned" } });
      const queued = (f.queue as any).inFlight.get(follower.id) as Promise<void>;
      expect(f.calls()).toBe(1);
      if (cancellation === "result") {
        await f.queue.setResult(follower.id, 1, "", "Cancelled before execution.");
        f.release();
        await Promise.all([first, queued]);
      } else {
        await f.queue.dispose();
        await queued;
        f.closeDb();
        f.release();
        await first;
      }
      expect(f.calls()).toBe(1);
      expect(settlements).toBe(1);
      expect((f.queue as any).inFlight.has(follower.id)).toBe(false);
      expect((f.queue as any).executionEnvs.has(follower.id)).toBe(false);
    } finally { launch.mockRestore(); await f.close(); }
  });
}

for (const stage of ["age", "ssh-add"] as const) {
  it(`cancels and reaps a held presence ${stage} before closing its database`, async () => {
    const f = await fixture("delegated_ssh_key");
    await f.queue.dispose();
    const config = fs.mkdtempSync(path.join(f.repo, "presence-"));
    const bin = path.join(config, "bin");
    fs.mkdirSync(bin);
    const key = path.join(config, "id_ed25519_mandible_delegated");
    fs.copyFileSync(f.signing.keyPath, key);
    fs.copyFileSync(`${f.signing.keyPath}.pub`, `${key}.pub`);
    fs.writeFileSync(`${key}.passphrase.age`, "private encrypted fixture\n");
    fs.writeFileSync(path.join(config, "age-recipient.txt"), "age1privatefixture\n");
    for (const command of ["ssh-keygen", "ssh-add", "lsof"]) fs.symlinkSync(command === "lsof" ? "/usr/sbin/lsof" : `/usr/bin/${command}`, path.join(bin, command));
    fs.writeFileSync(path.join(bin, "age-plugin-yubikey"), "#!/bin/sh\nprintf 'private identity\\n'\n", { mode: 0o700 });
    const childMarker = path.join(config, "held-child.pid");
    const agentMarker = path.join(config, "agent-output");
    const agentSocketDir = fs.mkdtempSync(path.join(testRuntimeRoot, "a-"));
    const heldScript = path.join(config, "held.mjs");
    fs.writeFileSync(heldScript, `import fs from 'node:fs'; process.stdin.resume(); fs.writeFileSync(${JSON.stringify(childMarker)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const holdProgram = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(heldScript)}\n`;
    fs.writeFileSync(path.join(bin, "age"), stage === "age" ? holdProgram : "#!/bin/sh\nprintf 'private passphrase\\n'\n", { mode: 0o700 });
    if (stage === "ssh-add") {
      fs.rmSync(path.join(bin, "ssh-add"));
      fs.writeFileSync(path.join(bin, "ssh-add"), holdProgram, { mode: 0o700 });
    }
    const agentScript = path.join(config, "agent.mjs");
    fs.writeFileSync(agentScript, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process'; const result=spawnSync('/usr/bin/ssh-agent',['-a',${JSON.stringify(path.join(agentSocketDir, "s"))},'-s'],{encoding:'utf8',timeout:5000}); fs.writeFileSync(${JSON.stringify(agentMarker)},JSON.stringify({stdout:result.stdout,stderr:result.stderr,status:result.status})); process.stdout.write(result.stdout); process.exit(result.status??1);\n`);
    fs.writeFileSync(path.join(bin, "ssh-agent"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agentScript)}\n`, { mode: 0o700 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const leaseId = `private-presence-${stage}`;
    addDelegatedSigningLease(f.db, { id: leaseId, credential_id: f.signing.credentialId, owner_user_id: f.signing.operatorId,
      minted_at: Date.now() - 1_000, expires_at: Date.now() + 60_000, mint_method: "fresh_presence" });
    const manager = new AuthAutoApproveManager({ db: f.db, configDir: config, seedDefaultDurationSetting: false, broadcast: () => undefined });
    let calls = 0;
    const queue = new AuthQueue({ db: f.db, backgroundMaintenance: false, hookManager: createNoopHookManager(), autoApprover: manager,
      executor: async () => { calls++; throw new Error("Cancelled presence must not start execution."); } });
    let watcher!: fs.FSWatcher;
    const ready = new Promise<number>(resolve => { watcher = fs.watch(config, () => {
      if (fs.existsSync(childMarker)) resolve(Number(fs.readFileSync(childMarker, "utf8")));
    }); });
    try {
      await queue.approve(f.request.id, { source: "presence_challenge", leaseId, approverUserId: f.signing.operatorId, env: {} });
      const running = [...(queue as any).inFlight.values()];
      const childPid = await Promise.race([ready, Promise.allSettled(running).then(() => { throw new Error(`Presence ended before its private child barrier: ${queue.getRequestExact(f.request.id)?.error}; ${fs.existsSync(agentMarker) ? fs.readFileSync(agentMarker, "utf8") : "no agent"}`); })]);
      await queue.dispose();
      await Promise.allSettled(running);
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(calls).toBe(0);
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM delegated_signing_leases").get()).toEqual({ count: 1 });
      if (stage === "ssh-add") {
        const agentPid = Number(fs.readFileSync(agentMarker, "utf8").match(/SSH_AGENT_PID=([0-9]+)/)?.[1]);
        expect(agentPid).toBeGreaterThan(0);
        // The stop command has completed; detached-agent exit is a separate
        // kernel observation, unlike the already reaped signing child above.
        await waitUntil(() => {
          try { process.kill(agentPid, 0); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
        }, "the owned private signing agent to exit");
        expect(() => process.kill(agentPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      } else expect(fs.existsSync(agentMarker)).toBe(false);
      f.closeDb();
    } finally { watcher?.close(); await queue.dispose(); vi.unstubAllEnvs(); fs.rmSync(agentSocketDir, { recursive: true, force: true }); await f.close(); }
  });
}

function bindCustody(f: Awaited<ReturnType<typeof fixture>>) {
  const issue = createLedgerIssue(f.db, f.project.id, "c0570d1", "Custody observation");
  const id = "private-custody-race";
  insertWorkUnit(f.db, { id, issueShortId: issue.id.slice(0, 7), ledgerIssueId: issue.id,
    repoId: path.basename(f.repo), assignedSessionId: "private-race", authRequestId: f.request.id });
  f.db.prepare("UPDATE work_units SET branch = 'feature/target', owner_user_id = ?, owner_credential_id = ? WHERE id = ?").run(f.signing.operatorId, f.signing.credentialId, id);
  f.db.prepare("UPDATE auth_requests SET custody_work_unit_id = ? WHERE id = ?").run(id, f.request.id);
  appendAuthLifecycleEvent(f.db, { requestId: f.request.id, eventType: "revised", priorStatus: "pending", nextStatus: "pending", actor: systemAction(), occurredAt: Date.now() });
  return id;
}

for (const change of ["description", "skip"] as const) {
  it(`rejects a delegated ${change} revision during candidate observation`, async () => {
    const f = await fixture();
    const leaseId = "private-delegated-race";
    registerTestDelegatedLease(f.db, leaseId);
    const held = holdChild((kind, _program, args) => kind === "execFile" && args.includes("--batch"));
    const approval = f.queue.approve(f.request.id, { source: "auto_lease", leaseId, approverUserId: f.signing.operatorId, env: {} });
    try {
      await reached(held, approval);
      if (change === "description") await f.queue.update(f.request.id, {
        canonical_message: true, verification: "Fixture checks pass.",
        commit_message: "Changed outcome\n\nWhy:\nChanged review.\n\nVerification:\nFixture checks pass.\n",
      });
      else await f.queue.skip(f.request.id);
      held.release();
      await expect(approval).rejects.toBeDefined();
      expect(f.calls()).toBe(0);
      expect(f.queue.getRequestExact(f.request.id)?.status).toBe("pending");
      if (change === "skip") expect(f.queue.getRequestExact(f.request.id)?.skipped_at).not.toBeNull();
    } finally { held.release(); await approval.catch(() => undefined); await f.close(); }
  });
}

for (const change of ["description", "command", "authority", "custody", "withdraw", "accepted package"] as const) {
  it(`invalidates a held operator proof after ${change} changes`, async () => {
    const f = await fixture();
    const custody = change === "custody" ? bindCustody(f) : null;
    if (change === 'accepted package') recordPassingCandidateAcceptance(f.db, f.request.id, true);
    const held = holdChild((kind, _program, args) => kind === "spawn" && args.includes("sign") && args.includes("mandible-auth"));
    const approval = f.queue.approveWithOperatorProof(f.request.id, f.signing.operatorId);
    try {
      await reached(held, approval);
      if (change === "description") f.db.prepare("UPDATE auth_requests SET commit_message = commit_message || ? WHERE id = ?").run("\nChanged review\n", f.request.id);
      if (change === "command") f.db.prepare("UPDATE auth_requests SET command = ? WHERE id = ?").run("echo changed command", f.request.id);
      if (change === "authority") f.db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(f.signing.credentialId);
      if (custody) f.db.prepare("UPDATE work_units SET custody_generation = custody_generation + 1 WHERE id = ?").run(custody);
      if (change === "withdraw") await f.queue.reject(f.request.id, "Operator cancelled while signing.");
      if (change === 'accepted package') recordPassingCandidateAcceptance(f.db, f.request.id, true);
      held.release();
      await expect(approval).rejects.toBeDefined();
      expect(f.calls()).toBe(0);
      expect(f.queue.getRequestExact(f.request.id)?.status).toBe(change === "withdraw" ? "rejected" : "pending");
    } finally { held.release(); await approval.catch(() => undefined); await f.close(); }
  });
}

for (const change of ["head", "base", "pin", "object", "hooks"] as const) {
  it(`rejects ${change} changes during post-proof Git observation`, async () => {
    const f = await fixture();
    const held = holdChild((kind, _program, args) => kind === "execFile" && args[0] === "config" && args.includes("user.email"));
    const approval = f.queue.approveWithOperatorProof(f.request.id, f.signing.operatorId);
    let restore: (() => void) | undefined;
    try {
      await reached(held, approval);
      const other = git(f.repo, ["rev-parse", "feature/other"]);
      if (change === "head") git(f.repo, ["update-ref", "refs/heads/feature/target", other]);
      if (change === "base") git(f.repo, ["update-ref", "refs/heads/main", other]);
      if (change === "pin") git(f.repo, ["update-ref", `refs/mandible/auth-candidates/${f.request.id}`, other]);
      if (change === "object") restore = tamperLooseGitObject(f.repo, f.request.merge_candidate_pin_sha!, bytes => { bytes[bytes.length - 1] ^= 1; });
      if (change === "hooks") fs.writeFileSync(path.join(f.repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      held.release();
      await expect(approval).rejects.toBeDefined();
      expect(f.calls()).toBe(0);
      expect(f.queue.getRequestExact(f.request.id)?.status).toBe("pending");
    } finally { held.release(); await approval.catch(() => undefined); restore?.(); await f.close(); }
  });
}

it("orders terminal pin cleanup after a held ref swap and conditional compensation", async () => {
  const f = await fixture();
  advanceMainViaAuthorizedMerge(f.db, f.repo, "feature/other", "private-race-predecessor");
  const ref = `refs/mandible/auth-candidates/${f.request.id}`;
  const held = holdChild((kind, _program, args) => kind === "execFile" && args[0] === "update-ref" && args[1] === ref && args.length === 4);
  const repin = (f.queue as any).recomputeStaleCandidate(f.queue.getRequestExact(f.request.id), "private-race");
  try {
    await reached(held, repin);
    await f.queue.reject(f.request.id, "Cancelled during pin publication.");
    expect(f.queue.getRequestExact(f.request.id)?.status).toBe("rejected");
    held.release();
    await expect(repin).rejects.toBeDefined();
    await Promise.all([...(f.queue as any).candidateChains.values()]);
    expect(git(f.repo, ["for-each-ref", "--format=%(objectname)", ref])).toBe("");
    expect(f.queue.getRequestExact(f.request.id)?.merge_candidate_pin_sha).toBeNull();
  } finally { held.release(); await repin.catch(() => undefined); await f.close(); }
});

for (const change of ["output", "authority", "lifecycle"] as const) {
  it(`does not commit stale completion evidence after ${change} changes`, async () => {
    const f = await fixture();
    await f.queue.approveWithOperatorProof(f.request.id, f.signing.operatorId);
    await f.ready;
    const publication = publishTestCandidate(f.repo, f.queue.getRequestExact(f.request.id)!);
    const held = holdChild((kind, _program, args) => kind === "execFile" && args.includes("--batch"));
    const completion = f.queue.setResult(f.request.id, 0, publication.output);
    try {
      await reached(held, completion);
      if (change === "output") await f.queue.appendOutput(f.request.id, "\nnew output generation\n");
      if (change === "authority") f.db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(f.signing.credentialId);
      if (change === "lifecycle") f.db.prepare("UPDATE auth_requests SET status = 'pending' WHERE id = ?").run(f.request.id);
      held.release();
      await completion.catch(() => undefined);
      expect(f.queue.getRequestExact(f.request.id)?.status).toBe(change === "lifecycle" ? "pending" : "executing");
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM attribution_evidence WHERE json_extract(details_json, '$.publication_verified') = 1").get()).toEqual({ count: 0 });
    } finally { held.release(); await completion.catch(() => undefined); await f.close(); }
  });
}

it("drains a held finite observation and ignores an executor released after database close", async () => {
  const f = await fixture();
  await f.queue.approveWithOperatorProof(f.request.id, f.signing.operatorId);
  await f.ready;
  const running = [...(f.queue as any).inFlight.values()];
  const held = holdChild((kind, _program, args) => kind === "execFile" && args.includes("--git-dir"));
  const check = f.queue.checkMergeIndependence({ cwd: f.repo, repo: path.basename(f.repo), base_branch: "main", head_branch: "feature/target" });
  try {
    await reached(held, check);
    let disposed = false;
    const disposal = f.queue.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    held.release();
    await check.catch(() => undefined);
    await disposal;
    f.closeDb();
    const prepare = vi.spyOn(f.db, "prepare");
    f.output("late executor output");
    f.release();
    await Promise.allSettled(running);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  } finally { held.release(); await check.catch(() => undefined); await f.close(); }
});
