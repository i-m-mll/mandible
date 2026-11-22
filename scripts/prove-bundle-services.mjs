import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stageBundleServices } from './prepare-bundle-services.mjs';
import { parseLoadedService } from './service-definitions.mjs';
import { applicationIdentity, installedApplicationVerification } from './installed-release.mjs';

if (process.platform !== 'darwin') throw new Error('This qualification requires macOS.');
const helper = path.resolve(process.argv[2] || 'src-tauri/service-helper/target/release/mandible-service');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-service-proof-')));
let contents = path.join(fixture, 'Private Service.app/Contents');
const identifier = `bio.mll.mandible.fixture.${randomUUID()}`;
const label = `${identifier}.local-session-production`;
let executable = path.join(contents, 'MacOS/mandible-service');
const run = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(program)} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
};
const control = operation => JSON.parse(run(executable, [operation, 'backend']));
const deadline = async (predicate, phase, budgetMs = 5000) => {
  const until = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Private service did not reach ${phase}. Logs: ${fs.existsSync(path.join(fixture, '.cache/mandible/production-stderr.log')) ? fs.readFileSync(path.join(fixture, '.cache/mandible/production-stderr.log'), 'utf8') : '(none)'}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
let registered = false;
try {
  stageBundleServices(contents, helper, identifier);
  fs.copyFileSync(helper, path.join(contents, 'MacOS/Mandible'));
  fs.mkdirSync(path.join(contents, 'Resources/scripts'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>Mandible Private Service Proof</string><key>CFBundleExecutable</key><string>Mandible</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
  fs.copyFileSync(process.execPath, path.join(contents, 'MacOS/mandible-bun'), fs.constants.COPYFILE_FICLONE);
  fs.writeFileSync(path.join(contents, 'Resources/service-fixture.json'), JSON.stringify({ accountHome: fixture }));
  fs.writeFileSync(path.join(contents, 'Resources/release.json'), JSON.stringify({ schema: 'mandible-installed-release@1',
    native: { bun: '../MacOS/mandible-bun' }, entrypoints: { service: 'scripts/bundle-service.mjs' } }));
  fs.writeFileSync(path.join(contents, 'Resources/scripts/bundle-service.mjs'), `import fs from 'node:fs';
const output = process.env.HOME + '/heartbeat.json';
const tick = () => fs.writeFileSync(output, JSON.stringify({ pid: process.pid, at: Date.now(), root: process.env.MANDIBLE_RELEASE_ROOT }));
tick(); setInterval(tick, 50);
`);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', path.dirname(contents)]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.dirname(contents)]);
  const app = path.dirname(contents);
  const ownerFile = path.join(fixture, '.mandible/config/local-sessions/bundle-owner.json');
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
  const verification = installedApplicationVerification(app, applicationIdentity(app));
  const owner = { schema: 'mandible-bundle-owner@1', bundleRoot: app, verification };
  fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, verification: { ...verification, manifestSha256: '0'.repeat(64) } }));
  const refused = spawnSync(executable, ['foreground', 'backend'], { encoding: 'utf8', timeout: 3000 });
  const stderr = path.join(fixture, '.cache/mandible/production-stderr.log');
  if (refused.status !== 1 || fs.existsSync(path.join(fixture, 'heartbeat.json'))
      || !fs.readFileSync(stderr, 'utf8').includes('Application manifest differs from its verified installation receipt.')) {
    throw new Error(`The native launcher did not refuse the mismatched manifest before dispatch: ${refused.stderr || refused.error?.message}`);
  }
  fs.writeFileSync(ownerFile, JSON.stringify(owner));
  registered = true;
  const registration = control('register');
  if (registration.status !== 'enabled') throw new Error(`Native background permission is ${registration.status}; private registration did not start.`);
  await deadline(() => fs.existsSync(path.join(fixture, 'heartbeat.json')), 'first heartbeat', 20_000);
  const first = JSON.parse(fs.readFileSync(path.join(fixture, 'heartbeat.json'), 'utf8'));
  await deadline(() => JSON.parse(fs.readFileSync(path.join(fixture, 'heartbeat.json'), 'utf8')).at > first.at, 'independent heartbeat');
  const detail = run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
  const loaded = parseLoadedService(detail);
  const actualExecutable = run('/bin/ps', ['-ww', '-p', String(loaded.pid), '-o', 'comm=']);
  if (loaded.pid !== first.pid || loaded.bundleProgram !== 'Contents/MacOS/mandible-service' || loaded.parentBundleIdentifier !== identifier
      || fs.realpathSync(actualExecutable) !== fs.realpathSync(path.join(contents, 'MacOS/mandible-bun'))
      || loaded.argv.join('|') !== 'mandible-service|foreground|backend') throw new Error(`Unexpected owned service evidence: ${JSON.stringify(loaded)}\n${detail}`);
  const relocated = path.join(fixture, 'Relocated Service.app');
  fs.renameSync(path.dirname(contents), relocated);
  contents = path.join(relocated, 'Contents');
  executable = path.join(contents, 'MacOS/mandible-service');
  if (control('status').status !== 'enabled') throw new Error('Native registration was lost after app relocation.');
  const relocatedExecutable = run('/bin/ps', ['-ww', '-p', String(loaded.pid), '-o', 'comm=']);
  process.stdout.write(`${JSON.stringify({ passed: true, registration, loaded, registrationProcessExited: true, signedPrivateApp: true,
    rejectedManifestBeforeDispatch: true, relocatedRegistration: true, relocatedExecutable })}\n`);
} catch (error) {
  process.stderr.write(spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8', timeout: 2500 }).stdout || 'No private job remains.\n');
  throw error;
} finally {
  if (registered) {
    control('unregister');
    await deadline(() => spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8', timeout: 2500 }).status !== 0, 'unregistered job');
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}
