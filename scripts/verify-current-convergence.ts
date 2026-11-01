import path from 'node:path';
import SqliteDatabase from '../src/sqlite.js';
import { getDbPath, type Db } from '../src/db.js';
import { AuthQueue } from '../src/auth-queue.js';
import { ClientAuthenticator } from '../src/client-auth/authenticator.js';
import { inManagedSessionContext, resolveAmbientProviderIdentity } from '../src/ambient-provider-identity.js';
import { resolveProjectRef } from '../src/ledger/project-registry.js';
import { getMandibleHome } from '../src/platform-paths.js';

const [requestId, ...extra] = process.argv.slice(2);
if (!requestId || !/^[a-zA-Z0-9-]+$/.test(requestId) || extra.length) throw new Error('Usage: verify-current-convergence.ts <request>');
const db = new SqliteDatabase(getDbPath(), { fileMustExist: true }) as Db;
const queue = new AuthQueue({ db, backgroundMaintenance: false,
  executor: async () => { throw new Error('Verification-only recovery cannot execute a command.'); },
  restartFn: () => { throw new Error('Verification-only recovery cannot restart a daemon.'); } });
try {
  const authenticator = new ClientAuthenticator(db, { secretsDir: path.join(getMandibleHome(), 'config/client-auth') });
  const ambient = resolveAmbientProviderIdentity();
  const localManaged = process.env.MANDIBLE_MANAGED_APP && process.env.MANDIBLE_SESSION_ID
    ? { app_name: process.env.MANDIBLE_MANAGED_APP, session_id: process.env.MANDIBLE_SESSION_ID } : null;
  const identity = authenticator.localSocketIdentity(ambient, inManagedSessionContext(), localManaged);
  if (!identity) throw new Error('An active local identity is required.');
  const request = queue.getRequestExact(requestId);
  if (!request?.repo) throw new Error('An exact project-bound request is required.');
  const project = resolveProjectRef(db, request.repo);
  if (!project.ok) throw new Error('Request project is unavailable or ambiguous.');
  const { verification, ...convergence } = await queue.retryHookConvergence(request.id, undefined, { mode: 'verify-current',
    actor: { user_id: identity.user_id, credential_id: null, session_id: identity.session_id ?? null,
      evidence_method: ambient || localManaged ? 'session_claim' : 'local_default', authority_path: 'custodian' } });
  process.stdout.write(JSON.stringify({ request_id: request.id, convergence, verification }) + '\n');
} finally { await queue.dispose(); db.close(); }
