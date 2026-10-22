// @vitest-environment node
import { expect, it } from 'vitest';
import { AuthQueue } from '../src/auth-queue.js';
import { setDb } from '../src/db.js';
import { registerWorkUnitRoutes } from '../src/routes/work-units.js';
import { addCredential, createUser, getOperator } from '../src/users/store.js';
import { authenticatedTestRouter } from './helpers/authenticated-router.js';
import {
  AUTH_MERGE_REVIEW, approveFixtureRequest, commitOnBranch, configureSigningCredential,
  createAuthCheckRepo, createLedgerIssue, createLedgerProject, createMigratedDb,
  createNoopHookManager, executionEvidenceChain, git, publishFixtureExecution, registerWorkRepo,
} from './helpers/auth-queue-fixtures.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(['continuation', 'owner', 'credential'] as const)('binds execution to authority while allowing continuation bookkeeping: %s', async scenario => {
  const repo = createAuthCheckRepo();
  const db = createMigratedDb();
  setDb(db);
  commitOnBranch(repo, 'feature/continuation-stability', { 'continued.txt': 'reviewed continuation fixture\n' });
  registerWorkRepo(db, repo);
  const project = createLedgerProject(db, repo).project;
  const issue = createLedgerIssue(db, project.id, '8409abc', 'Private execution identity');
  const operator = getOperator(db)!;
  const credential = addCredential(db, operator.id, { type: 'api_token', fingerprint: 'continuation-owner' });
  configureSigningCredential(db, repo, 'ssh_key');
  const unitId = crypto.randomUUID();
  db.prepare(`INSERT INTO work_units
    (id,issue_id,repo_id,branch,kind,state,created_at,activated_at,ledger_issue_id,
      owner_user_id,owner_credential_id,custody_generation)
    VALUES (?, '8409abc', ?, 'feature/continuation-stability', 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
    .run(unitId, project.project_key, issue.id, operator.id, credential.id);
  const enteredExecutor = barrier();
  const releaseExecutor = barrier();
  const output = 'distinct executor output after continuation edit\n';
  let executions = 0;
  let runner: Promise<unknown> | undefined;
  const queue = new AuthQueue({ db, backgroundMaintenance: false, hookManager: createNoopHookManager(),
    executor: async options => {
      executions++;
      enteredExecutor.resolve();
      await releaseExecutor.promise;
      options.onOutput?.({ request_id: options.request_id, stream: 'stdout', text: output, timestamp: Date.now() });
      if (scenario === 'continuation') {
        const published = await publishFixtureExecution(queue, options);
        return { ...published, stdout: output + published.stdout, output: output + published.output };
      }
      return { exit_code: 0, signal: null, stdout: output, stderr: '', output, started_at: Date.now(), finished_at: Date.now() };
    },
  });
  const router = authenticatedTestRouter(operator, { credentialId: credential.id });
  registerWorkUnitRoutes(router, {} as never);
  const authority = () => db.prepare(`SELECT id,owner_user_id,owner_credential_id,custody_generation,
    auth_request_id,state,branch,repo_id,ledger_issue_id FROM work_units WHERE id = ?`).get(unitId);
  try {
    const request = await queue.submit({ ...AUTH_MERGE_REVIEW, type: 'merge',
      command: 'mandible auth merge feature/continuation-stability --into main', title: 'Preserve execution across continuation bookkeeping',
      cwd: repo, repo: project.project_key, base_branch: 'main', head_branch: 'feature/continuation-stability',
      merge_head_sha: git(repo, ['rev-parse', 'feature/continuation-stability']),
      issue_references: [issue.id], require_delivery_custody: true,
      requester_evidence_method: 'api_token', requester_credential_id: credential.id,
    }, operator.id);
    await approveFixtureRequest(queue, request.id);
    await enteredExecutor.promise;
    expect(executions).toBe(1);
    const before = authority();
    if (scenario === 'continuation') {
      const continuation = 'Continue the existing reviewed work without transferring authority.';
      const patched = await router.invoke({ method: 'PATCH', url: `/api/work-units/${unitId}`,
        body: { continuation, continuation_by: 'private-owner', continuation_at: Date.now() } });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(db.prepare('SELECT continuation FROM work_units WHERE id = ?').get(unitId)).toEqual({ continuation });
      expect(authority()).toEqual(before);
    } else if (scenario === 'owner') {
      const other = createUser(db, { slug: 'identity-other', kind: 'agent', display_name: 'Other private custodian' });
      const otherCredential = addCredential(db, other.id, { type: 'api_token', fingerprint: 'other-identity-owner' });
      // Storage adversary: keep the generation fixed to isolate fresh owner/credential binding.
      db.prepare('UPDATE work_units SET owner_user_id = ?, owner_credential_id = ? WHERE id = ?')
        .run(other.id, otherCredential.id, unitId);
    } else {
      const replacement = addCredential(db, operator.id, { type: 'api_token', fingerprint: 'replacement-identity-credential' });
      db.prepare('UPDATE work_units SET owner_credential_id = ? WHERE id = ?').run(replacement.id, unitId);
    }
    // Observe only the real execution owner; no map/token mutation or private execution call.
    runner = (queue as unknown as { inFlight: Map<string, Promise<unknown>> }).inFlight.get(request.id);
    expect(runner).toBeDefined();
    releaseExecutor.resolve();
    await runner;

    const completed = queue.getRequestExact(request.id)!;
    expect(executions).toBe(1);
    if (scenario === 'continuation') {
      expect(completed.output).toContain(output);
      expect(completed).toMatchObject({ status: 'completed', exit_code: 0, error: null });
      const evidence = executionEvidenceChain(db, completed.execution_evidence_id!);
      expect(JSON.parse(evidence.signature.details_json)).toMatchObject({ verified: true });
    } else {
      expect(completed.output).not.toContain(output);
      expect(completed).toMatchObject({ status: 'executing', exit_code: null });
      expect(queue.listLifecycleEvents(request.id).some(event => event.event_type === 'completed')).toBe(false);
    }
  } finally {
    releaseExecutor.resolve();
    if (runner) await runner;
    await queue.dispose();
    db.close();
  }
});
