// @vitest-environment node
import path from 'node:path';
import { expect, it } from 'vitest';
import { installedFileIdentity, readInstalledRelease, releaseFile } from '../../scripts/installed-release.mjs';
import { admissionScenario } from '../helpers/runtime-handoff-admission.js';

it('admits the saved actual v1 predecessor and releases its real compatibility lock after exit', async () => {
  const app = process.env.MANDIBLE_NATIVE_PROOF_PREDECESSOR_APP;
  if (!app || !path.isAbsolute(app)) throw new Error('Admission proof requires an explicit retained v1 MANDIBLE_NATIVE_PROOF_PREDECESSOR_APP.');
  const resources = path.join(app, 'Contents/Resources');
  const release = readInstalledRelease(resources);
  if ((release.handoff_protocol ?? 1) !== 1) throw new Error('Admission predecessor must declare the actual v1 handoff protocol.');
  const reader = releaseFile(resources, 'handoff/helper.mjs', release.layout);
  expect(installedFileIdentity(reader)).toEqual(release.files['handoff/helper.mjs']);
  await admissionScenario(1, reader);
});
