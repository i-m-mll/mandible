// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createMigratedDb, insertRawLedgerProject } from './helpers/ledger-fixtures.js';
import { createUser, revokeCredential } from '../src/users/store.js';
import { mintApiToken } from '../src/client-auth/tokens.js';
import { addGrant } from '../src/permissions/store.js';
import { qualifiedRuntimeFixtureEnv } from './helpers/runtime-fixture.js';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';

it('runs the one-shot with a complete durable token identity and retains permission and lifecycle guards', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-recovery-cli-'));
  const dbFile = path.join(home, 'mandible.db');
  const db = createMigratedDb({ path: dbFile });
  try {
    const pepper = 'private-cli-boundary-pepper';
    const config = path.join(home, 'config/client-auth'); fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'pepper'), pepper, { mode: 0o600 });
    const user = createUser(db, { slug: 'recovery-cli-agent', kind: 'agent', display_name: 'Recovery CLI agent' });
    const token = mintApiToken(db, pepper, user.id);
    const project = insertRawLedgerProject(db, { name: 'recovery-cli', projectKey: 'recovery-cli', displayName: 'Recovery CLI' });
    db.prepare('UPDATE ledger_projects SET restricted=1 WHERE id=?').run(project);
    const request = 'private-recovery-request';
    db.prepare(`INSERT INTO auth_requests (id,type,command,title,cwd,repo,status,created_at,updated_at,expires_at,execution_mode)
      VALUES (?, 'merge', 'never execute', 'Private boundary', ?, ?, 'pending', 1, 1, 1, 'daemon')`).run(request, home, project);
    const before = db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request);
    const runtime = spawnSync('/bin/sh', ['scripts/bun-runtime.sh'], { encoding: 'utf8' }).stdout.trim();
    const invoke = () => spawnSync(runtime, ['scripts/verify-current-convergence.ts', request], {
      input: token.token, encoding: 'utf8', timeout: STATE_DEADLINE_MS,
      env: { ...process.env, ...qualifiedRuntimeFixtureEnv(), MANDIBLE_HOME: home, MANDIBLE_DB: dbFile, GIT_OPTIONAL_LOCKS: '0' },
    });
    const denied = invoke();
    expect(denied.status).toBe(1); expect(denied.stderr).toContain('Project write permission is required.');
    expect(denied.stderr).not.toContain('ambiguous_or_inactive_identity');
    addGrant(db, { subject_type: 'user', subject: user.id, resource_type: 'project', resource: project, permission: 'write' });
    const admitted = invoke();
    expect(admitted.status).toBe(1);
    // This downstream lifecycle guard proves real project permission succeeded.
    expect(admitted.stderr).toContain('Convergence retry applies only to a successfully executed request.');
    expect(db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request)).toEqual(before);
    // A completed command request still cannot invent delivery custody. The
    // existing publication tests separately qualify merge receipt validation.
    db.prepare("UPDATE auth_requests SET type='commit',status='completed',exit_code=0 WHERE id=?").run(request);
    const completed = db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request);
    const unowned = invoke();
    expect(unowned.status).toBe(1); expect(unowned.stderr).toContain('This request has no provable delivery-work-unit custody.');
    revokeCredential(db, token.credential.id);
    const revoked = invoke();
    expect(revoked.status).toBe(1); expect(revoked.stderr).toContain('An active durable credential is required.');
    expect(db.prepare('SELECT * FROM auth_requests WHERE id=?').get(request)).toEqual(completed);
    for (const result of [denied, admitted, unowned, revoked]) expect(`${result.stdout}${result.stderr}`).not.toContain(token.token);
  } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
