import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type PanelGeometry = {
  width: number;
  variant: 'with-actions' | 'single';
  columns: string;
  left: { left: number; right: number; top: number };
  right: { left: number; right: number; top: number } | null;
};

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

function renderPanelGeometry(): PanelGeometry[] {
  const chrome = CHROME_CANDIDATES.find(existsSync);
  if (!chrome) throw new Error('A Chromium browser is required for the Auth detail responsive regression.');

  const authCss = readFileSync(resolve('ui/src/styles/auth.css'), 'utf8');
  const cases = [
    { width: 760, variant: 'with-actions' },
    { width: 1119, variant: 'with-actions' },
    { width: 1120, variant: 'with-actions' },
    { width: 1400, variant: 'with-actions' },
    { width: 1400, variant: 'single' },
  ];
  const payload = JSON.stringify({ cases, authCss }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body><script>
    const { cases, authCss } = ${payload};
    const results = [];
    const edges = (node) => {
      const bounds = node.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top };
    };
    for (const entry of cases) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'display:block;border:0;width:' + entry.width + 'px;height:320px';
      frame.addEventListener('load', () => {
        const doc = frame.contentDocument;
        const panels = doc.querySelector('.auth-detail__panels');
        const left = doc.querySelector('.auth-detail__left-col');
        const right = doc.querySelector('.auth-detail__right-col');
        results.push({
          ...entry,
          columns: getComputedStyle(panels).gridTemplateColumns,
          left: edges(left),
          right: right ? edges(right) : null,
        });
        if (results.length === cases.length) document.title = btoa(JSON.stringify(results));
      }, { once: true });
      const right = entry.variant === 'with-actions'
        ? '<aside class="auth-detail__right-col"><section class="auth-action-bundle">On merge...</section></aside>'
        : '';
      frame.srcdoc = '<!doctype html><style>*{box-sizing:border-box}html,body{margin:0}.auth-detail-pane{width:100%}'
        + authCss + '</style><section class="auth-detail-pane"><div class="auth-detail__body"><div class="auth-detail__panels auth-detail__panels--'
        + entry.variant + '"><main class="auth-detail__left-col"><section class="panel">Commit Message</section><section class="panel">Specification</section></main>'
        + right + '</div></div></section>';
      document.body.append(frame);
    }
  </script></body></html>`;

  const rendered = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--dump-dom',
    '--window-size=1600,1200',
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  ], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium Auth detail fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium Auth detail fixture did not return measurements.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as PanelGeometry[];
}

describe('Auth detail responsive action layout', () => {
  it('stacks by detail width, then splits near 1.5x the annotated width', () => {
    const geometries = renderPanelGeometry();
    const find = (width: number, variant: PanelGeometry['variant']) =>
      geometries.find((entry) => entry.width === width && entry.variant === variant)!;

    for (const width of [760, 1119]) {
      const geometry = find(width, 'with-actions');
      expect(geometry.columns.trim().split(/\s+/)).toHaveLength(1);
      expect(geometry.right!.top).toBeGreaterThan(geometry.left.top);
    }

    for (const width of [1120, 1400]) {
      const geometry = find(width, 'with-actions');
      expect(geometry.columns.trim().split(/\s+/)).toHaveLength(2);
      expect(geometry.right!.left).toBeGreaterThan(geometry.left.right);
      expect(geometry.right!.top).toBe(geometry.left.top);
    }

    const single = find(1400, 'single');
    expect(single.columns.trim().split(/\s+/)).toHaveLength(1);
    expect(single.right).toBeNull();
  });
});
