import { installedResourceRoot, installedRuntimeEnvironment, readInstalledRelease, releaseFile } from './installed-release.mjs';
import { channelEnvironment, installedChannelHome, ensureChannelInstallation, retireLegacyChannels } from './channel-installation.mjs';

const root = installedResourceRoot();
if (!root) throw new Error('Installed command requires an installed Mandible release.');
const release = readInstalledRelease(root);
if (process.argv[2] === 'channel') {
  const home = installedChannelHome();
  const active = await ensureChannelInstallation({ home, resources: root, release });
  retireLegacyChannels({ home, resources: root });
  const environment = channelEnvironment(active);
  process.chdir(active.directory);
  process.execve(active.runtime, [active.runtime, '--no-install', active.bridge, ...process.argv.slice(3)], environment);
} else if (process.argv[2] === '--runtime') {
  process.stdout.write(`${releaseFile(root, release.native.bun)}\n`);
} else {
  process.execve('/bin/zsh', ['zsh', releaseFile(root, 'cli/main.zsh'), ...process.argv.slice(2)], installedRuntimeEnvironment(root));
}
