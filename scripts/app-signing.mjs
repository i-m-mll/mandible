import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';

function mergePatch(document, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = document && typeof document === 'object' && !Array.isArray(document) ? { ...document } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function configFile(file) {
  const bytes = fs.readFileSync(file, 'utf8');
  return file.endsWith('.toml') ? parseToml(bytes) : JSON5.parse(bytes);
}

/** Same configuration order as the pinned Tauri CLI: base, platform, ordered CLI patches. */
export function resolveAppSigning(root, configArguments = [], environment = process.env) {
  const directory = path.join(root, 'src-tauri');
  const base = ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml'].map(name => path.join(directory, name)).find(file => fs.existsSync(file));
  if (!base) throw new Error('Tauri configuration is missing.');
  let config = configFile(base);
  const platform = ['tauri.macos.conf.json', 'tauri.macos.conf.json5', 'Tauri.macos.toml'].map(name => path.join(directory, name)).find(file => fs.existsSync(file));
  if (platform) config = mergePatch(config, configFile(platform));
  // Tauri combines CLI patches without deleting null keys, then applies the combined RFC 7396 patch.
  const combine = (previous, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const result = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
    for (const [key, value] of Object.entries(patch)) result[key] = combine(result[key], value);
    return result;
  };
  let patch = {};
  for (const argument of configArguments) patch = combine(patch, argument.startsWith('{') ? JSON.parse(argument) : configFile(path.resolve(root, argument)));
  config = mergePatch(config, patch);
  const mac = config.bundle?.macOS ?? {};
  const identity = Object.hasOwn(environment, 'APPLE_SIGNING_IDENTITY') ? environment.APPLE_SIGNING_IDENTITY : mac.signingIdentity;
  if (typeof identity !== 'string' || !identity.trim()) throw new Error('Select an explicit Tauri macOS signingIdentity or APPLE_SIGNING_IDENTITY; use "-" for a local ad-hoc candidate.');
  const certificate = environment.APPLE_CERTIFICATE;
  const certificatePassword = environment.APPLE_CERTIFICATE_PASSWORD;
  if ((certificate !== undefined) !== (certificatePassword !== undefined)) throw new Error('APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD must be supplied together.');
  const appleId = [environment.APPLE_ID, environment.APPLE_PASSWORD, environment.APPLE_TEAM_ID];
  const api = [environment.APPLE_API_KEY, environment.APPLE_API_ISSUER];
  let notarization = null;
  if (appleId.some(value => value !== undefined)) {
    if (!appleId.every(value => value)) throw new Error('Apple ID notarization requires APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID.');
    notarization = { kind: 'apple-id', appleId: appleId[0], password: appleId[1], teamId: appleId[2] };
  } else if (api.some(value => value !== undefined) || environment.APPLE_API_KEY_PATH !== undefined) {
    if (!api.every(value => value)) throw new Error('API-key notarization requires APPLE_API_KEY and APPLE_API_ISSUER.');
    const name = `AuthKey_${api[0]}.p8`;
    const key = environment.APPLE_API_KEY_PATH ? path.resolve(root, environment.APPLE_API_KEY_PATH)
      : [path.join(root, 'private_keys'), ...['private_keys', '.private_keys', '.appstoreconnect/private_keys'].map(p => path.join(environment.HOME || os.homedir(), p))]
        .map(directory => path.join(directory, name)).find(file => fs.existsSync(file));
    if (!key || !fs.statSync(key).isFile()) throw new Error('Notarization API private key is missing. Set APPLE_API_KEY_PATH.');
    notarization = { kind: 'api-key', keyId: api[0], issuer: api[1], key };
  }
  if (identity === '-' && (notarization || certificate !== undefined)) throw new Error('Ad-hoc signing cannot use distributor certificates or notarization credentials. Select the distributor identity explicitly.');
  const entitlements = mac.entitlements == null ? null : typeof mac.entitlements === 'string' ? path.resolve(directory, mac.entitlements) : mac.entitlements;
  return { config, identity, certificate, certificatePassword, entitlements, hardenedRuntime: mac.hardenedRuntime !== false, notarization };
}

/** Apple operations never include command arguments or credential values in errors. */
export function appleTool(command, args, { timeout = 60_000, secrets = [], output = 'stdout', env } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env });
  if (result.error || result.status !== 0) {
    let message = result.stderr || result.error?.message || `exit ${result.status}`;
    for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
    throw new Error(`${path.basename(command)} failed: ${message.trim()}`);
  }
  return output === 'stderr' ? result.stderr : result.stdout;
}

export function requireNativeAppSigning(plan) {
  if (!plan?.identity || plan.identity === '-') throw new Error('Native service qualification requires an Apple-issued signing identity. Provision an Apple Development or Developer ID Application certificate and select it with APPLE_SIGNING_IDENTITY or Tauri macOS.signingIdentity. Ad-hoc signing cannot qualify native replacement.');
  return plan;
}

export function nativeSigningIdentifier(appIdentifier, role) {
  const suffix = { serviceHelper: 'service', trustHelper: 'trust' }[role];
  if (!suffix) return null;
  if (typeof appIdentifier !== 'string' || !/^[A-Za-z0-9.-]+$/.test(appIdentifier)) throw new Error('Native signing requires the app bundle identifier.');
  return `${appIdentifier}.${suffix}`;
}

export function verifyNativeAppSignatures(app, signer, release) {
  if (signer.identity === '-') return;
  if (!/^[a-fA-F0-9]{40}$/.test(signer.identity)) throw new Error('Native signature verification requires the resolved signing certificate.');
  const evidence = signer.run('/usr/bin/codesign', ['--display', '--verbose=4', app], { output: 'stderr' });
  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(evidence)?.[1];
  const identifier = /^Identifier=([A-Za-z0-9.-]+)$/m.exec(evidence)?.[1];
  if (!team || !identifier || !release.native.serviceHelper) throw new Error('Native package has no verifiable app/helper signing identity.');
  const identity = `anchor apple generic and certificate leaf = H"${signer.identity}" and certificate leaf[subject.OU] = "${team}"`;
  for (const [file, id] of [[app, identifier], [path.resolve(app, 'Contents/Resources', release.native.serviceHelper), nativeSigningIdentifier(identifier, 'serviceHelper')]]) {
    signer.run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${identity} and identifier "${id}"`, file]);
  }
}

/** One keychain/identity lifetime covers every code signature and notarization operation. */
export function openAppSigner(plan, { until, accountHome } = {}) {
  if (accountHome !== undefined && !path.isAbsolute(accountHome)) throw new Error('Signing tool account home must be absolute.');
  const toolEnvironment = accountHome === undefined ? undefined : { ...process.env, HOME: accountHome };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-app-signing-'));
  const keychain = plan.certificate !== undefined ? path.join(temporary, 'signing.keychain-db') : null;
  const password = randomBytes(24).toString('hex');
  const secrets = [plan.certificate, plan.certificatePassword, plan.notarization?.password, password];
  const run = (command, args, options = {}) => {
    const timeout = Math.min(options.timeout ?? 60_000, until === undefined ? Infinity : until - Date.now());
    if (timeout <= 0) throw new Error('App signing deadline exceeded.');
    return appleTool(command, args, { ...options, timeout, secrets, env: toolEnvironment });
  };
  const close = () => {
    try { if (keychain && fs.existsSync(keychain)) appleTool('/usr/bin/security', ['delete-keychain', keychain], { timeout: 2500, secrets, env: toolEnvironment }); }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  };
  try {
    if (keychain) {
      const certificate = path.join(temporary, 'certificate.p12');
      fs.writeFileSync(certificate, Buffer.from(plan.certificate, 'base64'), { mode: 0o600 });
      run('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
      run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
      run('/usr/bin/security', ['import', certificate, '-k', keychain, '-P', plan.certificatePassword, '-T', '/usr/bin/codesign']);
      run('/usr/bin/security', ['set-keychain-settings', '-t', '3600', '-u', keychain]);
      run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    }
    if (plan.identity !== '-') {
      const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])]);
      const found = [...identities.matchAll(/\b([A-Fa-f0-9]{40}) "([^"]+)"/g)].filter(match => match[1].toLowerCase() === plan.identity.toLowerCase() || match[2].includes(plan.identity));
      if (found.length !== 1) throw new Error('The configured signing identity must select exactly one available code-signing certificate. Provision the selected Apple Development or Developer ID Application certificate in the keychain. No ad-hoc fallback is permitted.');
      plan = { ...plan, identity: found[0][1] };
    }
    return { identity: plan.identity, plan, run, temporary, close,
      sign(file, entitlements = null, hardened = plan.hardenedRuntime, identifier = null) {
        if (identifier !== null && (typeof identifier !== 'string' || !/^[A-Za-z0-9.-]+$/.test(identifier))) throw new Error('Invalid native signing identifier.');
        run('/usr/bin/codesign', ['--force', '--sign', plan.identity, ...(keychain ? ['--keychain', keychain] : []),
          ...(identifier ? ['--identifier', identifier] : []),
          ...(hardened ? ['--options', 'runtime'] : []), ...(plan.identity !== '-' ? ['--timestamp'] : []),
          ...(entitlements ? ['--entitlements', entitlements] : []), file]);
      },
    };
  } catch (error) {
    try { close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'App signing failed and its temporary keychain cleanup also failed.'); }
    throw error;
  }
}
