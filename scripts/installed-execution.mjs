import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The provisioned payload and candidate gates share the same developer-resource denial. */
export function installedExecutionProfile({ checkout, commonDirectory, app }) {
  const denied = [checkout, path.dirname(commonDirectory), path.join(os.homedir(), '.dotfiles'),
    path.join(os.homedir(), '.local/share/mandible/runtimes'), path.join(os.homedir(), '.bun'), '/opt/homebrew', '/usr/local'];
  return `(version 1)(allow default)\n${[...new Set(denied)].filter(file => fs.existsSync(file)).map(file => `(deny file-read* (subpath ${JSON.stringify(fs.realpathSync(file))}))`).join('\n')}\n(deny file-write* (subpath ${JSON.stringify(fs.realpathSync(app))}))\n(deny network-outbound (remote ip "*:80") (remote ip "*:443"))`;
}
