import { installedResourceRoot, installedRuntimeEnvironment, readInstalledRelease, releaseFile } from './installed-release.mjs';

const root = installedResourceRoot();
if (!root) throw new Error('Installed command requires an installed Mandible release.');
const release = readInstalledRelease(root);
if (process.argv[2] === '--runtime') {
  process.stdout.write(`${releaseFile(root, release.native.bun)}\n`);
} else {
  process.execve('/bin/zsh', ['zsh', releaseFile(root, 'cli/main.zsh'), ...process.argv.slice(2)], installedRuntimeEnvironment(root));
}
