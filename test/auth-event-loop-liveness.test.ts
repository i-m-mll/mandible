// @vitest-environment node
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import path from 'node:path';
import { expect, it } from 'vitest';
import { AuthQueue } from '../src/auth-queue.js';
import { AuthAutoApproveManager } from '../src/auth-auto-approve.js';
import { setDb } from '../src/db.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { createServer } from '../src/server.js';
import { SseManager } from '../src/sse.js';
import type { AuthRequest } from '../src/types.js';
import { addCredential, getOperator } from '../src/users/store.js';
import { authenticatedTestRouter } from './helpers/authenticated-router.js';
import { MAIN_CLI_INSTANCE_RESPONSE } from './helpers/cli-instance-response.js';
import {
  AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW, approveFixtureRequest, commitOnBranch,
  configureSigningCredential, createAuthCheckRepo, createLedgerProject, createMigratedDb,
  createNoopHookManager, git, registerWorkRepo, waitForStatus,
} from './helpers/auth-queue-fixtures.js';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A deadlock guard, not a latency assertion: success requires the executor gate to remain closed. */
async function atBarrier<T>(operation: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), STATE_DEADLINE_MS);
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); }
}

it('keeps pending lifecycle and registered health work live while preserving same-repo execution order', async () => {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  setDb(db);
  registerWorkRepo(db, repo);
  const project = createLedgerProject(db, repo).project;
  commitOnBranch(repo, 'feature/expires-while-held', { 'expiry.txt': 'private expiry candidate\n' });
  configureSigningCredential(db, repo, 'ssh_key');
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, { type: 'api_token', fingerprint: 'held-executor-liveness' });
  const router = authenticatedTestRouter(operator, { credentialId: credential.id });
  const firstStarted = barrier<void>();
  const followerStarted = barrier<void>();
  const releaseFirst = barrier<void>();
  const releaseFollower = barrier<void>();
  const gates = new Map<string, ReturnType<typeof barrier<void>>>();
  const started: string[] = [];
  const order: string[] = [];
  let firstId = '';
  let firstReleased = false;
  let clock = Date.now();
  const epoch = clock;
  let firstStatusAtFollowerStart: string | undefined;
  const queue = new AuthQueue({
    db, now: () => clock, ttlMs: 1_000, hookManager: createNoopHookManager(),
    executor: async options => {
      const gate = gates.get(options.request_id);
      if (!gate) throw new Error(`Unexpected executor admission: ${options.request_id}`);
      started.push(options.request_id);
      order.push(`start:${options.request_id}`);
      if (options.request_id === firstId) firstStarted.resolve();
      else {
        firstStatusAtFollowerStart = queue.getRequestExact(firstId)?.status;
        followerStarted.resolve();
      }
      await gate.promise;
      order.push(`finish:${options.request_id}`);
      return { exit_code: 0, signal: null, stdout: '', stderr: '', output: '', started_at: epoch, finished_at: clock };
    },
  });
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
  // Register the real server health handler, not a private sentinel. No listener or daemon is started.
  createServer({ db, router, sse: new SseManager(), logger: () => undefined, version: 'held-executor-fixture',
    getStartupInfo: () => null, instance: { ...MAIN_CLI_INSTANCE_RESPONSE.instance, writable_roots: [repo] } });
  const owned: Promise<unknown>[] = [];
  const submitCommand = (name: string) => queue.submit({ ...AUTH_COMMAND_REVIEW,
    type: 'config-change', command: `echo ${name}`, title: name, cwd: repo, repo: project.project_key,
    requester_evidence_method: 'api_token', requester_credential_id: credential.id,
  }, operator.id);
  const invoke = (method: string, url: string, body?: unknown) => router.invoke({ method, url, body });
  const pendingId = async (name: string) => {
    const result = await invoke('POST', '/api/auth/v2/request', { ...AUTH_COMMAND_REVIEW,
      type: 'config-change', command: `echo ${name}`, title: name, cwd: repo, repo: project.project_key });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return (result.body as { request_id: string }).request_id;
  };
  const revisionControl = (id: string) => ({ operator_recovery: true,
    expected_revision: queue.listLifecycleEvents(id).at(-1)!.revision, expected_custody_generation: 0 });
  try {
    const first = await submitCommand('held first execution');
    firstId = first.id;
    gates.set(first.id, releaseFirst);
    await approveFixtureRequest(queue, first.id);
    await firstStarted.promise;
    expect(queue.getRequestExact(first.id)?.status).toBe('executing');

    const progress = (async () => {
      const expiring = await queue.submit({ ...AUTH_MERGE_REVIEW, type: 'merge',
        command: 'mandible auth merge feature/expires-while-held --into main', title: 'Expiry while execution is held',
        cwd: repo, repo: project.project_key, base_branch: 'main', head_branch: 'feature/expires-while-held',
        merge_head_sha: git(repo, ['rev-parse', 'feature/expires-while-held']),
      });
      expect(expiring.status).toBe('pending');
      expect(expiring.merge_candidate_pin_sha).toBeTruthy();
      clock = epoch + 500;
      const targets = Object.fromEntries(await Promise.all(['revise', 'reject', 'withdraw', 'skip'].map(async name => [name, await pendingId(name)])));
      const follower = await submitCommand('same-repo follower admitted while first executor is held');
      gates.set(follower.id, releaseFollower);
      await approveFixtureRequest(queue, follower.id);
      expect(started).toEqual([first.id]);

      const timerProgress = new Promise<boolean>(resolve => setTimeout(() => resolve(true), 0));
      const [health, timer, listed, status, output] = await Promise.all([
        invoke('GET', '/api/health'), timerProgress,
        invoke('GET', '/api/auth/queue'), invoke('GET', `/api/auth/request/${first.id}`),
        invoke('POST', `/api/auth/request/${first.id}/output`, { chunk: 'output delivered before release\n' }),
      ]);
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: 'ok', ready: true, version: 'held-executor-fixture' });
      expect(timer).toBe(true);
      expect(listed.status).toBe(200);
      expect((listed.body as { requests: AuthRequest[] }).requests.map(request => request.id)).toContain(follower.id);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ status: 'executing' });
      expect(output.status).toBe(202);
      expect(queue.getRequestExact(first.id)?.output).toContain('output delivered before release');

      const revised = await invoke('PUT', `/api/auth/v2/request/${targets.revise}`, {
        ...revisionControl(targets.revise), commit_message: 'Revised pending action while the executor remains held.' });
      const rejected = await invoke('POST', `/api/auth/request/${targets.reject}/reject`, { reason: 'Not required.' });
      const withdrawn = await invoke('POST', `/api/auth/request/${targets.withdraw}/withdraw`, {
        ...revisionControl(targets.withdraw), reason: 'Withdraw the private fixture action.' });
      const skipped = await invoke('POST', `/api/auth/request/${targets.skip}/skip`, {});
      expect(revised.status, JSON.stringify(revised.body)).toBe(200);
      expect(rejected.body).toMatchObject({ status: 'rejected' });
      expect(withdrawn.body).toMatchObject({ status: 'withdrawn' });
      expect(skipped.status).toBe(200);
      expect(queue.getRequestExact(targets.skip)?.skipped_at).toBe(clock);
      expect(queue.getRequestExact(targets.revise)?.commit_message).toContain('Revised pending action');

      clock = epoch + 1_000;
      await queue.expireStale();
      expect(queue.getRequestExact(expiring.id)?.status).toBe('expired');
      expect(queue.getRequestExact(follower.id)?.status).toBe('executing');
      expect(firstReleased).toBe(false);
      expect(started).toEqual([first.id]);
      return follower;
    })();
    owned.push(progress);
    const follower = await atBarrier(progress, 'admission, reads, output, pending actions, expiry and health/timer callbacks');
    firstReleased = true;
    releaseFirst.resolve();
    await atBarrier(followerStarted.promise, 'the queued follower to start after first execution completed');
    expect(firstStatusAtFollowerStart).toBe('completed');
    expect(started).toEqual([first.id, follower.id]);
    expect(order.indexOf(`finish:${first.id}`)).toBeLessThan(order.indexOf(`start:${follower.id}`));
    releaseFollower.resolve();
    expect((await waitForStatus(queue, first.id, 'completed')).exit_code).toBe(0);
    expect((await waitForStatus(queue, follower.id, 'completed')).exit_code).toBe(0);
  } finally {
    firstReleased = true;
    releaseFirst.resolve();
    releaseFollower.resolve();
    await Promise.allSettled(owned);
    await queue.dispose();
    db.close();
  }
});
