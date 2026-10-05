// @vitest-environment node
// Explicit integration gate. It runs the actual archived old daemon, then
// lets its finalizer arm a handoff, then exercises its real signal/drain path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import SqliteDatabase from '../../src/sqlite.js';
import type { AuthQueue } from '../../src/auth-queue.js';
import { setupOperator } from '../../src/users/store.js';
import { localCaPaths, assertLocalCaIdentity, probeCurrentMacOsTrust } from '../../scripts/local-ca-trust.mjs';
import { readRuntimeHandoff } from '../../scripts/runtime-handoff.mjs';
import { configureSigningCredential, createAuthCheckRepo, createLedgerProject, git, registerWorkRepo } from '../helpers/auth-queue-fixtures.js';
import { publishTestCandidate } from '../helpers/auth-delivery-fixtures.js';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
function command(binary: string, args: string[], options: any = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.status !== 0 || result.error) throw new Error(`${binary} ${args[0]}: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout;
}
async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function until(predicate: () => Promise<boolean> | boolean, timeout: number, label: string) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`${label} did not complete within ${timeout}ms`);
}
function archive(source: string, revision: string, destination: string) {
  const bytes = command('git', ['archive', revision], { cwd: source, encoding: null, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  command('/usr/bin/tar', ['-x', '-C', destination], { input: bytes });
}
function configurePorts(root: string, runtime: string, ports: { public: number; backend: number; admin: number }, env: NodeJS.ProcessEnv) {
  fs.writeFileSync(path.join(root, 'config/canonical-origin.json'), `${JSON.stringify({ production_origin: `https://app.mandible.localhost:${ports.public}`, default_backend_port: ports.backend }, null, 2)}\n`);
  const gateway = path.join(root, 'scripts/local-front-door.mjs');
  const text = fs.readFileSync(gateway, 'utf8');
  if (!text.includes('admin 127.0.0.1:2019')) throw new Error('Fixture admin-port transform requires review for this source revision.');
  fs.writeFileSync(gateway, text.replaceAll('admin 127.0.0.1:2019', `admin 127.0.0.1:${ports.admin}`));
  const generator = path.join(root, 'scripts/generate-canonical-origin.mjs');
  const generatorSource = fs.readFileSync(generator, 'utf8');
  if (!generatorSource.includes('origin.port !== "19420"')) throw new Error('Fixture origin guard transform requires review for this source revision.');
  fs.writeFileSync(generator, generatorSource.replace('origin.port !== "19420"', `origin.port !== "${ports.public}"`));
  command(runtime, ['scripts/generate-canonical-origin.mjs'], { cwd: root, env });
}
it('hands the actual old daemon over to the candidate through isolated production supervision', async () => {
  const oldRoot = process.env.MANDIBLE_TEST_OLD_CHECKOUT;
  const legacy = process.env.MANDIBLE_TEST_LEGACY_RUNTIME;
  const candidateRef = process.env.MANDIBLE_TEST_CANDIDATE_REVISION;
  const sourceHome = process.env.MANDIBLE_TEST_CA_HOME;
  const archivePath = process.env.MANDIBLE_RUNTIME_ARCHIVE;
  if (process.platform !== 'darwin' || !oldRoot || !legacy || !candidateRef || !sourceHome || !archivePath) throw new Error('Full upgrade gate requires macOS and all documented old/candidate/runtime/CA inputs.');
  const candidate = command('git', ['rev-parse', '--verify', `${candidateRef}^{commit}`], { cwd: process.cwd(), env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const oldMarker = JSON.parse(fs.readFileSync(path.join(oldRoot, 'dist/build-revision.json'), 'utf8'));
  const oldRevision = process.env.MANDIBLE_TEST_OLD_REVISION || oldMarker.commit;
  const sourceCa = localCaPaths(sourceHome); expect(assertLocalCaIdentity(sourceCa).state).toBe('trusted'); probeCurrentMacOsTrust(sourceCa);
  const runtime = command('/bin/sh', ['scripts/bun-runtime.sh'], { cwd: process.cwd(), env: process.env }).trim();
  // Node resolves imported module URLs through macOS /var symlinks. Use the
  // same real paths in its argv and launch definition so the deployed main
  // entry guard actually starts the daemon.
  const repo = fs.realpathSync(createAuthCheckRepo());
  // Keep HOME short enough for macOS's Unix-domain socket path limit.
  const scratch = fs.realpathSync(fs.mkdtempSync('/tmp/mandible-upgrade-'));
  const userHome = path.join(scratch, 'user'); const home = path.join(scratch, 'installation');
  fs.mkdirSync(userHome); fs.mkdirSync(home);
  const ports = { public: await freePort(), backend: await freePort(), admin: await freePort() };
  const env = { USER: process.env.USER, LANG: process.env.LANG || 'en_US.UTF-8', SHELL: '/bin/zsh', NODE_ENV: 'production', CI: 'true', TERM: 'dumb', HOME: userHome, MANDIBLE_HOME: home,
    MANDIBLE_DB: path.join(home, 'mandible.db'), MANDIBLE_PORT: String(ports.backend), MANDIBLE_WORK_SCANNER_ROOTS: JSON.stringify([{ path: repo, depth: 0 }]),
    MANDIBLE_RUNTIME: runtime, MANDIBLE_RUNTIME_ARCHIVE: archivePath, PATH: `${path.dirname(runtime)}:${process.env.PATH}`, GIT_OPTIONAL_LOCKS: '0' };
  const libraryInputs = Object.fromEntries(['MANDIBLE_SQLITE_LIBRARY', 'MANDIBLE_SQLITE_LIBRARY_ARCHIVE'].filter(key => process.env[key]).map(key => [key, process.env[key]!]));
  Object.assign(env, libraryInputs);
  const suffix = digest(home).slice(0, 8); const domain = `gui/${process.getuid!()}`;
  const backendLabel = `bio.mll.mandible.local-session-production.${suffix}`; const gatewayLabel = `bio.mll.mandible.local-front-door.${suffix}`;
  const ledger = path.join(home, 'mandible.db'); let db: SqliteDatabase | undefined; let queue: AuthQueue | undefined; let requestId = ''; let executionId = ''; let journal: any;
  const evidence = path.join(os.homedir(), '.cache', 'mandible/acceptance/upgrade-evidence'); fs.mkdirSync(evidence, { recursive: true });
  try {
    // Reuse the installed build toolchain, while cloning dependency cache bytes
    // into the disposable home. Neither operation changes user configuration.
    for (const name of ['.cargo', '.rustup']) {
      const source = fs.realpathSync(path.join(os.homedir(), name));
      fs.symlinkSync(source, path.join(userHome, name), 'dir');
    }
    const bunCache = path.join(os.homedir(), '.bun/install/cache');
    if (!fs.existsSync(bunCache)) throw new Error('Full fixture requires the qualified dependency cache from frozen installation.');
    fs.mkdirSync(path.join(userHome, '.bun/install'), { recursive: true });
    command('/bin/cp', ['-c', '-R', bunCache, path.join(userHome, '.bun/install/cache')]);
    archive(oldRoot, oldRevision, repo);
    command('/bin/cp', ['-c', '-R', path.join(oldRoot, 'node_modules'), path.join(repo, 'node_modules')]);
    configurePorts(repo, legacy, ports, env);
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'Actual old daemon with isolated connection ports']);
    command(legacy, ['node_modules/typescript/bin/tsc'], { cwd: repo, env });
    command(legacy, ['scripts/build-revision.mjs', 'write'], { cwd: repo, env });
    // Author the fixture request with the deployed old contracts. Using the
    // candidate queue against the old schema would require premature migration
    // and skip the real upgrade's migration boundary.
    const { AuthQueue: LegacyAuthQueue } = await import(pathToFileURL(path.join(repo, 'dist/auth-queue.js')).href);
    const { AuthHookManager: LegacyAuthHookManager } = await import(pathToFileURL(path.join(repo, 'dist/auth-hooks.js')).href);
    const ca = localCaPaths(home);
    fs.mkdirSync(path.dirname(ca.installationAuthority), { recursive: true }); fs.copyFileSync(sourceCa.installationAuthority, ca.installationAuthority);
    fs.cpSync(sourceCa.storageRoot, ca.storageRoot, { recursive: true });
    const receipt = JSON.parse(fs.readFileSync(sourceCa.receipt, 'utf8'));
    fs.writeFileSync(ca.receipt, JSON.stringify({ ...receipt, storage_root: ca.storageRoot, fixture_source_digest: digest(fs.readFileSync(sourceCa.receipt)) }), { mode: 0o600 });
    command(legacy, ['scripts/local-runtime.mjs', 'install', '--root', repo], { cwd: repo, env });
    command(legacy, ['scripts/local-runtime.mjs', 'start'], { cwd: repo, env });
    await until(async () => { try { const r = await fetch(`http://127.0.0.1:${ports.backend}/api/health`); return (await r.json()).ready === true; } catch { return false; } }, 30000, 'Actual old daemon readiness');
    const oldJob = command('/bin/launchctl', ['print', `${domain}/${backendLabel}`]); expect(oldJob).toContain(legacy);
    // Replace tracked sources only. Old dist/dependencies remain intact until
    // the independently supervised helper observes the old process exit.
    const oldFiles = git(repo, ['ls-files', '-z']).split('\0').filter(Boolean);
    for (const file of oldFiles) fs.rmSync(path.join(repo, file), { force: true });
    archive(process.cwd(), candidate, repo); configurePorts(repo, runtime, ports, env);
    git(repo, ['checkout', '-b', 'feature/actual-upgrade']); git(repo, ['add', '-A']); git(repo, ['commit', '-m', 'Candidate source with the same isolated connection ports']); git(repo, ['checkout', 'main']);
    db = new SqliteDatabase(ledger);
    setupOperator(db, { slug: 'isolated-upgrade-operator', display_name: 'Isolated Upgrade Operator' });
    const signing = configureSigningCredential(db, repo, 'ssh_key'); fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n.mandible-test-signing-key*\n');
    const fixtureHooks = path.join(repo, '.git/fixture-hooks'); fs.mkdirSync(fixtureHooks);
    git(repo, ['config', 'core.hooksPath', fixtureHooks]);
    registerWorkRepo(db, repo); createLedgerProject(db, repo);
    const nativeApp = path.join(scratch, 'Mandible.app');
    const hookCommand = `MANDIBLE_HOME=${quote(home)} MANDIBLE_RUNTIME=${quote(runtime)} MANDIBLE_RUNTIME_ARCHIVE=${quote(archivePath)} MANDIBLE_DESKTOP_INSTALL_PATH=${quote(nativeApp)} ${Object.entries(libraryInputs).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} bash cli/post-merge-build-dist.sh`;
    db.prepare('UPDATE auth_hooks SET command = ?, repo_pattern = ? WHERE id = ?').run(hookCommand, '*', 'builtin-mandible-rebuild');
    const hooks = new LegacyAuthHookManager(db);
    queue = new LegacyAuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    const request = queue.submit({ type: 'merge', title: 'Actual isolated upgrade', command: 'mandible auth merge feature/actual-upgrade --into main', cwd: repo, repo: 'mandible', base_branch: 'main', head_branch: 'feature/actual-upgrade', merge_head_sha: git(repo, ['rev-parse', 'feature/actual-upgrade']), execution_mode: 'local' });
    expect(request.repo).toBe('mandible');
    await queue.approveWithOperatorProof(request.id, signing.operatorId);
    const publication = publishTestCandidate(repo, queue.getRequest(request.id)!); const hook = hooks.getRun(request.id, 'builtin-mandible-rebuild')!;
    requestId = request.id; executionId = hook.id;
    // This is a signed fixture publication, never a production approval. The
    // actual old daemon discovers it through its deployed finalizer sweep.
    db.prepare("UPDATE auth_requests SET status='completed', exit_code=0, output=?, merge_finalized_at=NULL WHERE id=?").run(`${publication.output.split('\n').find(line => line.startsWith('MANDIBLE_MERGE_RESULT '))}\n`, request.id);
    await until(() => { journal = readRuntimeHandoff(home, request.id, hook.id); return !!journal?.bridgeInstalled; }, 60000, 'Actual old daemon handoff admission');
    // A periodic finalizer recovery does not schedule the normal execution's
    // self-merge exit. Signal this exact private daemon after admission so its
    // actual shutdown handler drains; the helper still must await its death.
    const oldProcess = journal.binding.oldProcess;
    expect(command('/bin/ps', ['-p', String(oldProcess.pid), '-o', 'lstart=']).trim()).toBe(oldProcess.startedAt);
    process.kill(oldProcess.pid, 'SIGTERM');
    await until(() => {
      journal = readRuntimeHandoff(home, request.id, hook.id);
      if (journal?.phase === 'failed') throw new Error(journal.error);
      const attempt = db!.prepare('SELECT exit_code, output FROM auth_hook_executions WHERE id=?').get(hook.id) as any;
      if (!journal && attempt?.exit_code != null && ![0, 75].includes(attempt.exit_code)) throw new Error(`Old daemon hook refused handoff: ${attempt.output}`);
      return journal?.phase === 'complete' || journal?.phase === 'acknowledged';
    }, 15 * 60 * 1000, 'Actual old-to-candidate convergence');
    await until(() => readRuntimeHandoff(home, request.id, hook.id)?.phase === 'acknowledged', 60000, 'Candidate hook receipt acknowledgment');
    const row = db.prepare('SELECT state, exit_code FROM auth_hook_executions WHERE id=?').get(hook.id) as any; expect(row.state).toBe('complete'); expect(row.exit_code).toBe(0);
    const newJob = command('/bin/launchctl', ['print', `${domain}/${backendLabel}`]); expect(newJob).toContain(runtime); expect(newJob).not.toContain(legacy);
    fs.writeFileSync(path.join(evidence, `${Date.now()}.json`), JSON.stringify({ status: 'passed', oldRevision, candidateRevision: candidate, fixturePorts: ports, runtimeHash: digest(fs.readFileSync(runtime)), oldLoadedDefinitionHash: digest(oldJob), newLoadedDefinitionHash: digest(newJob), journal: readRuntimeHandoff(home, request.id, hook.id), sourceTransforms: ['private frontend/backend ports generated from config', 'private Caddy admin port'], shutdownTrigger: 'SIGTERM to exact bound private old daemon after handoff admission', note: 'Actual daemon transition; exact unmodified candidate paired desktop gate remains separately required.' }, null, 2));
  } catch (error) {
    const logs = [path.join(scratch, '.cache/mandible/production-stderr.log'), ...(requestId ? [path.join(home, 'config/local-sessions/handoff', `${requestId}-${executionId}`, 'convergence.log')] : [])].filter(file => fs.existsSync(file)).map(file => ({ name: path.basename(file), sha256: digest(fs.readFileSync(file)), excerpt: fs.readFileSync(file, 'utf8').slice(-16000) }));
    fs.writeFileSync(path.join(evidence, `${Date.now()}-failed.json`), JSON.stringify({ status: 'failed', oldRevision, candidateRevision: candidate, error: String(error), logs, journal: requestId ? readRuntimeHandoff(home, requestId, executionId) : null }, null, 2)); throw error;
  } finally {
    if (requestId) spawnSync('/bin/launchctl', ['bootout', `${domain}/bio.mll.mandible.runtime-handoff.${digest(`${home}:${requestId}:${executionId}`).slice(0, 16)}`], { timeout: 5000 });
    for (const label of [backendLabel, gatewayLabel]) spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { timeout: 5000 });
    queue?.dispose(); db?.close(); fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
}, 20 * 60 * 1000);
