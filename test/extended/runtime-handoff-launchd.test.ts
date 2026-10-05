// @vitest-environment node
// This checks the actual old interpreter/launchd admission boundary. The
// integrated production-daemon and desktop gate remains separately required.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import SqliteDatabase from '../../src/sqlite.js';
import { AuthQueue } from '../../src/auth-queue.js';
import { AuthHookManager } from '../../src/auth-hooks.js';
import { renderLaunchAgent } from '../../scripts/local-runtime.mjs';
import { readRuntimeHandoff } from '../../scripts/runtime-handoff.mjs';
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createLedgerProject, createMigratedDb, git, registerWorkRepo } from '../helpers/auth-queue-fixtures.js';
import { publishTestCandidate } from '../helpers/auth-delivery-fixtures.js';
import { sqliteRuntimePaths } from '../../src/sqlite-runtime.js';

const wait = async (predicate: () => boolean, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Isolated launchd fixture did not reach its expected state.');
};
it.skipIf(process.platform !== 'darwin' || !process.env.MANDIBLE_TEST_LEGACY_RUNTIME)('arms one independent helper under loaded legacy Node arguments and survives helper death without build mutation', async () => {
  if (process.platform !== 'darwin') throw new Error('This explicit launchd check requires macOS.');
  // Opt-in exact legacy binary: no Node acquisition or retained Node backend.
  const legacy = process.env.MANDIBLE_TEST_LEGACY_RUNTIME;
  if (!legacy || !fs.existsSync(legacy)) throw new Error('Set MANDIBLE_TEST_LEGACY_RUNTIME to the deployed old interpreter for this check.');
  const repo = createAuthCheckRepo();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-handoff-launchd-'));
  const userHome = path.join(scratch, 'user'); const home = path.join(scratch, 'installation');
  const runtimeDir = path.join(home, 'config/local-sessions'); const services = path.join(runtimeDir, 'launch-agents');
  fs.mkdirSync(services, { recursive: true }); fs.mkdirSync(userHome);
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 8);
  const backend = `bio.mll.mandible.local-session-production.${suffix}`;
  const gateway = `bio.mll.mandible.local-front-door.${suffix}`;
  const domain = `gui/${process.getuid!()}`;
  const control = (args: string[]) => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 5000 });
  const db = createMigratedDb(); let queue: AuthQueue | undefined; let journal: any; let requestRef = ''; let executionRef = ''; let bridgeChild: ReturnType<typeof spawn> | undefined;
  try {
    const sources = ['src/sqlite.ts', 'src/sqlite-runtime.ts', 'src/sqlite-bindings.ts', 'scripts/sqlite-runtime-install.mjs', 'scripts/bun-runtime-lock.tsv', 'cli/production-db-guard.cjs', 'cli/mandible-paths.cjs', 'src/runtime-handoff-proof.ts', 'src/auth-signature-verification.ts', 'src/auth-change-message.ts',
      'scripts/runtime-handoff.mjs', 'scripts/process-group-supervisor.mjs', 'scripts/runtime-log-assessment.mjs', 'scripts/bun-runtime.sh', 'scripts/local-runtime.mjs', 'scripts/canonical-origin.mjs', 'scripts/build-revision.mjs', 'scripts/local-ca-trust.mjs', 'scripts/pinned-caddy.mjs', '.bun-version'];
    const files: Record<string, string> = Object.fromEntries(sources.map(name => [name, fs.readFileSync(path.join(process.cwd(), name), 'utf8')]));
    files['package.json'] = '{"type":"module"}\n'; files['dist/index.js'] = '// Owned admission-only fixture.\n';
    commitOnBranch(repo, 'feature/handoff', files);
    const operator = configureSigningCredential(db, repo, 'ssh_key').operatorId;
    fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n.mandible-test-signing-key*\n');
    registerWorkRepo(db, repo); createLedgerProject(db, repo);
    db.prepare('UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?').run('*', 'exit 75', 'builtin-mandible-rebuild');
    const hooks = new AuthHookManager(db);
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    const request = queue.submit({ type: 'merge', title: 'Isolated runtime handoff', command: 'mandible auth merge feature/handoff --into main', cwd: repo, repo: 'mandible', base_branch: 'main', head_branch: 'feature/handoff', merge_head_sha: git(repo, ['rev-parse', 'feature/handoff']), execution_mode: 'local' });
    await queue.approveWithOperatorProof(request.id, operator);
    const published = publishTestCandidate(repo, queue.getRequest(request.id)!);
    db.prepare('UPDATE auth_requests SET output = ? WHERE id = ?').run(published.output.split('\n').find(line => line.startsWith('MANDIBLE_MERGE_RESULT ')), request.id);
    const hook = hooks.getRun(request.id, 'builtin-mandible-rebuild')!;
    fs.writeFileSync(path.join(home, 'mandible.db'), db.serialize());
    requestRef = request.id; executionRef = hook.id;
    fs.mkdirSync(path.join(home, 'config/client-auth')); fs.writeFileSync(path.join(home, 'config/client-auth/authority-id'), 'isolated-handoff-installation');
    const authority = new SqliteDatabase(path.join(runtimeDir, 'sessions.db'));
    authority.exec('CREATE TABLE instance_registrations(instance_id TEXT, installation_id TEXT, role TEXT, public_origin TEXT, backend_origin TEXT, backend_generation TEXT, effect_ceiling_json TEXT, writable_roots_json TEXT)');
    authority.prepare('INSERT INTO instance_registrations VALUES(?,?,?,?,?,?,?,?)').run('production', 'isolated-handoff-installation', 'main', 'https://app.mandible.localhost:19420', 'http://127.0.0.1:29420', 'a'.repeat(40), '[]', '[]'); authority.close();
    const runner = path.join(runtimeDir, 'production-runner.mjs');
    fs.writeFileSync(runner, "import fs from 'node:fs';fs.writeFileSync(process.env.OLD_MARKER,String(process.pid));setInterval(()=>{},1000);\n");
    const marker = path.join(scratch, 'old-started');
    const backendFile = path.join(services, `${backend}.plist`);
    fs.writeFileSync(backendFile, renderLaunchAgent({ label: backend, programArguments: [legacy, runner, 'run'], workingDirectory: runtimeDir, environment: { HOME: userHome, MANDIBLE_HOME: home, MANDIBLE_PRODUCTION_ROOT: repo, OLD_MARKER: marker, MANDIBLE_LAUNCH_MODE: 'manual' }, stdoutPath: path.join(scratch, 'old.log'), stderrPath: path.join(scratch, 'old.log') }));
    fs.writeFileSync(path.join(services, `${gateway}.plist`), renderLaunchAgent({ label: gateway, programArguments: ['/usr/bin/true', 'fixture'], workingDirectory: runtimeDir, environment: { HOME: userHome }, stdoutPath: path.join(scratch, 'gateway.log'), stderrPath: path.join(scratch, 'gateway.log') }));
    expect(control(['bootstrap', domain, backendFile]).status).toBe(0); await wait(() => fs.existsSync(marker));
    const sqliteFiles = sqliteRuntimePaths();
    const env = { ...process.env, HOME: userHome, MANDIBLE_HOME: home, MANDIBLE_DB: path.join(home, 'mandible.db'), MANDIBLE_RUNTIME: process.execPath,
      MANDIBLE_SQLITE_LIBRARY: sqliteFiles.library, MANDIBLE_SQLITE_LIBRARY_ARCHIVE: sqliteFiles.archive,
      MANDIBLE_AUTH_REQUEST_ID: request.id, MANDIBLE_AUTH_REPO: 'mandible', MANDIBLE_HOOK_ID: hook.hook_id, MANDIBLE_HOOK_EXECUTION_ID: hook.id, MANDIBLE_HOOK_COMMAND_DIGEST: hook.command_digest };
    const arm = () => spawnSync(process.execPath, [path.join(repo, 'scripts/runtime-handoff.mjs'), 'arm', repo], { cwd: repo, env, encoding: 'utf8', timeout: 15000 });
    const result = arm(); expect(result.status, result.stderr).toBe(75);
    journal = readRuntimeHandoff(home, request.id, hook.id);
    expect(journal.bridgeInstalled).toBe(true); expect(journal.binding.oldProcess.pid).toBe(Number(fs.readFileSync(marker, 'utf8')));
    expect(journal.binding.priorBackend.argv[0]).toBe(legacy); expect(journal.binding.mergeCommit).toBe(published.mergeSha);
    expect(journal.stages).toEqual({}); expect(fs.readFileSync(runner, 'utf8')).toContain('dependency-free');
    bridgeChild = spawn(legacy, [runner, 'run'], { env, stdio: 'ignore' });
    const bridgeMarker = path.join(path.dirname(path.join(runtimeDir, 'handoff', `${request.id}-${hook.id}`, 'journal.json')), 'bridge-process.json');
    await wait(() => fs.existsSync(bridgeMarker) && JSON.parse(fs.readFileSync(bridgeMarker, 'utf8')).pid === bridgeChild?.pid);
    expect(bridgeChild.exitCode).toBeNull();
    bridgeChild.kill('SIGTERM'); await wait(() => bridgeChild?.signalCode === 'SIGTERM');
    const target = `${domain}/${journal.helperLabel}`;
    const before = journal.acknowledgedAt;
    expect(control(['kill', 'SIGKILL', target]).status).toBe(0);
    await wait(() => (readRuntimeHandoff(home, request.id, hook.id)?.acknowledgedAt ?? 0) > before);
    const replay = arm(); expect(replay.status, replay.stderr).toBe(75);
    expect(readRuntimeHandoff(home, request.id, hook.id)?.bindingDigest).toBe(journal.bindingDigest);
    expect(readRuntimeHandoff(home, request.id, hook.id)?.stages).toEqual({});
  } finally {
    if (bridgeChild && bridgeChild.exitCode === null && bridgeChild.signalCode === null) bridgeChild.kill('SIGTERM');
    if (requestRef && executionRef) {
      const helperLabel = `bio.mll.mandible.runtime-handoff.${createHash('sha256').update(`${home}:${requestRef}:${executionRef}`).digest('hex').slice(0, 16)}`;
      control(['bootout', `${domain}/${helperLabel}`]);
    }
    control(['bootout', `${domain}/${backend}`]); queue?.dispose(); db.close();
    fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
}, 60000);
