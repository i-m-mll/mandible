// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AuthQueue } from '../src/auth-queue.js';
import { addDelegatedSigningLease } from '../src/users/store.js';
import {
  AUTH_MERGE_REVIEW, commitOnBranch, configureSigningCredential, createAuthCheckRepo,
  createLedgerProject, createMigratedDb, createNoopHookManager, executionEvidenceChain,
  git, publishFixtureExecution, recordPassingCandidateAcceptance, registerWorkRepo,
} from './helpers/auth-queue-fixtures.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('executes once with the newly granted lease and environment after owned presence refresh', async () => {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  commitOnBranch(repo, 'feature/presence-refresh', { 'presence.txt': 'reviewed presence refresh\n' });
  registerWorkRepo(db, repo);
  const project = createLedgerProject(db, repo).project;
  const signing = configureSigningCredential(db, repo, 'delegated_ssh_key');
  const now = Date.now();
  const oldLease = 'presence-before-refresh';
  const newLease = 'presence-after-refresh';
  const grant = (id: string) => addDelegatedSigningLease(db, {
    id, credential_id: signing.credentialId, owner_user_id: signing.operatorId,
    minted_at: now - 100, expires_at: now + 60_000, mint_method: 'fresh_presence',
  });
  grant(oldLease);
  const enteredPresence = barrier();
  const releasePresence = barrier();
  const newEnv = { SSH_AUTH_SOCK: path.join(repo, '.git', 'refreshed-agent.sock'), MANDIBLE_TEST_PRESENCE_LEASE: newLease };
  let challenges = 0;
  let executions = 0;
  let runner: Promise<unknown> | undefined;
  const queue = new AuthQueue({
    db, now: () => now, backgroundMaintenance: false, hookManager: createNoopHookManager(),
    autoApprover: {
      getActiveApprovalContext: () => null,
      getDelegatedSigningStatus: () => ({
        provider: 'private-presence-fixture', configured: true,
        public_key: fs.readFileSync(`${signing.keyPath}.pub`, 'utf8').trim(),
        public_key_path: `${signing.keyPath}.pub`,
        encrypted_passphrase_path: path.join(repo, '.git', 'fixture.age'),
        recipient_path: path.join(repo, '.git', 'fixture.recipient'), missing_tools: [],
      }),
      presenceChallenge: async () => {
        challenges++;
        enteredPresence.resolve();
        await releasePresence.promise;
        grant(newLease);
        return { source: 'presence_challenge', leaseId: newLease, approverUserId: signing.operatorId, env: newEnv };
      },
    },
    executor: async options => {
      executions++;
      const running = queue.getRequestExact(options.request_id)!;
      expect(running.approval_lease_id).toBe(newLease);
      expect(running.approved_by_user_id).toBe(signing.operatorId);
      expect(options.env).toMatchObject(newEnv);
      expect(options.env?.MANDIBLE_AUTH_ALLOWED_SIGNERS).toContain(signing.credentialId);
      return publishFixtureExecution(queue, options);
    },
  });
  try {
    const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: 'merge',
      command: 'mandible auth merge feature/presence-refresh --into main', title: 'Refresh delegated presence before execution',
      cwd: repo, repo: project.project_key, base_branch: 'main', head_branch: 'feature/presence-refresh',
      merge_head_sha: git(repo, ['rev-parse', 'feature/presence-refresh']),
    });
    recordPassingCandidateAcceptance(db, request.id);
    await queue.approve(request.id, {
      source: 'presence_challenge', leaseId: oldLease, approverUserId: signing.operatorId, env: {},
    });
    await enteredPresence.promise;
    expect(challenges).toBe(1);
    expect(executions).toBe(0);
    expect(queue.getRequestExact(request.id)).toMatchObject({ status: 'executing', approval_lease_id: oldLease });
    // Observe the real owner while it is barrier-held; never alter its map or execution token.
    runner = (queue as unknown as { inFlight: Map<string, Promise<unknown>> }).inFlight.get(request.id);
    expect(runner).toBeDefined();
    releasePresence.resolve();
    await runner;

    const completed = queue.getRequestExact(request.id)!;
    expect(completed.approval_lease_id).toBe(newLease);
    expect(challenges).toBe(1);
    expect(executions).toBe(1);
    expect(completed).toMatchObject({ status: 'completed', exit_code: 0, error: null, approval_source: 'presence_challenge' });
    const evidence = executionEvidenceChain(db, completed.execution_evidence_id!);
    expect(evidence.authorization).toMatchObject({ evidence_method: 'hardware_presence', lease_id: newLease });
    expect(JSON.parse(evidence.signature.details_json)).toMatchObject({ verified: true });
  } finally {
    releasePresence.resolve();
    if (runner) await runner;
    await queue.dispose();
    db.close();
  }
});
