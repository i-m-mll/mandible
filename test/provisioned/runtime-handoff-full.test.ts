// @provisioned launchd
// @vitest-environment node
// The pre-merge run of the real post-merge handoff under launchd: the deployed
// daemon, archived from the canonical root, converges on the candidate through
// one ordinary signed delivery and its post-merge-build-dist hook.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import SqliteDatabase from '../../src/sqlite.js';
import { createUser, setupOperator } from '../../src/users/store.js';
import { localCaPaths, assertLocalCaIdentity, probeCurrentMacOsTrust } from '../../scripts/local-ca-trust.mjs';
import { readRuntimeHandoff } from '../../scripts/runtime-handoff.mjs';
import { parseLoadedService, loadedServiceMatches } from '../../scripts/local-runtime.mjs';
import { configureSigningCredential, createAuthCheckRepo, createLedgerProject, git, registerWorkRepo } from '../helpers/auth-queue-fixtures.js';
import { createLedgerIssue } from '../helpers/auth-queue-fixtures.js';
import { addGrant } from '../../src/permissions/store.js';
import { loadOrCreatePepper } from '../../src/client-auth/secret-store.js';
import { mintApiToken } from '../../src/client-auth/tokens.js';
import { setSetting } from '../../src/client-auth/settings-kv.js';
import { activateBootstrapWorkUnit, submitBootstrapDelivery, acceptBootstrapDelivery, approveBootstrapDelivery, readBootstrapDelivery, assertBootstrapOperatorProof } from '../helpers/bootstrap-delivery-api.js';

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
function prerequisite<T>(value: T | null | undefined | false, name: string): T {
  if (!value) throw new Error(`Full handoff gate prerequisite missing: ${name}`);
  return value;
}

it('converges the deployed daemon on the candidate through one ordinary signed delivery', async () => {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  // The canonical root holds the deployed build; its marker names the old revision.
  const oldRoot = path.dirname(command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: process.cwd(), env: gitEnv }).trim());
  const markerPath = path.join(oldRoot, 'dist/build-revision.json');
  const oldMarker = JSON.parse(fs.readFileSync(prerequisite(fs.existsSync(markerPath) && markerPath, `deployed build marker ${markerPath}`), 'utf8'));
  const oldRevision = prerequisite(oldMarker.commit as string | undefined, `commit in ${markerPath}`);
  const candidate = command('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: process.cwd(), env: gitEnv }).trim();
  // The runner isolates HOME, and Bun's os.userInfo() follows HOME, so the
  // operator's account home comes from the account database, as in bun-runtime.sh.
  const operatorHome = command('/bin/sh', ['-c', 'eval "printf %s ~$(id -un)"']);
  prerequisite(path.isAbsolute(operatorHome) && operatorHome !== os.homedir() && operatorHome, `the operator account home (got ${operatorHome})`);
  // The operator's installation: the default durable root of cli/mandible-paths.cjs.
  const sourceHome = path.join(operatorHome, '.mandible');
  const buildHome = operatorHome;
  const runtime = command('/bin/sh', ['scripts/bun-runtime.sh'], { cwd: process.cwd(), env: process.env }).trim();
  const archivePath = command('/bin/sh', ['scripts/bun-runtime.sh', '--archive'], { cwd: process.cwd(), env: process.env }).trim();
  prerequisite(fs.existsSync(archivePath) && archivePath, `pinned Bun runtime archive ${archivePath}`);
  const sourceCa = localCaPaths(sourceHome); expect(assertLocalCaIdentity(sourceCa).state).toBe('trusted'); probeCurrentMacOsTrust(sourceCa);
  // Use real paths in argv and launch definitions so the deployed main entry
  // guard actually starts the daemon.
  // Keep HOME short enough for macOS's Unix-domain socket path limit.
  const scratch = fs.realpathSync(fs.mkdtempSync('/tmp/mandible-upgrade-'));
  const repo = path.join(scratch, 'mandible');
  const initialRepo = createAuthCheckRepo(); fs.cpSync(initialRepo, repo, { recursive: true }); fs.rmSync(initialRepo, { recursive: true, force: true });
  const userHome = path.join(scratch, 'user'); const home = path.join(scratch, 'installation');
  fs.mkdirSync(userHome); fs.mkdirSync(home);
  const privateKeychain = path.join(scratch, 'executor.keychain-db');
  const securityAdapter = path.join(scratch, 'private-security');
  const keychainSelector = (operation: string) => {
    const result = spawnSync('/usr/bin/security', [operation, '-d', 'user'], { encoding: 'utf8', timeout: 5000 });
    if (result.error) throw new Error('Native Keychain selector inspection failed.');
    return JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr });
  };
  const keychainSearchBefore = keychainSelector('list-keychains');
  const keychainDefaultBefore = keychainSelector('default-keychain');
  fs.writeFileSync(securityAdapter, `#!/bin/sh
set -eu
[ "$1" = find-generic-password ] && [ "$2" = -s ] && [ "$3" = mandible-operator ] || exit 2
case "$#" in 3) ;; 4) [ "$4" = -w ] || exit 2 ;; *) exit 2 ;; esac
exec /usr/bin/security "$@" ${quote(privateKeychain)}
`, { mode: 0o700 });
  const ports = { public: await freePort(), backend: await freePort(), admin: await freePort() };
  const env = { USER: process.env.USER, LANG: process.env.LANG || 'en_US.UTF-8', SHELL: '/bin/zsh', NODE_ENV: 'production', CI: 'true', TERM: 'dumb', HOME: userHome, MANDIBLE_HOME: home, MANDIBLE_SERVICE_ACCOUNT_HOME: userHome,
    MANDIBLE_DB: path.join(home, 'mandible.db'), MANDIBLE_PORT: String(ports.backend), MANDIBLE_WORK_SCANNER_ROOTS: JSON.stringify([{ path: repo, depth: 0 }]),
    MANDIBLE_SECURITY_BIN: securityAdapter, MANDIBLE_RUNTIME: runtime, MANDIBLE_RUNTIME_ARCHIVE: archivePath, PATH: `${path.dirname(runtime)}:${process.env.PATH}`, GIT_OPTIONAL_LOCKS: '0' };
  const libraryInputs = Object.fromEntries(['MANDIBLE_SQLITE_LIBRARY', 'MANDIBLE_SQLITE_LIBRARY_ARCHIVE'].filter(key => process.env[key]).map(key => [key, process.env[key]!]));
  Object.assign(env, libraryInputs);
  const suffix = digest(home).slice(0, 8); const domain = `gui/${process.getuid!()}`;
  const backendLabel = `bio.mll.mandible.local-session-production.${suffix}`; const gatewayLabel = `bio.mll.mandible.local-front-door.${suffix}`;
  const ledger = path.join(home, 'mandible.db'); let db: SqliteDatabase | undefined; let candidateRoot = ''; let requestId = ''; let executionId = ''; let journal: any;
  const evidence = path.join(buildHome, '.cache', 'mandible/acceptance/upgrade-evidence'); fs.mkdirSync(evidence, { recursive: true });
  try {
    // Reuse the installed build toolchain, while cloning dependency cache bytes
    // into the disposable home. Neither operation changes user configuration.
    for (const name of ['.cargo', '.rustup']) {
      const source = fs.realpathSync(prerequisite(fs.existsSync(path.join(buildHome, name)) && path.join(buildHome, name), `toolchain ${path.join(buildHome, name)}`));
      fs.symlinkSync(source, path.join(userHome, name), 'dir');
    }
    const bunCache = path.join(buildHome, '.bun/install/cache');
    prerequisite(fs.existsSync(bunCache), `dependency cache ${bunCache} from a frozen install`);
    fs.mkdirSync(path.join(userHome, '.bun/install'), { recursive: true });
    command('/bin/cp', ['-c', '-R', bunCache, path.join(userHome, '.bun/install/cache')]);
    archive(oldRoot, oldRevision, repo);
    command('/bin/cp', ['-c', '-R', path.join(oldRoot, 'node_modules'), path.join(repo, 'node_modules')]);
    configurePorts(repo, runtime, ports, env);
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'Actual old daemon with isolated connection ports']);
    command(runtime, ['node_modules/typescript/bin/tsc'], { cwd: repo, env });
    command(runtime, ['scripts/build-revision.mjs', 'write'], { cwd: repo, env });
    const ca = localCaPaths(home);
    fs.mkdirSync(path.dirname(ca.installationAuthority), { recursive: true }); fs.copyFileSync(sourceCa.installationAuthority, ca.installationAuthority);
    fs.cpSync(sourceCa.storageRoot, ca.storageRoot, { recursive: true });
    const receipt = JSON.parse(fs.readFileSync(sourceCa.receipt, 'utf8'));
    fs.writeFileSync(ca.receipt, JSON.stringify({ ...receipt, storage_root: ca.storageRoot, fixture_source_digest: digest(fs.readFileSync(sourceCa.receipt)) }), { mode: 0o600 });
    const serviceConfig = path.join(home, 'config/local-sessions/service-config.json');
    fs.mkdirSync(path.dirname(serviceConfig), { recursive: true });
    fs.writeFileSync(serviceConfig, JSON.stringify({ environment: { MANDIBLE_DB: ledger, MANDIBLE_SECURITY_BIN: securityAdapter, ...libraryInputs }, toolDirectories: [] }), { mode: 0o600 });
    command(runtime, ['scripts/local-runtime.mjs', 'install', '--root', repo], { cwd: repo, env });
    command(runtime, ['scripts/local-runtime.mjs', 'start'], { cwd: repo, env });
    await until(async () => { try { const r = await fetch(`http://127.0.0.1:${ports.backend}/api/health`); return (await r.json()).ready === true; } catch { return false; } }, 30000, 'Actual old daemon readiness');
    const oldJob = command('/bin/launchctl', ['print', `${domain}/${backendLabel}`]); expect(oldJob).toContain(runtime);
    const oldGatewayJob = command('/bin/launchctl', ['print', `${domain}/${gatewayLabel}`]);
    // The candidate is a worktree branch of the canonical root; the reviewed
    // delivery merges it there and the post-merge hook rebuilds in place.
    const wt = fs.existsSync(path.join(buildHome, '.dotfiles/bin/wt')) ? path.join(buildHome, '.dotfiles/bin/wt') : 'wt';
    command(wt, ['new', 'feature/actual-upgrade', 'main', '--no-issue'], { cwd: repo, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const worktrees = git(repo, ['worktree', 'list', '--porcelain']);
    const candidateBlock = worktrees.split('\n\n').find(block => block.includes('branch refs/heads/feature/actual-upgrade'));
    if (!candidateBlock) throw new Error('wt did not register the candidate executor checkout.');
    candidateRoot = fs.realpathSync(candidateBlock.split('\n').find(line => line.startsWith('worktree '))!.slice(9));
    for (const file of git(candidateRoot, ['ls-files', '-z']).split('\0').filter(Boolean)) fs.rmSync(path.join(candidateRoot, file), { force: true });
    archive(process.cwd(), candidate, candidateRoot); configurePorts(candidateRoot, runtime, ports, env);
    git(candidateRoot, ['add', '-A']); git(candidateRoot, ['commit', '-m', 'Candidate source with isolated connection ports']);
    const nativeApp = path.join(scratch, 'Mandible.app');
    const poisonedShim = path.join(userHome, '.dotfiles/bin/mandible'); fs.mkdirSync(path.dirname(poisonedShim), { recursive: true });
    const poisonMarker = path.join(scratch, 'old-cli-used');
    fs.writeFileSync(poisonedShim, `#!/bin/sh\necho old-cli > ${quote(poisonMarker)}\necho poisoned-old-cli >&2\nexit 97\n`, { mode: 0o700 });
    const inheritedPath = `${path.dirname(poisonedShim)}:${process.env.PATH}`;
    const installedPath = `${repo}/bin:${path.dirname(runtime)}:${userHome}/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`;
    expect(command('/bin/sh', ['-c', 'command -v mandible'], { env: { ...env, PATH: inheritedPath } }).trim()).toBe(poisonedShim);
    expect(command('/bin/sh', ['-c', 'command -v mandible'], { env: { ...env, PATH: installedPath } }).trim()).toBe(`${repo}/bin/mandible`);
    const sourceManifest = { revision: git(candidateRoot, ['rev-parse', 'HEAD']), cliSha256: digest(fs.readFileSync(path.join(candidateRoot, 'bin/mandible'))), installedPath };
    const bootstrapJob = command('/bin/launchctl', ['print', `${domain}/${backendLabel}`]);
    expect(bootstrapJob).toBe(oldJob); expect(bootstrapJob).toContain(repo);
    for (const label of [backendLabel, gatewayLabel]) {
      const detail = command('/bin/launchctl', ['print', `${domain}/${label}`]);
      const definitionPath = detail.split('\n').map(line => line.trim()).find(line => line.startsWith('path = '))?.slice(7);
      expect(definitionPath).toBeTruthy();
      const definition = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', definitionPath!]));
      expect(loadedServiceMatches(definition, parseLoadedService(detail))).toBe(true);
    }
    expect(digest(fs.readFileSync(path.join(candidateRoot, 'bin/mandible')))).toBe(sourceManifest.cliSha256);
    // Use supported setup mechanisms for private identities and custody. Auth
    // request publication and approval are exclusively ordinary HTTP routes.
    db = new SqliteDatabase(ledger);
    setupOperator(db, { slug: 'isolated-upgrade-operator', display_name: 'Isolated Upgrade Operator' });
    const signing = configureSigningCredential(db, repo, 'ssh_key'); fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\n.mandible-test-signing-key*\n');
    git(repo, ['config', 'commit.gpgsign', 'true']);
    registerWorkRepo(db, repo); const registered = createLedgerProject(db, repo);
    const issue = createLedgerIssue(db, registered.project.id, 'bootstrap-private', 'Private exact candidate bootstrap');
    const agent = createUser(db, { slug: 'bootstrap-agent', display_name: 'Private Bootstrap Agent', kind: 'agent' });
    addGrant(db, { subject_type: 'user', subject: agent.id, resource_type: 'project', resource: registered.project.id, permission: 'write' });
    const pepper = loadOrCreatePepper(db, path.join(home, 'config/client-auth'));
    const agentToken = mintApiToken(db, pepper, agent.id); const operatorToken = mintApiToken(db, pepper, signing.operatorId);
    // Real native Keychain lookup, scoped to an owned file. Secret material
    // travels only through stdin/memory; no default/search-list mutation.
    const batchQuote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const keychainPassword = randomBytes(32).toString('hex');
    const keychainBatch = [
      `create-keychain -p ${batchQuote(keychainPassword)} ${batchQuote(privateKeychain)}`,
      `unlock-keychain -p ${batchQuote(keychainPassword)} ${batchQuote(privateKeychain)}`,
      `add-generic-password -s mandible-operator -a ${batchQuote('isolated-upgrade-operator')} -T /usr/bin/security -w ${batchQuote(operatorToken.token)} ${batchQuote(privateKeychain)}`,
    ].join('\n') + '\n';
    const provision = spawnSync('/usr/bin/security', ['-i'], { input: keychainBatch, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10000 });
    if (provision.status !== 0 || provision.error) throw new Error('Private native Keychain provisioning failed.');
    const lookup = spawnSync(securityAdapter, ['find-generic-password', '-s', 'mandible-operator', '-w'], { encoding: 'utf8', timeout: 10000 });
    if (lookup.status !== 0 || lookup.stdout.trim() !== operatorToken.token) throw new Error('Private native Keychain credential readback failed.');
    expect(keychainSelector('list-keychains')).toBe(keychainSearchBefore);
    expect(keychainSelector('default-keychain')).toBe(keychainDefaultBefore);
    const baseUrl = `http://127.0.0.1:${ports.backend}`;
    const agentApi = { baseUrl, headers: { Authorization: `Bearer ${agentToken.token}` } };
    const operatorApi = { baseUrl, headers: { Authorization: `Bearer ${operatorToken.token}` } };
    // Preserve the actual configured native hook bytes in the private repo.
    const fixtureHooks = path.join(repo, '.git/fixture-hooks'); fs.mkdirSync(fixtureHooks);
    const nativeHooks = ['post-commit', 'post-merge'].map(name => {
      const bytes = fs.readFileSync(path.join(buildHome, '.config/git/hooks', name));
      fs.writeFileSync(path.join(fixtureHooks, name), bytes, { mode: 0o700 }); return { name, sha256: digest(bytes) };
    });
    git(repo, ['config', 'core.hooksPath', fixtureHooks]);
    const hookCommand = `MANDIBLE_HOME=${quote(home)} MANDIBLE_SERVICE_ACCOUNT_HOME=${quote(userHome)} MANDIBLE_RUNTIME=${quote(runtime)} MANDIBLE_RUNTIME_ARCHIVE=${quote(archivePath)} MANDIBLE_DESKTOP_INSTALL_PATH=${quote(nativeApp)} ${Object.entries(libraryInputs).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} bash cli/post-merge-build-dist.sh`;
    db.prepare('UPDATE auth_hooks SET command = ?, repo_pattern = ? WHERE id = ?').run(hookCommand, '*', 'builtin-mandible-rebuild');
    const xattrPoison = path.join(path.dirname(poisonedShim), 'xattr');
    const xattrMarker = path.join(scratch, 'wrong-xattr-used');
    fs.writeFileSync(xattrPoison, `#!/bin/sh\necho wrong-xattr > ${quote(xattrMarker)}\nexit 96\n`, { mode: 0o700 });
    // The installer must establish native-tool precedence even when the real
    // launchd executor gives its hook an incompatible inherited xattr.
    setSetting(db, 'auth_hooks.path', `${repo}/bin:${path.dirname(runtime)}:${path.dirname(xattrPoison)}:${installedPath}`);
    const workUnitId = await activateBootstrapWorkUnit(agentApi, issue.id, 'mandible', 'feature/actual-upgrade');
    const verification = 'Private candidate bootstrap is ready at the retained exact source revision.';
    const request = await submitBootstrapDelivery({ ...agentApi, cwd: repo, repo: 'mandible', headBranch: 'feature/actual-upgrade', baseBranch: 'main', headSha: sourceManifest.revision, baseSha: git(repo, ['rev-parse', 'main']), issueRef: issue.id, workUnitId, requesterCredentialId: agentToken.credential.id, verification,
      commitMessage: `Merge qualified candidate bootstrap\n\nWhy: Converge the private installation on the approved canonical checkout.\n\nVerification:\n${verification}\n` });
    requestId = request.id;
    // Prove the service definition overrides an inherited old CLI selection.
    expect(installedPath.split(':')[0]).toBe(`${repo}/bin`);
    await acceptBootstrapDelivery(agentApi, request.id);
    // Owned drift introduced after acceptance must be absorbed by the ordinary
    // signed self-update. Neither repair nor retry is part of this flow.
    for (const label of [backendLabel, gatewayLabel]) {
      const detail = command('/bin/launchctl', ['print', `${domain}/${label}`]);
      const file = detail.split('\n').map(line => line.trim()).find(line => line.startsWith('path = '))?.slice(7);
      expect(file).toBeTruthy();
      const bytes = fs.readFileSync(file!, 'utf8');
      expect(bytes).toContain('<key>PATH</key><string>');
      fs.writeFileSync(file!, bytes.replace('<key>PATH</key><string>', '<key>PATH</key><string>/private-owned-drift:'));
      const installed = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file!]));
      expect(loadedServiceMatches(installed, parseLoadedService(detail))).toBe(false);
    }
    await approveBootstrapDelivery(operatorApi, request.id);
    await until(() => {
      const hook = db!.prepare('SELECT id, exit_code, output FROM auth_hook_executions WHERE auth_request_id=? AND hook_id=?').get(request.id, 'builtin-mandible-rebuild') as any;
      if (hook) executionId = hook.id;
      journal = executionId ? readRuntimeHandoff(home, request.id, executionId) : null;
      if (journal?.phase === 'failed') throw new Error(journal.error);
      if (hook?.exit_code != null && ![0, 75].includes(hook.exit_code)) throw new Error(`Handoff admission hook failed: ${hook.output}`);
      const state = db!.prepare('SELECT status, exit_code, error, output FROM auth_requests WHERE id=?').get(request.id) as any;
      if (state && (state.status === 'rejected' || (state.status === 'completed' && state.exit_code !== 0)) && !journal?.bridgeInstalled) throw new Error(`Request ended before handoff: ${JSON.stringify({ ...state, output: state.output?.slice(-16000) })}`);
      return !!journal?.bridgeInstalled;
    }, 60000, 'Candidate executor source-root handoff admission');
    expect(journal.binding.root).toBe(repo);
    expect(journal.binding.source).toBeUndefined();
    expect(fs.existsSync(poisonMarker)).toBe(false);
    await until(() => {
      journal = readRuntimeHandoff(home, request.id, executionId);
      if (journal?.phase === 'failed') throw new Error(journal.error);
      const attempt = db!.prepare('SELECT exit_code, output FROM auth_hook_executions WHERE id=?').get(executionId) as any;
      if (!journal && attempt?.exit_code != null && ![0, 75].includes(attempt.exit_code)) throw new Error(`Old daemon hook refused handoff: ${attempt.output}`);
      return journal?.phase === 'complete' || journal?.phase === 'acknowledged';
    }, 15 * 60 * 1000, 'Actual old-to-candidate convergence');
    await until(() => readRuntimeHandoff(home, request.id, executionId)?.phase === 'acknowledged', 60000, 'Candidate hook receipt acknowledgment');
    expect(fs.existsSync(xattrMarker)).toBe(false);
    const row = db.prepare('SELECT state, exit_code FROM auth_hook_executions WHERE id=?').get(executionId) as any; expect(row.state).toBe('complete'); expect(row.exit_code).toBe(0);
    const finalRequest = await readBootstrapDelivery(operatorApi, request.id); assertBootstrapOperatorProof(finalRequest, signing.operatorId, signing.credentialId);
    expect(finalRequest.status).toBe('completed'); expect(finalRequest.exit_code).toBe(0);
    expect(finalRequest.output).toContain('MANDIBLE_MERGE_PREPARED '); expect(finalRequest.output).toContain('MANDIBLE_MERGE_APPLIED '); expect(finalRequest.output).toContain('MANDIBLE_MERGE_RESULT ');
    expect(fs.existsSync(poisonMarker)).toBe(false);
    const nativeRuns = db.prepare('SELECT hook_id, position, state, exit_code FROM auth_hook_executions WHERE auth_request_id=? AND position < 0 ORDER BY position').all(request.id) as any[];
    expect(nativeRuns.map(row => [row.position, row.state, row.exit_code])).toEqual([[-2, 'complete', 0], [-1, 'complete', 0]]);
    const newJob = command('/bin/launchctl', ['print', `${domain}/${backendLabel}`]); expect(newJob).toContain(runtime); expect(newJob).toContain(`${repo}/bin`); expect(newJob).toContain(securityAdapter);
    for (const label of [backendLabel, gatewayLabel]) {
      const detail = command('/bin/launchctl', ['print', `${domain}/${label}`]);
      const file = detail.split('\n').map(line => line.trim()).find(line => line.startsWith('path = '))?.slice(7);
      expect(file).toBeTruthy();
      expect(loadedServiceMatches(JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file!])), parseLoadedService(detail))).toBe(true);
    }
    fs.writeFileSync(path.join(evidence, `${Date.now()}.json`), JSON.stringify({ status: 'passed', topology: 'installed protected-root update', oldRevision, candidateRevision: candidate, fixturePorts: ports, runtimeHash: digest(fs.readFileSync(runtime)), oldLoadedDefinitionHash: digest(oldJob), oldGatewayLoadedDefinitionHash: digest(oldGatewayJob), sourceManifest, nativeHooks, executorCredentialStore: { kind: 'native private Keychain', adapterSha256: digest(fs.readFileSync(securityAdapter)), defaultUnchanged: true, searchListUnchanged: true }, bootstrapLoadedDefinitionHash: digest(bootstrapJob), finalRequest: { id: finalRequest.id, status: finalRequest.status, mergeHead: finalRequest.merge_head_sha, mergeCommit: git(repo, ['rev-parse', 'main']) }, newLoadedDefinitionHash: digest(newJob), journal: readRuntimeHandoff(home, request.id, executionId), sourceTransforms: ['private frontend/backend ports generated from config', 'private Caddy admin port'], shutdownTrigger: 'canonical managed self-update drain after independent handoff admission', note: 'Actual daemon transition; exact unmodified candidate paired desktop gate remains separately required.' }, null, 2));
  } catch (error) {
    const logs = [path.join(scratch, '.cache/mandible/production-stderr.log'), path.join(scratch, '.cache/mandible/local-front-door-stderr.log'), ...(requestId ? [path.join(home, 'config/local-sessions/handoff', `${requestId}-${executionId}`, 'convergence.log'), path.join(home, 'config/local-sessions/handoff', `${requestId}-${executionId}`, 'helper.log')] : [])].filter(file => fs.existsSync(file)).map(file => ({ name: path.basename(file), sha256: digest(fs.readFileSync(file)), excerpt: fs.readFileSync(file, 'utf8').slice(-16000) }));
    const requestState = requestId && db ? db.prepare('SELECT id, status, exit_code, error, output, merge_head_sha FROM auth_requests WHERE id=?').get(requestId) as any : null;
    if (requestState?.output) requestState.output = requestState.output.slice(-16000);
    const hookStates = requestId && db ? (db.prepare('SELECT hook_id, position, state, exit_code, output FROM auth_hook_executions WHERE auth_request_id=? ORDER BY position').all(requestId) as any[]).map(row => ({ ...row, output: row.output?.slice(-16000) })) : [];
    fs.writeFileSync(path.join(evidence, `${Date.now()}-failed.json`), JSON.stringify({ status: 'failed', oldRevision, candidateRevision: candidate, error: String(error), logs, requestState, hookStates, journal: requestId && executionId ? readRuntimeHandoff(home, requestId, executionId) : null }, null, 2)); throw error;
  } finally {
    if (requestId && executionId) spawnSync('/bin/launchctl', ['bootout', `${domain}/bio.mll.mandible.runtime-handoff.${digest(`${home}:${requestId}:${executionId}`).slice(0, 16)}`], { timeout: 5000 });
    for (const label of [backendLabel, gatewayLabel]) spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { timeout: 5000 });
    db?.close();
    if (fs.existsSync(privateKeychain)) command('/usr/bin/security', ['delete-keychain', privateKeychain]);
    expect(keychainSelector('list-keychains')).toBe(keychainSearchBefore);
    expect(keychainSelector('default-keychain')).toBe(keychainDefaultBefore);
    if (candidateRoot && fs.existsSync(candidateRoot)) {
      git(candidateRoot, ['status', '--short', '--untracked-files=all']);
      command(fs.existsSync(path.join(buildHome, '.dotfiles/bin/wt')) ? path.join(buildHome, '.dotfiles/bin/wt') : 'wt', ['rm', 'feature/actual-upgrade', '--force', '--keep-branch'], { cwd: repo, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    }
    fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
  }
}, 20 * 60 * 1000);
