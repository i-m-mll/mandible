import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import SqliteDatabase from '../src/sqlite.ts';
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun, processIdentity, recoverLifecycleLock, withOwnedRunLock } from './owned-run.mjs';
import { acquirePreviewConsumer, publishPreviewConsumer, releasePreviewConsumer } from './preview-custody.mjs';
import { reconcilePreviewRegistration } from './preview-registration.mjs';
import { main, refreshPreview, previewStatus, stopPreview, healthyExistingPreview, finalizePreview, stopPreviewProcess } from './iab-preview.mjs';
import { trackedSourceDigest } from './build-revision.mjs';
import { createHash } from 'node:crypto';
import { stopNativePreview } from './native-preview.mjs';
import { verifyNativeSelection } from './native-build.mjs';

const idle = { inspect: () => ({ idle: true }) };
const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-preview-lifecycle-')));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function owned(root, extra = {}) {
  fs.mkdirSync(root);
  const ownership = createOwnedRun({ root, project: 'fixture', workUnit: 'fixture-unit', instanceId: 'preview-1111111111111111',
    outputs: [{ path: 'ledger.db', kind: 'interactive' }], ...extra });
  ownership.state = 'active'; ownership.lifecycle = { phase: 'ready', teardown: false };
  ownership.source = { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) };
  ownership.consumers = [];
  const metadata = { previewRoot: root, branch: 'fixture', worktree: root, ownership,
    instanceEnv: { MANDIBLE_BACKEND_GENERATION: 'a'.repeat(40) } };
  const file = path.join(root, 'metadata.json');
  fs.writeFileSync(path.join(root, 'ledger.db'), 'interactive fixture');
  saveOwnedMetadata(file, metadata);
  return { file, metadata, handle: { root, runId: ownership.runId } };
}

test('pending native acquisition blocks teardown and generation drift refuses publication; terminal cleanup releases custody', async () => {
  const base = temporary();
  try {
    const parent = owned(path.join(base, 'parent'));
    const native = owned(path.join(base, 'native'), { disposable: true });
    native.metadata.parent = parent.handle; native.metadata.attemptId = 'fixture-attempt'; saveOwnedMetadata(native.file, native.metadata);
    const reserve = { consumerId: native.handle.runId, runId: native.handle.runId, root: native.handle.root,
      metadataFile: native.file, rootIdentity: native.metadata.ownership.rootIdentity,
      attemptId: 'fixture-attempt',
      expectedGeneration: 'a'.repeat(40), expectedSource: parent.metadata.ownership.source, borrowedBackend: true };
    const reservation = await acquirePreviewConsumer(parent.handle, reserve);
    await assert.rejects(acquirePreviewConsumer(parent.handle, { ...reserve, consumerId: 'another', runId: 'another' }), /already has/);
    const changed = read(parent.file); changed.ownership.lifecycle.teardown = true; saveOwnedMetadata(parent.file, changed);
    await assert.rejects(publishPreviewConsumer(reservation, {}), /reservation or generation/);
    await assert.rejects(acquirePreviewConsumer(parent.handle, reserve), /not accepting/);
    await assert.rejects(releasePreviewConsumer(reservation), /cleanup is not completed/);
    finalizeOwnedRun(native.file, { expectedRevision: 1, outcome: 'failed', summary: 'Acquisition cancelled' }, idle);
    cleanupOwnedRun(native.file, { apply: true, ...idle });
    await releasePreviewConsumer(reservation);
    assert.equal(read(parent.file).ownership.consumers[0].state, 'released');
    assert.equal(fs.readFileSync(path.join(parent.handle.root, 'ledger.db'), 'utf8'), 'interactive fixture');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('exact registration retirement retries a failed gateway reload and preserves serving unrelated rows', async () => {
  const home = temporary();
  const authority = path.join(home, 'config', 'local-sessions');
  fs.mkdirSync(authority, { recursive: true }); fs.mkdirSync(path.join(home, 'config', 'client-auth'));
  fs.writeFileSync(path.join(home, 'config', 'client-auth', 'authority-id'), 'fixture-installation');
  const db = new SqliteDatabase(path.join(authority, 'sessions.db'));
  db.exec(`CREATE TABLE instance_registrations (instance_id TEXT PRIMARY KEY, installation_id TEXT, role TEXT,
    public_origin TEXT, backend_origin TEXT, backend_generation TEXT, effect_ceiling_json TEXT, writable_roots_json TEXT, updated_at INTEGER)`);
  const row = { instance_id: 'preview-1111111111111111', installation_id: 'fixture-installation', role: 'preview', public_origin: 'https://fixture',
    backend_origin: 'http://127.0.0.1:12345', backend_generation: 'a'.repeat(40), effect_ceiling_json: '[]', writable_roots_json: '[]' };
  const insert = candidate => db.prepare(`INSERT INTO instance_registrations VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(...Object.values(candidate));
  const main = { ...row, instance_id: 'production', role: 'main', public_origin: 'https://main' };
  const survivor = { ...row, instance_id: 'preview-2222222222222222', public_origin: 'https://survivor' };
  insert(main); insert(survivor);
  let routes = new Set();
  const gateway = http.createServer((req, res) => { res.statusCode = routes.has(req.url) ? 200 : 404; res.end('fixture'); });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  const reload = async () => { routes = new Set(db.prepare('SELECT instance_id FROM instance_registrations').all().map(row => `/${row.instance_id}`)); };
  const request = (expected, desired, reconcile = reload) => reconcilePreviewRegistration({ home, runId: 'fixture-run', expected, desired, reload: reconcile });
  try {
    await request(null, row);
    assert.equal((await fetch(`${origin}/${row.instance_id}`)).status, 200);
    await assert.rejects(request(row, null, async () => { throw new Error('gateway unavailable'); }), /unavailable/);
    assert.equal(db.prepare('SELECT * FROM instance_registrations WHERE instance_id = ?').get(row.instance_id), undefined);
    assert.equal((await fetch(`${origin}/${row.instance_id}`)).status, 200);
    await request(row, null);
    assert.equal((await fetch(`${origin}/${row.instance_id}`)).status, 404);
    assert.equal((await fetch(`${origin}/${survivor.instance_id}`)).status, 200);
    assert.equal((await fetch(`${origin}/production`)).status, 200);
    assert.deepEqual(db.prepare('SELECT * FROM instance_registrations WHERE instance_id = ?').get('production'), { ...main, updated_at: 1 });
    await request(row, null);
    await request(null, row);
    db.prepare('UPDATE instance_registrations SET backend_generation = ? WHERE instance_id = ?').run('foreign', row.instance_id);
    await assert.rejects(request(row, null), /identity changed/);
    assert.equal(db.prepare('SELECT backend_generation FROM instance_registrations WHERE instance_id = ?').get(row.instance_id).backend_generation, 'foreign');
  } finally { await new Promise(resolve => gateway.close(resolve)); db.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('exact teardown survives root removal and never selects a replacement at the same path', async () => {
  const base = temporary(); const previousBase = process.env.MANDIBLE_PREVIEW_BASE_DIR;
  process.env.MANDIBLE_PREVIEW_BASE_DIR = base;
  try {
    const run = owned(path.join(base, 'run'));
    const options = { ...run.handle, revision: 1, outcome: 'assessed', disposition: 'discard', summary: 'Fixture interaction assessed' };
    const cleaned = await finalizePreview(options);
    assert.equal(cleaned.ok, true); assert.equal(fs.existsSync(run.handle.root), false);
    assert.equal((await finalizePreview(options)).cleanup, 'completed');
    const replacement = owned(run.handle.root);
    assert.equal((await finalizePreview(options)).runId, run.handle.runId);
    assert.equal(read(replacement.file).ownership.runId, replacement.handle.runId);
    assert.equal(fs.readFileSync(path.join(replacement.handle.root, 'ledger.db'), 'utf8'), 'interactive fixture');
  } finally { if (previousBase === undefined) delete process.env.MANDIBLE_PREVIEW_BASE_DIR; else process.env.MANDIBLE_PREVIEW_BASE_DIR = previousBase; fs.rmSync(base, { recursive: true, force: true }); }
});

test('stale PID files cannot signal a live unrelated process; exact launch stops after identity verification', async () => {
  const base = temporary(); fs.mkdirSync(path.join(base, 'src'));
  fs.writeFileSync(path.join(base, 'src', 'index.ts'), 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, ['src/index.ts'], { cwd: base, stdio: 'ignore' });
  const survivor = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
  try {
    await Promise.all([child, survivor].map(child => new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); })));
    const identity = processIdentity(child.pid);
    const pidFile = path.join(base, 'mandible.pid'); fs.writeFileSync(pidFile, String(survivor.pid));
    const metadata = { pidFile, ownership: { lifecycle: { launch: { pid: child.pid, identity, startedAt: identity.slice(0, 24), runtime: process.execPath, runScript: path.join(base, 'run.sh'), worktree: base } } } };
    await assert.rejects(stopPreviewProcess(metadata), /pid file identity changed/);
    assert.ok(processIdentity(survivor.pid));
    fs.writeFileSync(pidFile, String(child.pid));
    await stopPreviewProcess(metadata);
    assert.equal(processIdentity(child.pid), null); assert.ok(processIdentity(survivor.pid));
  } finally {
    for (const process of [child, survivor]) if (process.exitCode === null && process.signalCode === null) process.kill();
    await Promise.all([child, survivor].map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('exit', resolve))));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('lifecycle lock recovery verifies the recorded owner rather than its age', async () => {
  const base = temporary(); const root = path.join(base, 'run');
  try {
    await withOwnedRunLock(root, async () => assert.throws(() => recoverLifecycleLock(root), /live or uncertain/));
    fs.mkdirSync(path.join(base, '.run.lock'));
    fs.writeFileSync(path.join(base, '.run.lock', 'owner.json'), JSON.stringify({ pid: process.pid, identity: 'previous process lifetime' }));
    recoverLifecycleLock(root);
    await withOwnedRunLock(root, async () => {});
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

async function exercisePreviewLifecycle(legacy = false) {
  const base = temporary(); const repository = path.join(base, 'repo'); fs.mkdirSync(repository);
  const oldCwd = process.cwd(); const oldHome = process.env.MANDIBLE_HOME; const oldBase = process.env.MANDIBLE_PREVIEW_BASE_DIR;
  const oldRuntime = process.env.MANDIBLE_RUNTIME;
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  const home = path.join(base, 'home'); const cache = path.join(base, 'previews');
  const authority = path.join(home, 'config', 'local-sessions');
  fs.mkdirSync(authority, { recursive: true }); fs.mkdirSync(path.join(home, 'config', 'client-auth'));
  fs.writeFileSync(path.join(home, 'config', 'client-auth', 'authority-id'), 'fixture-installation');
  fs.writeFileSync(path.join(authority, 'Caddyfile'), 'fixture gateway configuration');
  const caddy = path.join(home, 'runtime', 'caddy', '2.11.3', 'caddy'); fs.mkdirSync(path.dirname(caddy), { recursive: true }); fs.writeFileSync(caddy, 'borrowed gateway fixture');
  const db = new SqliteDatabase(path.join(authority, 'sessions.db'));
  db.exec(`CREATE TABLE instance_registrations (instance_id TEXT PRIMARY KEY, installation_id TEXT, role TEXT,
    public_origin TEXT, backend_origin TEXT, backend_generation TEXT, effect_ceiling_json TEXT, writable_roots_json TEXT, updated_at INTEGER)`);
  fs.mkdirSync(path.join(repository, 'scripts')); fs.mkdirSync(path.join(repository, 'src'));
  for (const name of ['bun-runtime.sh', 'bun-runtime-lock.tsv', 'sqlite-runtime-install.mjs']) fs.copyFileSync(path.join(sourceRoot, 'scripts', name), path.join(repository, 'scripts', name));
  fs.copyFileSync(path.join(sourceRoot, 'src/sqlite-runtime.ts'), path.join(repository, 'src/sqlite-runtime.ts'));
  fs.copyFileSync(path.join(sourceRoot, '.bun-version'), path.join(repository, '.bun-version'));
  fs.writeFileSync(path.join(repository, 'package.json'), '{}');
  fs.writeFileSync(path.join(repository, 'src', 'index.ts'), `import fs from 'node:fs';
    const e = process.env;
    fs.writeFileSync(e.MANDIBLE_PID_FILE, String(process.pid));
    Bun.serve({ hostname:'127.0.0.1', port:Number(e.MANDIBLE_PORT), fetch(request) {
      if (new URL(request.url).pathname === '/api/health') return Response.json({ready:true,warm:true,
        startup_commit:{hash:e.MANDIBLE_BACKEND_GENERATION},file_rpc_dir:e.MANDIBLE_FILE_RPC_DIR,
        instance:{role:'preview',instance_id:e.MANDIBLE_INSTANCE_ID,installation_id:e.MANDIBLE_INSTALLATION_ID,
          backend_generation:e.MANDIBLE_BACKEND_GENERATION,public_origin:e.MANDIBLE_PUBLIC_ORIGIN,
          db_path:e.MANDIBLE_DB,db_path_source:'iab-preview-copy',source_db_path:e.MANDIBLE_INSTANCE_SOURCE_DB,
          allowed_effects:JSON.parse(e.MANDIBLE_ALLOWED_EFFECTS)}});
      if(new URL(request.url).pathname === '/app.js') return new Response('window.fixture=true', {headers:{'content-type':'application/javascript'}});
      if(new URL(request.url).pathname === '/app.css') return new Response('body{}', {headers:{'content-type':'text/css'}});
      return new Response('<html><link rel="stylesheet" href="/app.css"><script id="mandible-bootstrap" type="application/json">{}</script><script src="/app.js"></script></html>',{headers:{'content-type':'text/html'}});
    }});`);
  const git = args => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  git(['add', '.']); git(['commit', '-m', 'fixture']); git(['checkout', '-b', 'feature/owned-fixture']);
  const sourceDb = path.join(base, 'source.db'); const source = new SqliteDatabase(sourceDb); source.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)'); source.close();
  let routes = new Map(); let failReload = false;
  const gateway = http.createServer(async (req, res) => {
    const [, id, ...parts] = req.url.split('/'); const backend = routes.get(id);
    if (!backend) { res.writeHead(404); res.end(); return; }
    try { const upstream = await fetch(`${backend}/${parts.join('/')}`); res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') }); res.end(await upstream.text()); }
    catch { res.writeHead(502); res.end(); }
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const publicRoot = `http://127.0.0.1:${gateway.address().port}`;
  let snapshots = 0; const legacyChildren = []; let foreignProcess;
  const nativeBase = path.join(base, 'native-previews'); fs.mkdirSync(nativeBase);
  const effects = {
    nativeBase, resolveOwner: () => ({ project: 'fixture', workUnit: 'fixture-unit' }),
    build: async worktree => {
      fs.mkdirSync(path.join(worktree, 'dist'), { recursive: true });
      saveOwnedMetadata(path.join(worktree, 'dist/build-revision.json'), { commit: git(['rev-parse', 'HEAD']), source_digest: trackedSourceDigest(worktree) });
    },
    projectSnapshot: async ({ sourceDb, dbCopy }) => { snapshots++; fs.copyFileSync(sourceDb, dbCopy); return { fixture: true }; },
    reloadGateway: async () => {
      if (failReload) { failReload = false; throw new Error('Interrupted gateway refresh'); }
      routes = new Map(db.prepare('SELECT instance_id, backend_origin FROM instance_registrations').all().map(row => [row.instance_id, row.backend_origin]));
    },
    verifyPublic: async metadata => {
      const route = `${publicRoot}/${metadata.instanceEnv.MANDIBLE_INSTANCE_ID}`;
      const response = await fetch(`${route}/api/health`); assert.equal(response.status, 200);
      const health = await response.json(); assert.equal(health.startup_commit.hash, metadata.instanceEnv.MANDIBLE_BACKEND_GENERATION);
      assert.equal(health.instance.instance_id, metadata.ownership.instanceId);
      assert.match(await fetch(`${route}/`).then(response => response.text()), /mandible-bootstrap/);
      assert.equal((await fetch(`${route}/app.js`)).status, 200);
    },
  };
  let last; let original;
  try {
    process.env.MANDIBLE_HOME = home; process.env.MANDIBLE_PREVIEW_BASE_DIR = cache; delete process.env.MANDIBLE_RUNTIME; process.chdir(repository);
    const options = { db: sourceDb, ownerProject: 'fixture', ownerWorkUnit: 'fixture-unit', effects };
    last = await main(options);
    original = last;
    const staleRefresh = spawnSync(process.execPath, [path.join(sourceRoot, 'scripts/iab-preview.mjs'), 'refresh', '--root', last.previewRoot,
      '--run-id', last.ownership.runId, '--revision', '-1', '--json'], { cwd: repository, encoding: 'utf8', timeout: 5000 });
    assert.equal(staleRefresh.status, 1); assert.match(JSON.parse(staleRefresh.stdout).error, /revision changed/);
    fs.mkdirSync(path.join(last.previewRoot, 'settings', 'users'), { recursive: true });
    const preference = path.join(last.previewRoot, 'settings', 'users', 'fixture.json'); fs.writeFileSync(preference, 'private preference');
    const privateDb = new SqliteDatabase(last.db); privateDb.prepare('INSERT INTO settings VALUES (?, ?)').run('private-edit', 'keep'); privateDb.close();
    if (legacy) {
      const file = path.join(last.previewRoot, 'metadata.json');
      const old = read(file); const oldLaunch = old.ownership.lifecycle.launch;
      for (const key of ['lifecycle', 'source', 'acquisition', 'consumers']) delete old.ownership[key];
      old.ownership.revision = 12;
      old.restartLifecycle = { mechanism: 'detached-child', launcherPid: oldLaunch.pid };
      saveOwnedMetadata(file, old);
      const bindingFile = path.join(authority, 'preview-bindings', `${old.ownership.instanceId}.json`);
      const oldBinding = read(bindingFile);
      fs.unlinkSync(bindingFile);
      const stopped = await legacyNative(old, path.join(nativeBase, 'native-a-stopped'), false);
      const current = await legacyNative(old, path.join(nativeBase, 'native-z-live'), true);
      assert.equal(processIdentity(current.pid), read(current.file).processIdentity, 'native fixture identity must remain stable after launch evidence');
      legacyChildren.push(stopped, current);
      foreignProcess = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
      await new Promise((resolve, reject) => { foreignProcess.once('spawn', resolve); foreignProcess.once('error', reject); });
      const historical = read(stopped.file);
      saveOwnedMetadata(stopped.file, { ...historical, pid: foreignProcess.pid });
      stopped.historical = { ...historical, pid: foreignProcess.pid };
      const unchanged = fs.readFileSync(file, 'utf8');
      const childBytes = legacyChildren.map(child => fs.readFileSync(child.file, 'utf8'));
      const processBefore = [oldLaunch.pid, current.pid, foreignProcess.pid].map(processIdentity);
      assert.equal((await main({ ...options, dryRun: true })).status, 'dry-run');
      assert.equal(fs.readFileSync(file, 'utf8'), unchanged);
      assert.deepEqual(legacyChildren.map(child => fs.readFileSync(child.file, 'utf8')), childBytes);
      assert.equal(fs.existsSync(bindingFile), false);
      assert.deepEqual([oldLaunch.pid, current.pid, foreignProcess.pid].map(processIdentity), processBefore);
      assert.equal(snapshots, 1);
      const status = await previewStatus({ ...original.handle, revision: 12 });
      assert.equal(status.status, 'legacy-owned-runtime'); assert.equal(fs.readFileSync(file, 'utf8'), unchanged);
      await assert.rejects(stopPreview({ ...original.handle, revision: 12 }), /Adopt legacy runtime custody/);
      await assert.rejects(healthyExistingPreview(old.branch, { worktree: repository }), /supported setup or exact refresh/);
      const refresh = () => refreshPreview({ ...original.handle, revision: read(file).ownership.revision, effects });
      await assert.rejects(refreshPreview({ ...original.handle, revision: 11, effects }), /revision changed/);
      for (const [mutate, pattern] of [
        [candidate => candidate.ownership.rootIdentity.ino++, /identity changed/],
        [candidate => candidate.restartLifecycle.launcherPid++, /launch.PID evidence/],
      ]) {
        const changed = structuredClone(old); mutate(changed); saveOwnedMetadata(file, changed);
        await assert.rejects(refresh(), pattern); assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(changed, null, 2) + '\n');
        saveOwnedMetadata(file, old);
      }
      db.prepare('UPDATE instance_registrations SET backend_generation = ? WHERE instance_id = ?').run('foreign', old.ownership.instanceId);
      await assert.rejects(refresh(), /registration identity changed/);
      db.prepare('UPDATE instance_registrations SET backend_generation = ? WHERE instance_id = ?').run(old.instanceEnv.MANDIBLE_BACKEND_GENERATION, old.ownership.instanceId);
      saveOwnedMetadata(bindingFile, { ...oldBinding, runId: 'another-owner' });
      await assert.rejects(refresh(), /another acquisition/); fs.unlinkSync(bindingFile);
      const childBefore = read(current.file);
      saveOwnedMetadata(current.file, { ...childBefore, processIdentity: 'different lifetime' });
      await assert.rejects(refresh(), /process.start identity/); saveOwnedMetadata(current.file, childBefore);
      saveOwnedMetadata(current.file, { ...childBefore, manifest: '/unproven/parent/metadata.json' });
      await assert.rejects(refresh(), /ownership or profile evidence/); saveOwnedMetadata(current.file, childBefore);
      const ambiguous = await legacyNative(old, path.join(nativeBase, 'native-ambiguous'), true);
      await assert.rejects(refresh(), /default is ambiguous/);
      await stopNativePreview(ambiguous.file); fs.rmSync(ambiguous.root, { recursive: true });
      assert.equal(fs.readFileSync(file, 'utf8'), unchanged);
      let interrupt = true;
      effects.afterLegacyChildBound = () => { if (interrupt) { interrupt = false; throw new Error('Interrupted child adoption'); } };
      await assert.rejects(refresh(), /Interrupted child adoption/);
      const pending = read(file); assert.equal(pending.ownership.revision, 13);
      assert.equal(pending.ownership.legacyAdoption.primaryConsumerId, current.runId);
      assert.equal(read(stopped.file).legacyPreviewAdoption.intentId, pending.ownership.legacyAdoption.id);
      assert.equal(read(current.file).parent, undefined);
      await assert.rejects(refresh(), /Native consumer still has a live process/);
      last = read(file);
      assert.equal(last.ownership.legacyAdoption.state, 'completed');
      assert.equal(last.ownership.source, undefined);
      assert.equal(last.ownership.legacyAdoption.runtime.commit, old.instanceEnv.MANDIBLE_BACKEND_GENERATION);
      assert.equal(last.ownership.consumers[0].runId, current.runId);
      assert.equal(last.ownership.consumers.length, 2);
      const upgradedBytes = fs.readFileSync(file, 'utf8');
      assert.equal((await previewStatus(original.handle)).status, 'ready');
      assert.equal(fs.readFileSync(file, 'utf8'), upgradedBytes);
      assert.equal((await healthyExistingPreview(old.branch, { worktree: repository, verifyPublic: effects.verifyPublic })).ownership.source, undefined);
      assert.notEqual(last.ownership.consumers[0].source.commit, last.ownership.legacyAdoption.runtime.commit);
      assert.throws(() => verifyNativeSelection(last, original.ownership.source), /Refresh.*exact source identity/);
      assert.ok(processIdentity(current.pid)); assert.ok(processIdentity(oldLaunch.pid));
      await stopNativePreview(current.file);
      const stoppedBeforeRefresh = read(stopped.file);
      const unprovenLifetime = { ...stoppedBeforeRefresh }; delete unprovenLifetime.processIdentity;
      saveOwnedMetadata(stopped.file, unprovenLifetime);
      await assert.rejects(refresh(), /Native consumer still has a live process/);
      saveOwnedMetadata(stopped.file, stoppedBeforeRefresh);
      last = await refresh();
      assert.ok(processIdentity(foreignProcess.pid));
      assert.equal(last.ownership.source.commit, git(['rev-parse', 'HEAD']));
      assert.equal(last.ownership.consumers[0].runId, current.runId);
      assert.equal(read(current.file).profile, current.profile);
      assert.equal(fs.readFileSync(path.join(current.profile, 'preferences'), 'utf8'), 'retained selection');
      assert.equal(fs.readFileSync(path.join(stopped.profile, 'preferences'), 'utf8'), 'retained selection');
      assert.equal(read(stopped.file).ownership.outputs[0].disposition, 'pending');
    }
    const reused = await main(options); assert.equal(reused.status, 'already-running'); assert.equal(reused.ownership.runId, original.ownership.runId);
    fs.writeFileSync(path.join(repository, 'src', 'candidate.txt'), 'candidate'); git(['add', '.']); git(['commit', '-m', 'next candidate']);
    failReload = true;
    await assert.rejects(main(options), /Refresh failed/);
    last = read(path.join(original.previewRoot, 'metadata.json'));
    assert.equal(last.ownership.lifecycle.phase, 'failed-stopped'); assert.equal(snapshots, 1);
    last = await refreshPreview({ ...original.handle, revision: last.ownership.revision, effects });
    assert.equal(last.status, 'refreshed'); assert.equal(last.db, original.db); assert.equal(last.port, original.port);
    assert.equal(last.ownership.runId, original.ownership.runId); assert.equal(snapshots, 1);
    assert.equal(fs.readFileSync(preference, 'utf8'), 'private preference');
    const retained = new SqliteDatabase(last.db); assert.equal(retained.prepare('SELECT value FROM settings WHERE key = ?').get('private-edit').value, 'keep'); retained.close();
    const route = `${publicRoot}/${last.ownership.instanceId}/api/health`;
    const teardown = { ...last.handle, revision: last.ownership.revision, outcome: 'assessed', disposition: 'discard', summary: 'Owned fixture complete', effects };
    const cleaned = await finalizePreview(teardown); assert.equal(cleaned.ok, true); assert.equal((await fetch(route)).status, 404);
    if (foreignProcess) {
      assert.ok(processIdentity(foreignProcess.pid), 'teardown must never signal the foreign process reusing a historical PID');
      const stopped = legacyChildren[0];
      const receipt = read(path.join(nativeBase, '.receipts', `${stopped.runId}.json`)).nativePreview;
      for (const key of ['pid', 'processIdentity', 'stoppedAt']) assert.equal(receipt[key], stopped.historical[key]);
    }
    assert.equal((await finalizePreview(teardown)).cleanup, 'completed');
    assert.equal(fs.existsSync(repository), true);
  } finally {
    if (last && fs.existsSync(path.join(last.previewRoot, 'metadata.json'))) {
      const actual = read(path.join(last.previewRoot, 'metadata.json'));
      await stopPreviewProcess(actual.ownership.lifecycle ? actual : original);
    }
    for (const child of legacyChildren) if (fs.existsSync(child.file)) await stopNativePreview(child.file);
    if (foreignProcess && foreignProcess.exitCode === null && foreignProcess.signalCode === null) {
      const exited = new Promise(resolve => foreignProcess.once('exit', resolve)); foreignProcess.kill(); await exited;
    }
    process.chdir(oldCwd);
    for (const [key, value] of [['MANDIBLE_HOME', oldHome], ['MANDIBLE_PREVIEW_BASE_DIR', oldBase], ['MANDIBLE_RUNTIME', oldRuntime]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => gateway.close(resolve)); db.close(); fs.rmSync(base, { recursive: true, force: true });
  }
}

test('owned setup reuses its run, refresh preserves private edits, interrupted refresh retries, and teardown retires its serving route', () => exercisePreviewLifecycle());
test('legacy owner adoption preserves runtime and both native profiles, retries partial bindings and uses ordinary refresh', { timeout: 15000 }, () => exercisePreviewLifecycle(true));

async function legacyNative(parent, root, live) {
  fs.mkdirSync(root); const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'preferences'), 'retained selection');
  const app = path.join(root, 'app', 'Fixture.app', 'Contents');
  fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true }); fs.mkdirSync(path.join(app, 'Resources'));
  const executable = path.join(app, 'MacOS', 'owned-native'); fs.copyFileSync('/bin/sleep', executable);
  const signing = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', executable], { encoding: 'utf8', timeout: 5000 });
  assert.equal(signing.status, 0, signing.stderr);
  const build = { commit: 'c'.repeat(40), source_digest: 'd'.repeat(64) };
  saveOwnedMetadata(path.join(app, 'Resources', 'build-revision.json'), build);
  const process = spawn(executable, ['120'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { process.once('spawn', resolve); process.once('error', reject); });
  let identity = processIdentity(process.pid);
  const deadline = Date.now() + 5000;
  while (!identity?.includes(executable) && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
    identity = processIdentity(process.pid);
  }
  assert.ok(identity?.includes(executable), 'native fixture must reach its exact executable before recording page-load evidence');
  const ownership = createOwnedRun({ root, instanceId: parent.ownership.instanceId, project: parent.ownership.project, workUnit: parent.ownership.workUnit,
    outputs: [{ path: 'profile', kind: 'interactive' }, { path: 'app', kind: 'generated' }] });
  ownership.state = 'active';
  const file = path.join(root, 'metadata.json');
  saveOwnedMetadata(file, { schema: 'mandible-native-preview@1', ownership, manifest: path.join(parent.previewRoot, 'metadata.json'),
    previewRunId: parent.ownership.runId, instanceId: parent.ownership.instanceId, origin: parent.instanceEnv.MANDIBLE_PUBLIC_ORIGIN,
    executable, executableDigest: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), profile, build,
    pid: process.pid, processIdentity: identity, status: 'visible', windowTitle: 'Fixture',
    window: { pid: process.pid, runId: ownership.runId, profile, instanceId: parent.ownership.instanceId, origin: parent.instanceEnv.MANDIBLE_PUBLIC_ORIGIN } });
  if (!live) await stopNativePreview(file);
  return { root, file, process, pid: process.pid, runId: ownership.runId, profile };
}
