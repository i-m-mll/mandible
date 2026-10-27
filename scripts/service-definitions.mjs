import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { bundleServiceLabel } from './bundle-service-roles.mjs';

const execute = promisify(execFile);

export function serviceInstallationContext({ home = path.join(os.userInfo().homedir, '.mandible'), accountHome, domain = `gui/${process.getuid?.() ?? 0}`, bundleRoot = process.env.MANDIBLE_RELEASE_ROOT ? path.resolve(process.env.MANDIBLE_RELEASE_ROOT, '../..') : undefined } = {}) {
  const ownerHome = os.userInfo().homedir;
  accountHome ??= path.resolve(home) !== path.join(ownerHome, '.mandible') ? process.env.MANDIBLE_SERVICE_ACCOUNT_HOME || ownerHome : ownerHome;
  if (![home, accountHome].every(path.isAbsolute)) throw new Error('Installation and account homes must be absolute.');
  home = path.resolve(home);
  const runtimeDir = path.join(home, 'config/local-sessions');
  const ownerFile = path.join(runtimeDir, 'bundle-owner.json');
  if (!bundleRoot && fs.existsSync(ownerFile)) bundleRoot = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).bundleRoot;
  const suffix = home === path.join(os.userInfo().homedir, '.mandible') ? '' : `.${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
  return { home, accountHome, runtimeDir, domain, bundleRoot, serviceDir: path.join(accountHome, 'Library/LaunchAgents'), privateServiceDir: path.join(runtimeDir, 'launch-agents'),
    backendLabel: `${bundleServiceLabel('backend')}${suffix}`, gatewayLabel: `${bundleServiceLabel('gateway')}${suffix}` };
}

export function parseLoadedService(detail) {
  const block = name => detail.match(new RegExp(`\\n\\s*${name} = \\{\\n([\\s\\S]*?)\\n\\s*\\}`))?.[1];
  const environment = Object.fromEntries((block('environment')?.split('\n') ?? []).flatMap(line => {
    const match = line.trim().match(/^([^ ]+) => (.*)$/);
    return match && !['OSLogRateLimit', 'XPC_SERVICE_NAME'].includes(match[1]) ? [[match[1], match[2]]] : [];
  }));
  const field = name => detail.split('\n').map(line => line.trim()).find(line => line.startsWith(`${name} = `))?.slice(name.length + 3);
  return { argv: block('arguments')?.split('\n').map(line => line.trim()).filter(Boolean) ?? [], environment,
    program: field('program'),
    bundleProgram: field('program identifier')?.replace(/ \(mode: \d+\)$/, ''), parentBundleIdentifier: field('parent bundle identifier'),
    workingDirectory: field('working directory'), stdoutPath: field('stdout path'), stderrPath: field('stderr path'),
    keepAlive: /\bkeepalive\b/.test(field('properties') ?? ''), pid: Number(field('pid')) || null };
}

export function differingServiceFields(record, job) {
  if (record.BundleProgram) return [
    ['Program', job.program === path.join(record.bundleRoot, record.BundleProgram)],
    ['ProgramArguments', JSON.stringify(record.ProgramArguments) === JSON.stringify(job.argv)],
  ].filter(([, equal]) => !equal).map(([field]) => field);
  const normalized = environment => JSON.stringify(Object.entries(environment ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return [
    ['Program', job.program === undefined || job.program === record.ProgramArguments[0]],
    ['ProgramArguments', JSON.stringify(record.ProgramArguments) === JSON.stringify(job.argv)],
    ['EnvironmentVariables', normalized(record.EnvironmentVariables) === normalized(job.environment)],
    ['WorkingDirectory', record.WorkingDirectory === job.workingDirectory],
    ['StandardOutPath', record.StandardOutPath === job.stdoutPath],
    ['StandardErrorPath', record.StandardErrorPath === job.stderrPath],
    ['KeepAlive', record.KeepAlive === undefined || record.KeepAlive === job.keepAlive],
  ].filter(([, equal]) => !equal).map(([field]) => field);
}

export const loadedServiceMatches = (record, job) => differingServiceFields(record, job).length === 0;

/** Identity comes from exact installation paths, never the label/comment alone. */
export function ownsServiceDefinition(context, service, record) {
  if (!record || record.Label !== context[`${service}Label`]) return false;
  const argv = record.ProgramArguments;
  const env = record.EnvironmentVariables ?? {};
  if (record.BundleProgram) {
    return !!context.bundleRoot && record.BundleProgram === 'Contents/MacOS/mandible-service'
      && JSON.stringify(argv) === JSON.stringify(['mandible-service', 'foreground', service])
      && (!record.parentBundleIdentifier || record.parentBundleIdentifier === 'bio.mll.mandible')
      && (!record.Program || record.Program === path.join(context.bundleRoot, record.BundleProgram));
  }
  if (!Array.isArray(argv) || !argv.every(value => typeof value === 'string') || !path.isAbsolute(argv[0] ?? '')) return false;
  for (const [key, expected] of Object.entries({ MANDIBLE_HOME: context.home,
    MANDIBLE_LOCAL_SESSION_AUTHORITY_DIR: context.runtimeDir, MANDIBLE_CLIENT_AUTH_DIR: path.join(context.home, 'config/client-auth') })) {
    if (env[key] !== undefined && env[key] !== expected) return false;
  }
  if (env.MANDIBLE_INSTALLATION_ID !== undefined) {
    const authority = fs.readFileSync(path.join(context.home, 'config/client-auth/authority-id'), 'utf8').trim();
    if (!authority || env.MANDIBLE_INSTALLATION_ID !== authority) return false;
  }
  if (record.Program !== undefined && record.Program !== argv[0]) return false;
  const interpreter = ['bun', 'node'].includes(path.basename(argv[0]));
  if (service === 'backend') return interpreter && argv.length === 3 && argv[1] === path.join(context.runtimeDir, 'production-runner.mjs') && argv[2] === 'run';
  const caddyRoot = path.join(context.home, 'runtime/caddy');
  const caddy = path.dirname(path.dirname(argv[0])) === caddyRoot && path.basename(argv[0]) === 'caddy'
    && JSON.stringify(argv.slice(1)) === JSON.stringify(['run', '--config', path.join(context.runtimeDir, 'Caddyfile'), '--adapter', 'caddyfile']);
  const root = env.MANDIBLE_PRODUCTION_ROOT;
  const legacy = interpreter && typeof root === 'string' && path.isAbsolute(root) && argv.length === 3
    && argv[1] === path.join(root, 'scripts/local-front-door.mjs') && argv[2] === 'serve'
    && env.MANDIBLE_HOME === context.home && env.MANDIBLE_RUNTIME_SUPERVISED === '1';
  return caddy || legacy;
}

const refusal = (service, label, category, fields, message) => ({ ok: false, refusal: { service, label, category, fields, message } });

export function loadedServiceDefinition(label, job) {
  if (job.argv?.[0] === 'mandible-service' && job.argv[1] === 'foreground') return {
    Label: label, BundleProgram: 'Contents/MacOS/mandible-service', Program: job.program,
    parentBundleIdentifier: job.parentBundleIdentifier,
    ProgramArguments: job.argv, bundleRoot: job.program ? path.resolve(job.program, '../../..') : undefined,
  };
  return { Label: label, ProgramArguments: job.argv, EnvironmentVariables: job.environment,
    WorkingDirectory: job.workingDirectory, StandardOutPath: job.stdoutPath, StandardErrorPath: job.stderrPath, KeepAlive: job.keepAlive };
}

function completeDefinition(record) {
  if (record?.BundleProgram) return typeof record.BundleProgram === 'string' && Array.isArray(record.ProgramArguments);
  return record && Array.isArray(record.ProgramArguments) && record.ProgramArguments.length > 0
    && record.ProgramArguments.every(value => typeof value === 'string')
    && [record.WorkingDirectory, record.StandardOutPath, record.StandardErrorPath].every(value => typeof value === 'string' && path.isAbsolute(value))
    && typeof record.KeepAlive === 'boolean' && record.EnvironmentVariables && typeof record.EnvironmentVariables === 'object'
    && !Array.isArray(record.EnvironmentVariables) && Object.values(record.EnvironmentVariables).every(value => typeof value === 'string');
}

/** Successful observation means ownership is safe; differing definitions remain data. */
export function assessServiceObservation(context, service, installed, job, { desired } = {}) {
  const label = context[`${service}Label`];
  const loadedDefinition = job.loaded ? loadedServiceDefinition(label, job) : null;
  for (const [source, record] of [...installed.map(item => [item.file, item.record]), ...(loadedDefinition ? [['loaded', loadedDefinition]] : [])]) {
    if (source === 'loaded' && record.BundleProgram && (!job.program || job.parentBundleIdentifier !== 'bio.mll.mandible')) {
      return refusal(service, label, 'unreadable_state', [], 'Native bundle ownership evidence is incomplete; preserving the registration.');
    }
    if (!completeDefinition(record)) return refusal(service, label, 'unreadable_state', [], `Ownership evidence for ${source} service ${label} is incomplete; preserving it.`);
    let owned;
    try { owned = ownsServiceDefinition(context, service, record); }
    catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot establish ownership for ${source} service ${label}: ${error.message}`); }
    if (!owned || source === 'loaded' && !record.BundleProgram && job.program !== undefined && job.program !== record.ProgramArguments[0]) {
      return refusal(service, label, 'ownership_conflict', [], `${source} service ${label} is not owned by this installation; preserving it.`);
    }
  }
  return { ok: true, observation: { service, label, installed, job, loadedDefinition, desired: desired ?? null,
    differences: installed.map(item => ({ file: item.file, fields: job.loaded ? differingServiceFields(item.record, job) : [] })),
    desiredDifferences: desired && job.loaded ? differingServiceFields(desired, job) : [] } };
}

/** Ownership-only admission predicate for service reconciliation. */
export function serviceOwnershipReady(inspection) { return inspection.ok; }

/** Admission for a handoff that must drain an exact running backend. */
export function runtimeHandoffReadiness(inspection) {
  if (!inspection.ok) return inspection;
  const backend = inspection.observations.find(item => item.service === 'backend');
  if (!backend?.job.loaded || !backend.job.pid) return refusal('backend', backend?.label ?? 'backend', 'missing_definition', [], 'The production backend is not running, so its update cannot start yet.');
  return inspection;
}

/** Strict controller postcondition, distinct from ownership-only admission. */
export function matchingServiceDefinitions(inspection) {
  if (!inspection.ok) return inspection;
  for (const observation of inspection.observations) {
    const { service, label, installed, job, differences } = observation;
    if (installed.length !== 1) return refusal(service, label, installed.length ? 'duplicate_label' : 'missing_definition', [], `${label} must have exactly one installed definition after reconciliation.`);
    const record = installed[0].record;
    if (!record.BundleProgram && (record.Program !== undefined || record.KeepAlive !== true)) return refusal(service, label, 'malformed_definition', [], `${label} lacks the managed definition contract.`);
    if (job.loaded && differences[0].fields.length) return refusal(service, label, 'definition_mismatch', differences[0].fields, `Loaded service ${label} differs from its installed definition: ${differences[0].fields.join(', ')}.`);
  }
  return inspection;
}

function loadedJob(service, label, result, context) {
  if (result.status === 0) {
    const job = { loaded: true, ...parseLoadedService(result.stdout) };
    if (context.bundleRoot && job.bundleProgram) {
      if (job.bundleProgram !== 'Contents/MacOS/mandible-service' || job.parentBundleIdentifier !== 'bio.mll.mandible'
          || JSON.stringify(job.argv) !== JSON.stringify(['mandible-service', 'foreground', service])) {
        return refusal(service, label, 'ownership_conflict', [], 'The loaded service has a different native bundle identity.');
      }
      if (job.pid) {
        const executable = spawnSync('/bin/ps', ['-ww', '-p', String(job.pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2500 });
        if (executable.error || executable.status !== 0) return refusal(service, label, 'unreadable_state', [], 'Cannot establish the loaded bundle process executable.');
        const actual = executable.stdout.trim();
        // launchd publishes its PID before xpcproxy execs the native helper,
        // whose initial comm can itself precede the full bundled Bun path.
        if (['xpcproxy', 'mandible-service'].includes(actual)) {
          const birth = spawnSync('/bin/ps', ['-p', String(job.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2500 });
          const pending = refusal(service, label, 'starting', ['processExecutable'], `Native service ${label} PID ${job.pid} is still starting (${actual}); bundle process ownership is not confirmed yet.`);
          pending.refusal.evidence = { service, label, executable: actual, pid: job.pid,
            startedAt: birth.status === 0 ? birth.stdout.trim() : null,
            runs: Number(result.stdout.match(/\bruns = (\d+)/)?.[1]) || 0,
            bundleProgram: job.bundleProgram, parentBundleIdentifier: job.parentBundleIdentifier };
          return pending;
        }
        if (![path.join(context.bundleRoot, 'Contents/MacOS/mandible-bun'), path.join(context.bundleRoot, 'Contents/MacOS/mandible-service')].includes(actual)) {
          return refusal(service, label, 'ownership_conflict', ['processExecutable'], `The loaded process PID ${job.pid} belongs to another bundle location (${actual}); preserving it.`);
        }
      } else {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(path.join(context.runtimeDir, 'bundle-owner.json'), 'utf8')); } catch { /* No ownership evidence is a refusal below. */ }
        if (owner?.bundleRoot !== context.bundleRoot) return refusal(service, label, 'ownership_conflict', [], 'The dormant registration has no matching bundle owner.');
      }
      job.program = path.join(context.bundleRoot, job.bundleProgram);
    }
    return { ok: true, job };
  }
  if (/Could not find service|service not found/i.test(result.stderr)) return { ok: true, job: { loaded: false, pid: null } };
  return refusal(service, label, 'unreadable_state', [], `Cannot inspect launchd service ${label}: ${result.stderr}`);
}

function installedDefinition(file, bytes, record) { return { file, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), record }; }
const serviceFiles = (context, label) => [context.serviceDir, context.privateServiceDir,
  ...(context.bundleRoot ? [path.join(context.bundleRoot, 'Contents/Library/LaunchAgents')] : [])].map(dir => path.join(dir, `${label}.plist`));
const combine = results => results.find(result => !result.ok) ?? { ok: true, observations: results.map(result => result.observation) };

/** Read-only: no runtime resolution, installation, receipts, or daemon imports. */
export async function inspectServiceDefinitions(context, options = {}) {
  return combine(await Promise.all(['backend', 'gateway'].map(async service => {
    const label = context[`${service}Label`];
    try {
      const installed = [];
      for (const file of serviceFiles(context, label)) {
        let bytes;
        try { bytes = await fs.promises.readFile(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        let record;
        try { record = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 2500, maxBuffer: 1024 * 1024 })).stdout); }
        catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot establish ownership of ${file}: ${error.message}`); }
        if (record.BundleProgram) record.bundleRoot = context.bundleRoot;
        installed.push(installedDefinition(file, bytes, record));
      }
      let result;
      try { result = { status: 0, ...await execute('/bin/launchctl', ['print', `${context.domain}/${label}`], { timeout: 2500, maxBuffer: 1024 * 1024 }) }; }
      catch (error) { result = { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr || error.message }; }
      const loaded = loadedJob(service, label, result, context);
      return loaded.ok ? assessServiceObservation(context, service, installed, loaded.job, { ...options, desired: options.desired?.[service] }) : loaded;
    } catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot inspect ${label}: ${error.message}`); }
  })));
}

/** Controller-only synchronous entry point, with the same classifier and contract. */
export function inspectServiceDefinitionsSync(context, options = {}) {
  return combine(['backend', 'gateway'].map(service => {
    const label = context[`${service}Label`];
    try {
      const installed = [];
      for (const file of serviceFiles(context, label)) {
        let bytes;
        try { bytes = fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 2500 });
        let record;
        try { if (parsed.error || parsed.status !== 0) throw new Error(parsed.stderr || parsed.error?.message); record = JSON.parse(parsed.stdout); }
        catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot establish ownership of ${file}: ${error.message}`); }
        if (record.BundleProgram) record.bundleRoot = context.bundleRoot;
        installed.push(installedDefinition(file, bytes, record));
      }
      const result = spawnSync('/bin/launchctl', ['print', `${context.domain}/${label}`], { encoding: 'utf8', timeout: 2500 });
      const loaded = loadedJob(service, label, { ...result, stderr: result.error?.message || result.stderr || '' }, context);
      return loaded.ok ? assessServiceObservation(context, service, installed, loaded.job, { ...options, desired: options.desired?.[service] }) : loaded;
    } catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot inspect ${label}: ${error.message}`); }
  }));
}
