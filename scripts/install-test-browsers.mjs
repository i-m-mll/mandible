import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const core = dirname(require.resolve('playwright-core/package.json'));
const { registry } = require(join(core, 'lib/server/registry/index.js'));
const names = process.argv.slice(2);
const requested = names.length ? names : ['chromium', 'chromium-headless-shell', 'firefox', 'webkit'];
for (const name of requested) {
  if (!['chromium', 'chromium-headless-shell', 'firefox', 'webkit'].includes(name)) throw new Error(`Unknown test browser: ${name}`);
  const entry = registry.findExecutable(name);
  const marker = join(entry.directory, 'INSTALLATION_COMPLETE');
  if (existsSync(marker) && existsSync(entry.executablePath())) continue;
  const temporary = mkdtempSync(join(tmpdir(), 'mandible-test-browser-'));
  try {
    const archive = join(temporary, 'browser.zip');
    const download = Bun.spawn(['curl', '--fail', '--location', '--max-time', '120', entry.downloadURLs[0], '--output', archive], { stdout: 'inherit', stderr: 'inherit' });
    if (await download.exited) throw new Error(`${name} download failed`);
    rmSync(entry.directory, { recursive: true, force: true }); mkdirSync(entry.directory, { recursive: true });
    // Playwright1.57's JS ZIP extraction hangs under pinned Bun after downloading; native unzip completes the same official archive.
    const extract = Bun.spawn(['unzip', '-q', archive, '-d', entry.directory], { stdout: 'inherit', stderr: 'inherit' });
    if (await extract.exited || !existsSync(entry.executablePath())) throw new Error(`${name} extraction failed`);
    writeFileSync(marker, ''); console.log(`${name} ${entry.browserVersion} ready`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
