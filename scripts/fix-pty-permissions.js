#!/usr/bin/env node
// Ensure node-pty prebuilt spawn-helper binaries are executable.
// npm install doesn't always preserve execute bits from the tarball.
const fs = require('fs');
const path = require('path');

const prebuildsDir = path.join(__dirname, '../node_modules/node-pty/prebuilds');
if (!fs.existsSync(prebuildsDir)) {
  console.log('node-pty prebuilds not found, skipping');
  process.exit(0);
}
for (const platform of fs.readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, platform, 'spawn-helper');
  if (fs.existsSync(helper)) {
    fs.chmodSync(helper, 0o755);
    console.log(`chmod +x ${helper}`);
  }
}
