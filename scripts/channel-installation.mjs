import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { installedFileIdentity, readInstalledRelease, releaseFile } from './installed-release.mjs';
import { withInstallationGatewayLock } from './lifecycle-lock.mjs';
import { inspectRunConsumers } from './owned-run.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const identity = file => installedFileIdentity(file).sha256;
const publish = (file, bytes, mode = 0o600) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode });
  fs.renameSync(temporary, file);
};

export function channelInstallation(home) {
  if (!path.isAbsolute(home)) throw new Error('Channel installation home must be absolute.');
  const directory = path.join(home, 'channel');
  return { directory, active: path.join(directory, 'active.json') };
}

/** App identity is admission authority; it is deliberately absent from behavior identity. */
export function reconcileChannelInstallation({ home, resources, release = readInstalledRelease(resources), verifyOnly = false }) {
  home = path.resolve(home);
  resources = fs.realpathSync(resources);
  if (process.env.MANDIBLE_INSTANCE_ROLE === 'preview') throw new Error('Preview instances cannot reconcile installed channels.');
  const admit = () => {
    const owner = read(path.join(home, 'config/local-sessions/bundle-owner.json'));
    const authority = fs.readFileSync(path.join(home, 'config/client-auth/authority-id'), 'utf8').trim();
    if (owner.installationId !== authority || owner.generation !== release.provenance.commit
        || owner.sourceDigest !== release.provenance.source_digest || owner.bundleRoot !== path.resolve(resources, '../..')) {
      throw new Error('Only the current installation owner may repair the channel bridge.');
    }
  };
  admit();
  const bridgeSource = releaseFile(resources, release.entrypoints.channel, release.layout);
  const runtimeSource = releaseFile(resources, release.native.bun, release.layout);
  const bridgeSha256 = identity(bridgeSource);
  const runtimeSha256 = identity(runtimeSource);
  if (bridgeSha256 !== release.files[release.entrypoints.channel]?.sha256
      || runtimeSha256 !== release.files[release.native.bun]?.sha256) throw new Error('Channel source differs from the installed receipt.');
  if (!/^[a-f0-9]{64}$/.test(release.qualification?.bun_sha256 ?? '') || !release.channelRuntimePolicy) {
    throw new Error('Installed release has no qualified channel runtime policy.');
  }
  const runtimeKey = digest({ qualification: release.qualification.bun_sha256, policy: release.channelRuntimePolicy });
  const generation = digest({ protocol: 1, bridge: bridgeSha256, runtime: runtimeKey });
  const installation = channelInstallation(home);
  const directory = path.join(installation.directory, 'generations', generation);
  const runtimeDirectory = path.join(installation.directory, 'runtimes', runtimeKey);
  for (let existing = directory; existing !== path.dirname(existing); existing = path.dirname(existing)) {
    if (fs.existsSync(existing) && (fs.lstatSync(existing).isSymbolicLink() || fs.realpathSync(existing) !== existing)) {
      throw new Error('Channel installation directories must be canonical owned paths.');
    }
  }
  for (let existing = runtimeDirectory; existing !== path.dirname(existing); existing = path.dirname(existing)) {
    if (fs.existsSync(existing) && (fs.lstatSync(existing).isSymbolicLink() || fs.realpathSync(existing) !== existing)) {
      throw new Error('Channel installation directories must be canonical owned paths.');
    }
  }
  if (!verifyOnly) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  } else if (!fs.existsSync(directory) || !fs.existsSync(runtimeDirectory)) return null;
  for (const owned of [home, installation.directory, path.dirname(directory), directory, path.dirname(runtimeDirectory), runtimeDirectory]) {
    if (fs.realpathSync(owned) !== owned || fs.lstatSync(owned).isSymbolicLink()) throw new Error('Channel installation directories must be canonical owned paths.');
  }
  const bridge = path.join(directory, 'bridge.mjs');
  const generationReceipt = path.join(directory, 'receipt.json');
  const runtime = path.join(runtimeDirectory, 'bun');
  const receiptFile = path.join(runtimeDirectory, 'receipt.json');
  let receipt;
  try { receipt = read(receiptFile); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const sound = (file, sha) => {
    try { return fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink() && identity(file) === sha; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (!sound(bridge, bridgeSha256)) {
    if (verifyOnly) return null;
    publish(bridge, fs.readFileSync(bridgeSource));
  }
  const generationBytes = `${JSON.stringify({ schema: 'mandible-channel-generation@1', generation, bridgeSha256, runtimeKey })}\n`;
  if (!fs.existsSync(generationReceipt) || fs.readFileSync(generationReceipt, 'utf8') !== generationBytes) {
    if (verifyOnly) return null;
    publish(generationReceipt, generationBytes);
  }
  if (receipt?.runtimeKey !== runtimeKey || !sound(runtime, receipt?.sha256) || !(fs.statSync(runtime).mode & 0o100)) {
    if (verifyOnly) return null;
    publish(runtime, fs.readFileSync(runtimeSource), 0o755);
    if (identity(runtime) !== runtimeSha256) throw new Error('Copied channel runtime failed verification.');
    receipt = { schema: 'mandible-channel-runtime@1', runtimeKey, sha256: runtimeSha256 };
    publish(receiptFile, `${JSON.stringify(receipt)}\n`);
  }
  const active = { schema: 'mandible-channel-installation@1', generation, bridgeSha256, runtimeKey,
    bridge, runtime, runtimeSha256: receipt.sha256 };
  let current;
  try { current = read(installation.active); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  admit();
  if (JSON.stringify(current) !== JSON.stringify(active)) {
    if (verifyOnly) return null;
    publish(installation.active, `${JSON.stringify(active)}\n`);
  }
  if (!verifyOnly) pruneChannelInstallation({ ...active, active: installation.active, directory });
  return { ...active, active: installation.active, directory };
}

/** Unknown entries or live consumers are preserved; receipts bound to bytes authorize removal. */
function pruneChannelInstallation(active) {
  const root = path.dirname(path.dirname(active.directory));
  const retainedRuntimes = new Set([active.runtimeKey]);
  for (const name of fs.readdirSync(path.join(root, 'generations'))) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const directory = path.join(root, 'generations', name);
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) continue;
    let receipt;
    try { receipt = read(path.join(directory, 'receipt.json')); } catch { continue; }
    if (receipt.schema !== 'mandible-channel-generation@1' || receipt.generation !== name
        || digest({ protocol: 1, bridge: receipt.bridgeSha256, runtime: receipt.runtimeKey }) !== name) continue;
    retainedRuntimes.add(receipt.runtimeKey);
    if (name === active.generation || fs.readdirSync(directory).sort().join(',') !== 'bridge.mjs,receipt.json'
        || identity(path.join(directory, 'bridge.mjs')) !== receipt.bridgeSha256 || !inspectRunConsumers(directory).idle) continue;
    fs.unlinkSync(path.join(directory, 'bridge.mjs')); fs.unlinkSync(path.join(directory, 'receipt.json')); fs.rmdirSync(directory);
  }
  for (const name of fs.readdirSync(path.join(root, 'runtimes'))) {
    if (!/^[a-f0-9]{64}$/.test(name) || retainedRuntimes.has(name)) continue;
    const directory = path.join(root, 'runtimes', name);
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) continue;
    let receipt;
    try { receipt = read(path.join(directory, 'receipt.json')); } catch { continue; }
    if (receipt.schema !== 'mandible-channel-runtime@1' || receipt.runtimeKey !== name
        || fs.readdirSync(directory).sort().join(',') !== 'bun,receipt.json'
        || identity(path.join(directory, 'bun')) !== receipt.sha256 || !inspectRunConsumers(directory).idle) continue;
    fs.unlinkSync(path.join(directory, 'bun')); fs.unlinkSync(path.join(directory, 'receipt.json')); fs.rmdirSync(directory);
  }
}

/** Valid installations need no lock or writes; repair serializes with accepted app adoption. */
export async function ensureChannelInstallation(options) {
  const installed = reconcileChannelInstallation({ ...options, verifyOnly: true });
  if (installed) return installed;
  return withInstallationGatewayLock(options.home, () => reconcileChannelInstallation(options));
}

/** Retain logical caller context, remove every bundle-derived loader/runtime reference. */
export function channelEnvironment(active, environment = process.env, cwd = process.cwd()) {
  const result = { ...environment, CLAUDE_CWD: environment.CLAUDE_CWD ?? cwd,
    MANDIBLE_CHANNEL_ACTIVE: active.active, MANDIBLE_CHANNEL_GENERATION: active.generation };
  for (const key of ['MANDIBLE_RELEASE_ROOT', 'MANDIBLE_RUNTIME', 'MANDIBLE_SQLITE_LIBRARY', 'MANDIBLE_SQLITE_LIBRARY_ARCHIVE',
    'MANDIBLE_CADDY', 'MANDIBLE_CA_TRUST_HELPER', 'MANDIBLE_CLI_DIR', 'MANDIBLE_RUNTIME_ARCHIVE', 'NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']) delete result[key];
  result.PATH = (result.PATH ?? '').split(path.delimiter).filter(entry => !entry.includes('.app/Contents/')).join(path.delimiter);
  return result;
}

function processRows() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,uid=,lstart=,args='], { encoding: 'utf8', timeout: 2_500, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect legacy channel consumers.');
  return result.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), uid: Number(match[2]), birth: match[3], command: match[4] }] : [];
  });
}

/** Signal an exact channel child only; bundle deletion remains the handoff cleanup's job. */
export function retireLegacyChannels({ home, resources, rows = processRows, executable = legacyExecutable, signal = (pid, name) => process.kill(pid, name) }) {
  const current = path.resolve(resources, '../..');
  const owned = new Set([current]);
  const handoffs = path.join(home, 'config/local-sessions/handoff');
  if (fs.existsSync(handoffs)) for (const name of fs.readdirSync(handoffs)) {
    const file = path.join(handoffs, name, 'journal.json');
    if (!fs.existsSync(file)) continue;
    const journal = read(file);
    const binding = journal.binding;
    if (journal.schema !== 'mandible-runtime-handoff@1' || !binding || binding.home !== home || binding.nativeApp !== current
        || digest(binding) !== journal.bindingDigest || !binding.priorAppIdentity
        || !/^[A-Za-z0-9_-]{8,128}$/.test(binding.requestId) || !/^[A-Za-z0-9_-]{8,128}$/.test(binding.executionId)) continue;
    const previous = path.join(path.dirname(current), `.Mandible-${binding.requestId}-${binding.executionId}.previous.app`);
    if (!fs.existsSync(previous)) continue;
    const stat = fs.lstatSync(previous);
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === binding.priorAppIdentity.dev && stat.ino === binding.priorAppIdentity.ino) owned.add(previous);
  }
  const patterns = [...owned].map(bundle => {
    const runtime = path.join(bundle, 'Contents/MacOS/mandible-bun');
    const entry = path.join(bundle, 'Contents/Resources/dist/channel-server/index.js');
    const runtimes = [runtime, path.join(bundle, 'Contents/Resources') + '/../MacOS/mandible-bun'];
    const entries = [entry, path.join(bundle, 'Contents/Resources/cli') + '/../dist/channel-server/index.js'];
    return { runtime, invocations: runtimes.flatMap(binary => entries.flatMap(script => [`${binary} --no-install ${script}`, `${binary} ${script}`])) };
  });
  const qualified = row => row.uid === process.getuid() && row.pid !== process.pid && row.pid !== process.ppid
    && patterns.some(pattern => pattern.invocations.includes(row.command));
  const retired = [];
  for (const row of rows().filter(qualified)) {
    const live = rows().find(candidate => candidate.pid === row.pid);
    if (live && live.birth === row.birth && live.command === row.command && qualified(live)
        && patterns.some(pattern => pattern.runtime === executable(row.pid))) {
      try { signal(row.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      retired.push(row.pid);
    }
  }
  return retired;
}

function legacyExecutable(pid) {
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { encoding: 'utf8', timeout: 1_500 });
  if (result.error || result.status !== 0 || result.stderr.trim()) return null;
  const names = result.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  return names.find(file => file.endsWith('/Contents/MacOS/mandible-bun')) ?? null;
}

export function installedChannelHome(environment = process.env) {
  return path.resolve(environment.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'));
}
