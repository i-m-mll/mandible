// @provisioned chromium
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

it('places the proof return link above the actual splash and leaves the overridden document through real navigation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mandible-splash-return-'));
  try {
    mkdirSync(join(directory, 'proof'));
    const contents = `import { appendNativeSplashReturnLink } from './test/provisioned/fixtures/native-app-splash-return';
      import { appHistory } from './ui/src/app-history';
      window.proofOverride = true; window.fetch = () => Promise.reject(new Error('controlled proof fetch'));
      window.EventSource = class ProofEvents {}; appHistory();
      const link = appendNativeSplashReturnLink(new URL('../index.html', location.href));
      const rect = link.getBoundingClientRect();
      if (document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) !== link) throw new Error('Return link is covered by splash');
      link.click();`;
    const bundle = buildSync({ stdin: { contents, resolveDir: resolve('.'), sourcefile: 'native-splash-return-proof.ts' }, bundle: true,
      write: false, format: 'iife', platform: 'browser' }).outputFiles[0]!.text;
    const styles = readFileSync(resolve('ui/src/styles/logs.css'), 'utf8');
    writeFileSync(join(directory, 'proof/index.html'), `<!doctype html><style>${styles}</style><div class="rebuilding-splash">Starting Mandible…</div><script>${bundle.replaceAll('</script', '<\\/script')}</script>`);
    writeFileSync(join(directory, 'index.html'), '<!doctype html><script>document.title = window.proofOverride === undefined && window.EventSource.name !== "ProofEvents" ? "full-navigation-ok" : "proof-overrides-retained";</script>');
    const result = runChromium(['--virtual-time-budget=2000', '--dump-dom', '--window-size=800,600', 'file://' + join(directory, 'proof/index.html')], { encoding: 'utf8', maxBuffer: 1_000_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('<title>full-navigation-ok</title>');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
