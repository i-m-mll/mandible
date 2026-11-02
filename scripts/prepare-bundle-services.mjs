import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { serviceRoles, bundleServiceLabel } from './bundle-service-roles.mjs';

export function buildBundleService(root, env = process.env) {
  const output = execFileSync('cargo', ['build', '--locked', '--release', '--bin', 'mandible-service',
    '--message-format=json-render-diagnostics', '--manifest-path', path.join(root, 'src-tauri/service-helper/Cargo.toml')], {
    cwd: root, env: { ...env, MACOSX_DEPLOYMENT_TARGET: '13.0' }, timeout: 60_000,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  const artifacts = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(message =>
    message.reason === 'compiler-artifact' && message.target.name === 'mandible-service'
      && message.target.kind.includes('bin') && message.executable);
  if (artifacts.length !== 1) throw new Error(`Cargo reported ${artifacts.length} mandible-service executables; expected exactly one.`);
  return artifacts[0].executable;
}

/** Staging only: call before signing the final app. No user paths enter signed descriptors. */
export function stageBundleServices(contents, helper, identifier = 'bio.mll.mandible') {
  const executable = path.join(contents, 'MacOS/mandible-service');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.copyFileSync(helper, executable);
  fs.chmodSync(executable, 0o755);
  const directory = path.join(contents, 'Library/LaunchAgents');
  fs.mkdirSync(directory, { recursive: true });
  for (const role of Object.keys(serviceRoles)) {
    const label = bundleServiceLabel(role, identifier);
    if (!/^[a-zA-Z0-9.-]+$/.test(label)) throw new Error('Invalid service identifier');
    fs.writeFileSync(path.join(directory, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>BundleProgram</key><string>Contents/MacOS/mandible-service</string>
<key>ProgramArguments</key><array><string>mandible-service</string><string>foreground</string><string>${role}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>20</integer>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [contents, helper] = process.argv.slice(2);
  if (!contents || !helper) throw new Error('Usage: prepare-bundle-services.mjs <app Contents> <built mandible-service>');
  stageBundleServices(path.resolve(contents), path.resolve(helper));
}
