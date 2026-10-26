import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { trackedSourceDigest } from './build-revision.mjs';

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export function nativeCandidate(worktree) {
  const marker = JSON.parse(fs.readFileSync(path.join(worktree, 'dist/build-revision.json'), 'utf8'));
  const candidate = { commit: command('git', ['rev-parse', 'HEAD'], worktree), source_digest: trackedSourceDigest(worktree) };
  if (marker.commit !== candidate.commit || marker.source_digest !== candidate.source_digest) {
    throw new Error('Native candidate sources differ from the selected backend build; refresh the preview first');
  }
  return candidate;
}

export function verifyNativeSelection(selected, candidate) {
  if (selected.instanceEnv?.MANDIBLE_BACKEND_GENERATION !== candidate.commit
    || selected.ownership?.source?.commit !== candidate.commit
    || selected.ownership?.source?.source_digest !== candidate.source_digest) {
    throw new Error('Native candidate differs from the selected backend generation/source identity');
  }
}

export function verifyNativeBundle(bundle, candidate) {
  const marker = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents/Resources/build-revision.json'), 'utf8'));
  if (marker.commit !== candidate.commit || marker.source_digest !== candidate.source_digest) {
    throw new Error('Native bundle build identity differs from the selected backend candidate');
  }
  return marker;
}

export function nativeToolchain(worktree) {
  const bun = command('/bin/sh', [path.join(worktree, 'scripts/bun-runtime.sh')], worktree);
  const cargoHome = process.env.CARGO_HOME ?? path.join(process.env.HOME, '.cargo');
  const cargoConfiguration = ['config', 'config.toml'].flatMap(name => {
    const file = path.join(cargoHome, name);
    return fs.existsSync(file) ? [[name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]] : [];
  });
  return { cargo: command('cargo', ['--version'], worktree), rustc: command('rustc', ['-vV'], worktree),
    bun: command(bun, ['--version'], worktree), tauri: command(bun, [path.join(worktree, 'node_modules/@tauri-apps/cli/tauri.js'), '--version'], worktree),
    cargoConfiguration, environment: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(RUST|CARGO_|SDKROOT$|MACOSX_DEPLOYMENT_TARGET$|DEVELOPER_DIR$|CC$|CXX$)/.test(key)
        && !['CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR', 'CARGO_PROFILE_DEV_DEBUG'].includes(key))) };
}

export function stageNativeBuild({ worktree, root, candidate }) {
  const buildRoot = path.join(root, 'build');
  const source = path.join(buildRoot, 'source');
  const crate = path.join(source, 'src-tauri');
  fs.rmSync(source, { recursive: true, force: true });
  fs.mkdirSync(crate, { recursive: true });
  const files = command('git', ['ls-files', '--', 'src-tauri'], worktree).split('\n').filter(Boolean);
  for (const file of files) {
    const destination = path.join(source, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(worktree, file), destination);
  }
  const configFile = path.join(crate, 'tauri.conf.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const generated = path.join(buildRoot, 'generated');
  const bootstrap = path.join(generated, 'bootstrap');
  const runtime = path.join(generated, 'bun-runtime');
  const trustHelper = path.join(generated, 'local-ca-trust-helper');
  const resources = {};
  for (const [file, destination] of Object.entries(config.bundle.resources)) {
    const original = path.resolve(worktree, 'src-tauri', file);
    const generatedFile = file.startsWith('resources/bun-runtime/') ? path.join(runtime, path.basename(file))
      : file === 'resources/local-ca-trust-helper' ? trustHelper : original;
    resources[generatedFile] = destination;
  }
  config.build = { ...config.build, beforeBuildCommand: null, beforeDevCommand: null, frontendDist: bootstrap };
  config.bundle = { ...config.bundle, resources, targets: ['app'] };
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const bun = command('/bin/sh', [path.join(worktree, 'scripts/bun-runtime.sh')], worktree);
  const temporary = path.join(buildRoot, 'tmp'); fs.mkdirSync(temporary, { recursive: true });
  const env = { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH}`,
    CARGO_TARGET_DIR: path.join(buildRoot, 'target'), CARGO_BUILD_BUILD_DIR: path.join(buildRoot, 'intermediates'),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, MANDIBLE_DESKTOP_TRUST_CACHE: path.join(buildRoot, 'swift-cache'),
    CARGO_PROFILE_DEV_DEBUG: '0', MANDIBLE_DESKTOP_BOOTSTRAP_DIR: bootstrap,
    MANDIBLE_DESKTOP_RUNTIME_DIR: runtime, MANDIBLE_DESKTOP_TRUST_HELPER: trustHelper };
  const toolchain = nativeToolchain(worktree);
  const fingerprint = createHash('sha256').update(JSON.stringify({ candidate, config, toolchain,
    profile: 'dev-debug-0', cargoBuildDir: env.CARGO_BUILD_BUILD_DIR, cargoTargetDir: env.CARGO_TARGET_DIR })).digest('hex');
  return { buildRoot, source, crate, configFile, bun, env, candidate, toolchain, fingerprint,
    bundle: path.join(buildRoot, 'target/debug/bundle/macos', `${config.productName}.app`) };
}

export async function runNativeBuildPhase({ command, args, cwd, env, log, budgetMs, receipt, save, identity }) {
  const fd = fs.openSync(log, 'a', 0o600);
  let child;
  const started = Date.now();
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  } finally { fs.closeSync(fd); }
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  receipt.buildProcess = { pid: child.pid, identity: identity(child.pid), command, startedAt: new Date(started).toISOString(), budgetMs };
  receipt.buildProcess.birth = receipt.buildProcess.identity?.slice(0, 24);
  let timer;
  try {
    save();
    const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), budgetMs); })]);
    if (result === null) {
      if (identity(child.pid)?.slice(0, 24) !== receipt.buildProcess.birth) throw new Error('Build process identity changed; refusing signal');
      process.kill(-child.pid, 'SIGKILL');
      await exited;
      throw new Error(`Native build phase exceeded ${budgetMs}ms; inspect ${log}`);
    }
    if (result.code !== 0) throw new Error(`Native build phase failed (${result.code ?? result.signal}); inspect ${log}`);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null && identity(child.pid)?.slice(0, 24) === receipt.buildProcess.birth) {
      process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    receipt.buildProcess.finishedAt = new Date().toISOString();
    receipt.buildProcess.elapsedMs = Date.now() - started;
    save();
  }
  return Date.now() - started;
}

export async function buildNativePreview({ worktree, root, candidate, receipt, save, identity }) {
  const staged = stageNativeBuild({ worktree, root, candidate });
  receipt.nativeBuild = { root: staged.buildRoot, candidate, fingerprint: staged.fingerprint, toolchain: staged.toolchain,
    target: staged.env.CARGO_TARGET_DIR, intermediates: staged.env.CARGO_BUILD_BUILD_DIR, status: 'preparing', phases: {} };
  save();
  const phase = (name, command, args, cwd, budgetMs) => runNativeBuildPhase({ command, args, cwd, env: staged.env,
    log: path.join(root, 'build.log'), budgetMs, receipt, save, identity }).then(ms => { receipt.nativeBuild.phases[name] = ms; save(); });
  await phase('prepare', '/bin/sh', [path.join(worktree, 'scripts/make-dist.sh')], worktree, 60_000);
  receipt.nativeBuild.status = 'compiling'; save();
  await phase('compile', staged.bun, [path.join(worktree, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--debug', '--bundles', 'app', '--ci', '--', '--locked',
    '--config', `build.build-dir=${JSON.stringify(staged.env.CARGO_BUILD_BUILD_DIR)}`], staged.source, 600_000);
  if (JSON.stringify(nativeCandidate(worktree)) !== JSON.stringify(candidate)) throw new Error('Native candidate sources changed during compilation');
  verifyNativeBundle(staged.bundle, candidate);
  receipt.nativeBuild.status = 'built'; receipt.nativeBuild.bundle = staged.bundle; save();
  return staged.bundle;
}
