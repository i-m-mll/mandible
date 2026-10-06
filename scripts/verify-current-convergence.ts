import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from '../src/sqlite.js';
import { getDbPath, type Db } from '../src/db.js';
import { AuthQueue } from '../src/auth-queue.js';
import { verifyApiToken, resolvedApiTokenIdentity } from '../src/client-auth/tokens.js';
import { requireProjectAccess } from '../src/permissions/store.js';
import { resolveProjectRef } from '../src/ledger/project-registry.js';
import { getMandibleHome } from '../src/platform-paths.js';
import { PRODUCTION_EFFECTS } from '../src/security/effect-policy.js';

const [requestId, option] = process.argv.slice(2);
if (!requestId || !/^[a-zA-Z0-9-]+$/.test(requestId) || option && option !== '--operator-recovery') throw new Error('Usage: verify-current-convergence.ts <request> [--operator-recovery]; durable token must arrive on stdin.');
const token = fs.readFileSync(0, 'utf8').trim();
const pepper = fs.readFileSync(path.join(getMandibleHome(), 'config/client-auth/pepper'), 'utf8').trim();
const db = new SqliteDatabase(getDbPath(), { fileMustExist: true }) as Db;
const queue = new AuthQueue({ db, backgroundMaintenance: false,
  executor: async () => { throw new Error('Verification-only recovery cannot execute a command.'); },
  restartFn: () => { throw new Error('Verification-only recovery cannot restart a daemon.'); } });
try {
  const identity = verifyApiToken(db, pepper, token);
  if (!identity) throw new Error('An active durable credential is required.');
  const request = queue.getRequestExact(requestId);
  if (!request?.repo) throw new Error('An exact project-bound request is required.');
  const project = resolveProjectRef(db, request.repo);
  if (!project.ok || !project.project) throw new Error('Request project is unavailable or ambiguous.');
  requireProjectAccess(db, { client_identity: resolvedApiTokenIdentity(identity, 'in_process', PRODUCTION_EFFECTS) }, project.project.id, 'write');
  const convergence = await queue.retryHookConvergence(request.id, undefined, { mode: 'verify-current',
    actor: { user_id: identity.user.id, credential_id: identity.credentialId, evidence_method: 'api_token', authority_path: option === '--operator-recovery' ? 'operator_recovery' : 'custodian' } });
  process.stdout.write(JSON.stringify({ request_id: request.id, convergence }) + '\n');
} finally { queue.dispose(); db.close(); }
