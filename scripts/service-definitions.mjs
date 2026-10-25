import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const marker = 'Mandible runtime agent mandible-launch-agent@1';

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

export function ownsServiceDefinition(context, service, record) {
  if (record.Label !== context[`${service}Label`]) return false;
  const argv = record.ProgramArguments;
  if (!Array.isArray(argv) || !argv.every(value => typeof value === 'string') || !path.isAbsolute(argv[0] ?? '')) return false;
  if (service === 'backend') return argv.length === 3 && argv[1] === path.join(context.runtimeDir, 'production-runner.mjs') && argv[2] === 'run';
  return record.Comment === marker || argv.length === 3 && argv[1]?.endsWith('/scripts/local-front-door.mjs') && argv[2] === 'serve' && record.EnvironmentVariables?.MANDIBLE_RUNTIME_SUPERVISED === '1';
}

const refusal = (service, label, category, fields, message) => ({ ok: false, refusal: { service, label, category, fields, message, repairCommand: 'bun scripts/local-runtime.mjs restart' } });

function assess(context, service, files, record, loadedResult) {
  const label = context[`${service}Label`];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return refusal(service, label, 'malformed_definition', [], `Installed service ${label} is not a plist dictionary.`);
  if (!ownsServiceDefinition(context, service, record)) return refusal(service, label, 'ownership_conflict', [], `Installed service ${label} is not owned by this installation.`);
  if (record.Program !== undefined || record.KeepAlive !== true || ![record.WorkingDirectory, record.StandardOutPath, record.StandardErrorPath].every(value => typeof value === 'string' && path.isAbsolute(value))
    || !record.EnvironmentVariables || typeof record.EnvironmentVariables !== 'object' || Array.isArray(record.EnvironmentVariables)
    || Object.values(record.EnvironmentVariables).some(value => typeof value !== 'string')) {
    return refusal(service, label, 'malformed_definition', [], `Installed service ${label} lacks the managed definition contract.`);
  }
  let job;
  if (loadedResult.status === 0) job = { loaded: true, ...parseLoadedService(loadedResult.stdout) };
  else if (/Could not find service|service not found/i.test(loadedResult.stderr)) job = { loaded: false, pid: null };
  else return refusal(service, label, 'unreadable_state', [], `Cannot inspect launchd service ${label}: ${loadedResult.stderr}`);
  if (job.loaded) {
    const fields = differingServiceFields(record, job);
    if (fields.length) return refusal(service, label, 'definition_mismatch', fields, `Loaded service ${label} differs from its installed definition: ${fields.join(', ')}.`);
  }
  return { ok: true, observation: { service, label, file: files[0], definition: record, job } };
}

/** No runtime resolution, installation, receipts, imports from the daemon, or mutations. */
export async function inspectServiceDefinitions(context) {
  const results = await Promise.all(['backend', 'gateway'].map(async service => {
    const label = context[`${service}Label`];
    try {
      const files = [];
      for (const dir of [context.serviceDir, context.privateServiceDir]) {
        const file = path.join(dir, `${label}.plist`);
        try { await fs.promises.access(file); files.push(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (files.length !== 1) return refusal(service, label, files.length ? 'duplicate_label' : 'missing_definition', [], `${label} has ${files.length} installed definitions; expected one.`);
      let record;
      try { record = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', files[0]], { timeout: 2500, maxBuffer: 1024 * 1024 })).stdout); }
      catch (error) { return refusal(service, label, 'malformed_definition', [], `Cannot read definition for ${label}: ${error.message}`); }
      let loaded;
      try { loaded = { status: 0, ...await execute('/bin/launchctl', ['print', `${context.domain}/${label}`], { timeout: 2500, maxBuffer: 1024 * 1024 }) }; }
      catch (error) { loaded = { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr || error.message }; }
      return assess(context, service, files, record, loaded);
    } catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot inspect ${label}: ${error.message}`); }
  }));
  const failed = results.find(result => !result.ok);
  return failed ?? { ok: true, observations: results.map(result => result.observation) };
}

/** Controller-only synchronous entry point; daemon callers use inspectServiceDefinitions. */
export function inspectServiceDefinitionsSync(context) {
  const observations = [];
  for (const service of ['backend', 'gateway']) {
    const label = context[`${service}Label`];
    try {
      const files = [context.serviceDir, context.privateServiceDir].map(dir => path.join(dir, `${label}.plist`)).filter(file => fs.existsSync(file));
      if (files.length !== 1) return refusal(service, label, files.length ? 'duplicate_label' : 'missing_definition', [], `${label} has ${files.length} installed definitions; expected one.`);
      const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', files[0]], { encoding: 'utf8', timeout: 2500 });
      let record;
      try { if (parsed.error || parsed.status !== 0) throw new Error(parsed.stderr || parsed.error?.message); record = JSON.parse(parsed.stdout); }
      catch (error) { return refusal(service, label, 'malformed_definition', [], `Cannot read definition for ${label}: ${error.message}`); }
      const loaded = spawnSync('/bin/launchctl', ['print', `${context.domain}/${label}`], { encoding: 'utf8', timeout: 2500 });
      const result = assess(context, service, files, record, { ...loaded, stderr: loaded.error?.message || loaded.stderr || '' });
      if (!result.ok) return result;
      observations.push(result.observation);
    } catch (error) { return refusal(service, label, 'unreadable_state', [], `Cannot inspect ${label}: ${error.message}`); }
  }
  return { ok: true, observations };
}
