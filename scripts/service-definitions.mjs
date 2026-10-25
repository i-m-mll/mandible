import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function serviceInstallationContext({ home = path.join(os.userInfo().homedir, '.mandible'), accountHome, domain = `gui/${process.getuid?.() ?? 0}` } = {}) {
  const ownerHome = os.userInfo().homedir;
  accountHome ??= path.resolve(home) !== path.join(ownerHome, '.mandible') ? process.env.MANDIBLE_SERVICE_ACCOUNT_HOME || ownerHome : ownerHome;
  if (![home, accountHome].every(path.isAbsolute)) throw new Error('Installation and account homes must be absolute.');
  home = path.resolve(home);
  const runtimeDir = path.join(home, 'config/local-sessions');
  const suffix = home === path.join(os.userInfo().homedir, '.mandible') ? '' : `.${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
  return { home, accountHome, runtimeDir, domain, serviceDir: path.join(accountHome, 'Library/LaunchAgents'), privateServiceDir: path.join(runtimeDir, 'launch-agents'),
    backendLabel: `bio.mll.mandible.local-session-production${suffix}`, gatewayLabel: `bio.mll.mandible.local-front-door${suffix}` };
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
    workingDirectory: field('working directory'), stdoutPath: field('stdout path'), stderrPath: field('stderr path'),
    keepAlive: /\bkeepalive\b/.test(field('properties') ?? ''), pid: Number(field('pid')) || null };
}

export function differingServiceFields(record, job) {
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
  return { Label: label, ProgramArguments: job.argv, EnvironmentVariables: job.environment,
    WorkingDirectory: job.workingDirectory, StandardOutPath: job.stdoutPath, StandardErrorPath: job.stderrPath, KeepAlive: job.keepAlive };
}

function completeDefinition(record) {
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
    if (!completeDefinition(record)) return refusal(service, label, 'unreadable_state', [], `Ownership evidence for ${source} service ${label} is incomplete; preserving it.`);
    let owned;
    try { owned = ownsServiceDefinition(context, service, record); }
    catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot establish ownership for ${source} service ${label}: ${error.message}`); }
    if (!owned || source === 'loaded' && job.program !== undefined && job.program !== record.ProgramArguments[0]) {
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
    if (record.Program !== undefined || record.KeepAlive !== true) return refusal(service, label, 'malformed_definition', [], `${label} lacks the managed definition contract.`);
    if (job.loaded && differences[0].fields.length) return refusal(service, label, 'definition_mismatch', differences[0].fields, `Loaded service ${label} differs from its installed definition: ${differences[0].fields.join(', ')}.`);
  }
  return inspection;
}

function loadedJob(service, label, result) {
  if (result.status === 0) return { ok: true, job: { loaded: true, ...parseLoadedService(result.stdout) } };
  if (/Could not find service|service not found/i.test(result.stderr)) return { ok: true, job: { loaded: false, pid: null } };
  return refusal(service, label, 'unreadable_state', [], `Cannot inspect launchd service ${label}: ${result.stderr}`);
}

function installedDefinition(file, bytes, record) { return { file, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), record }; }
const serviceFiles = (context, label) => [context.serviceDir, context.privateServiceDir].map(dir => path.join(dir, `${label}.plist`));
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
        installed.push(installedDefinition(file, bytes, record));
      }
      let result;
      try { result = { status: 0, ...await execute('/bin/launchctl', ['print', `${context.domain}/${label}`], { timeout: 2500, maxBuffer: 1024 * 1024 }) }; }
      catch (error) { result = { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr || error.message }; }
      const loaded = loadedJob(service, label, result);
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
        installed.push(installedDefinition(file, bytes, record));
      }
      const result = spawnSync('/bin/launchctl', ['print', `${context.domain}/${label}`], { encoding: 'utf8', timeout: 2500 });
      const loaded = loadedJob(service, label, { ...result, stderr: result.error?.message || result.stderr || '' });
      return loaded.ok ? assessServiceObservation(context, service, installed, loaded.job, { ...options, desired: options.desired?.[service] }) : loaded;
    } catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot inspect ${label}: ${error.message}`); }
  }));
}
