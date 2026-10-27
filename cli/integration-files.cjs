const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = text => createHash('sha256').update(text).digest('hex');

function standaloneOwned(text) {
  const marker = text.match(/\n<!-- MANDIBLE GENERATED sha256:([a-f0-9]{64}) -->\n$/);
  return Boolean(marker && digest(text.slice(0, marker.index)) === marker[1]);
}

function stampStandalone(text) {
  return `${text}\n<!-- MANDIBLE GENERATED sha256:${digest(text)} -->\n`;
}

function ownershipConflict(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // macOS exposes its system temporary directories through these root links.
    if (stat.isSymbolicLink() && !['/tmp', '/var', '/etc'].includes(current)) {
      return `Symlink is user-owned: ${current}. Select its real destination explicitly instead.`;
    }
  }
  return null;
}

module.exports = { ownershipConflict, standaloneOwned, stampStandalone };
