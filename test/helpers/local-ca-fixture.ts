import fs from 'node:fs';
import path from 'node:path';
import { localCaPaths } from '../../scripts/local-ca-trust.mjs';

export function localCaFixture(home: string) {
  const paths = localCaPaths(home);
  fs.mkdirSync(path.dirname(paths.installationAuthority), { recursive: true });
  fs.writeFileSync(paths.installationAuthority, 'installation-test');
  let nativeTrusted = false;
  let approvals = 0;
  let bootstraps = 0;
  let closes = 0;
  let deny = false;
  const effects = {
    bootstrap: async () => {
      bootstraps++;
      fs.mkdirSync(path.dirname(paths.rootCert), { recursive: true });
      if (!fs.existsSync(paths.rootCert)) fs.writeFileSync(paths.rootCert, '-----BEGIN CERTIFICATE-----\ntest-root\n-----END CERTIFICATE-----\n');
      if (!fs.existsSync(paths.rootKey)) fs.writeFileSync(paths.rootKey, 'test-key');
      return {
        probePinnedRoot: async () => true,
        probeNativeTrust: async () => nativeTrusted ? 'trusted' : 'untrusted',
        close: async () => { closes++; },
      };
    },
    approveTrust: async () => {
      approvals++;
      if (deny) throw new Error('operator declined macOS approval');
      nativeTrusted = true;
    },
  };
  return { paths, effects, counts: () => ({ approvals, bootstraps, closes }), setDenied: () => { deny = true; }, setNativeTrusted: (value: boolean) => { nativeTrusted = value; } };
}
