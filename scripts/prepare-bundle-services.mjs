import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceRoles, bundleServiceLabel } from './bundle-service-roles.mjs';

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
