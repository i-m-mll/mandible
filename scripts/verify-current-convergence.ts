import path from 'node:path';
import SqliteDatabase from '../src/sqlite.js';
import { getDbPath, type Db } from '../src/db.js';
import { AuthQueue } from '../src/auth-queue.js';
import { ClientAuthenticator } from '../src/client-auth/authenticator.js';
import { inManagedSessionContext, resolveAmbientProviderIdentity } from '../src/ambient-provider-identity.js';
import { resolveProjectRef } from '../src/ledger/project-registry.js';
import { getMandibleHome } from '../src/platform-paths.js';
import { previewPaintedRuntimeHandoff, readRuntimeHandoff } from './runtime-handoff.mjs';

const [requestRef, operation, proof, ...extra] = process.argv.slice(2);
if (!requestRef || !/^[a-zA-Z0-9-]{7,128}$/.test(requestRef) || extra.length
    || operation !== undefined && operation !== '--preview-painted' && operation !== '--complete-painted'
    || (operation === '--complete-painted' ? !/^[a-f0-9]{64}$/.test(proof ?? '') : proof !== undefined)) {
  throw new Error('Usage: verify-current-convergence.ts <request> [--preview-painted | --complete-painted <proof>]');
}
function resolveRequest(db: SqliteDatabase) {
  const ids = db.prepare('SELECT id FROM auth_requests WHERE id GLOB ? LIMIT 2').all(`${requestRef}*`) as {id:string}[];
  if (ids.length !== 1) throw new Error('An unambiguous exact request is required.');
  return ids[0].id;
}
if (operation === '--preview-painted') {
  const db = new SqliteDatabase(getDbPath(), { readonly: true, fileMustExist: true });
  try {
    const request = resolveRequest(db);
    const hook = db.prepare("SELECT id FROM auth_hook_executions WHERE auth_request_id=? AND hook_id='builtin-mandible-rebuild'").get(request) as {id:string} | undefined;
    const journal = hook && readRuntimeHandoff(getMandibleHome(), request, hook.id);
    if (!journal) throw new Error('An exact recorded runtime handoff is required.');
    process.stdout.write(JSON.stringify(await previewPaintedRuntimeHandoff(journal)) + '\n');
  } finally { db.close(); }
  process.exit(0);
}
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
  const request = queue.getRequestExact(resolveRequest(db));
  if (!request?.repo) throw new Error('An exact project-bound request is required.');
  const project = resolveProjectRef(db, request.repo);
  if (!project.ok) throw new Error('Request project is unavailable or ambiguous.');
  const { verification, supersession, ...convergence } = await queue.retryHookConvergence(request.id, undefined, { mode: 'verify-current', paintedProof: proof,
    actor: { user_id: identity.user_id, credential_id: null, session_id: identity.session_id ?? null,
      evidence_method: ambient || localManaged ? 'session_claim' : 'local_default', authority_path: identity.session_id ? 'custodian' : 'operator' } });
  process.stdout.write(JSON.stringify({ request_id: request.id, convergence, verification, supersession }) + '\n');
} finally { await queue.dispose(); db.close(); }
