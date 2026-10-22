// @provisioned chromium
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

type PanelGeometry = {
  width: number;
  variant: 'with-actions' | 'single';
  columns: string;
  left: { left: number; right: number; top: number };
  references: { left: number; right: number; top: number };
  actions: { left: number; right: number; top: number } | null;
  breakdownTop: number;
  breakdown: {
    clientWidth: number;
    scrollWidth: number;
    tabsClientWidth: number;
    tabsScrollWidth: number;
    viewClientWidth: number;
    viewScrollWidth: number;
    fileColumns: string;
  };
};

function renderPanelGeometry(): PanelGeometry[] {
  const authCss = readFileSync(resolve('ui/src/styles/auth.css'), 'utf8');
  const collapsibleCss = readFileSync(resolve('ui/src/styles/collapsible-panel.css'), 'utf8');
  const cases = [
    { width: 360, variant: 'single' },
    { width: 760, variant: 'with-actions' },
    { width: 1119, variant: 'with-actions' },
    { width: 1120, variant: 'with-actions' },
    { width: 1400, variant: 'with-actions' },
    { width: 1400, variant: 'single' },
  ];
  const payload = JSON.stringify({ cases, authCss, collapsibleCss }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body><script>
    const { cases, authCss, collapsibleCss } = ${payload};
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
        const references = doc.querySelector('.auth-detail__reference-rows');
        const actions = doc.querySelector('.auth-action-bundle');
        const breakdown = doc.querySelector('.auth-change-breakdown');
        const tabs = doc.querySelector('.auth-change-breakdown__tabs');
        const breakdownView = doc.querySelector('.auth-change-breakdown__view');
        const file = doc.querySelector('.auth-change-file');
        results.push({
          ...entry,
          columns: getComputedStyle(panels).gridTemplateColumns,
          left: edges(left),
          references: edges(references),
          actions: actions ? edges(actions) : null,
          breakdownTop: edges(breakdown).top,
          breakdown: {
            clientWidth: breakdown.clientWidth,
            scrollWidth: breakdown.scrollWidth,
            tabsClientWidth: tabs.clientWidth,
            tabsScrollWidth: tabs.scrollWidth,
            viewClientWidth: breakdownView.clientWidth,
            viewScrollWidth: breakdownView.scrollWidth,
            fileColumns: getComputedStyle(file).gridTemplateColumns,
          },
        });
        if (results.length === cases.length) document.title = btoa(JSON.stringify(results));
      }, { once: true });
      const actions = entry.variant === 'with-actions'
        ? '<section class="collapsible-panel auth-action-bundle">Actions on merge</section>'
        : '';
      const breakdown = '<section class="collapsible-panel collapsible-panel--expanded auth-change-breakdown"><div class="collapsible-panel__header">Change breakdown</div>'
        + '<div class="collapsible-panel__body auth-change-breakdown__body"><div class="auth-change-breakdown__totals"><span><strong>4</strong> files</span><span><strong>+15</strong> added</span></div>'
        + '<div class="auth-change-breakdown__tabs"><button>Language</button><button>Directory</button><button>File role</button><button>Generated / vendor</button><button>Largest files</button></div>'
        + '<div class="auth-change-breakdown__view"><div class="auth-change-groups"><div class="auth-change-groups__header"><span>Group</span><span>Files</span><span>+</span><span>−</span><span>Share</span></div>'
        + '<div class="auth-change-group"><button class="auth-change-group__row"><span class="auth-change-group__name">TypeScript</span><span>2</span><span>12</span><span>3</span><span>83%</span></button>'
        + '<ul class="auth-change-files"><li class="auth-change-file"><div class="auth-change-file__identity"><code class="auth-change-file__path">src/a-very-long-authentication-file-name.ts</code></div><div class="auth-change-file__metrics"><span>+10</span><span>−2</span><span>67%</span></div></li></ul></div></div></div></div></section>';
      frame.srcdoc = '<!doctype html><style>*{box-sizing:border-box}html,body{margin:0}.auth-detail-pane{width:100%}'
        + collapsibleCss + authCss + '</style><section class="auth-detail-pane"><div class="auth-detail__body"><div class="auth-detail__panels"><main class="auth-detail__left-col"><section class="collapsible-panel">Description</section><section class="collapsible-panel auth-detail__reference-rows">References</section>' + actions + breakdown + '</main></div></div></section>';
      document.body.append(frame);
    }
  </script></body></html>`;

  const rendered = runChromium([
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
  it('keeps references then actions before the breakdown at every detail width', () => {
    for (const geometry of renderPanelGeometry()) {
      expect(geometry.columns.trim().split(/\s+/)).toHaveLength(1);
      expect(geometry.references.top).toBeGreaterThan(geometry.left.top);
      if (geometry.variant === 'with-actions') {
        expect(geometry.actions!.top).toBeGreaterThan(geometry.references.top);
        expect(geometry.breakdownTop).toBeGreaterThan(geometry.actions!.top);
        expect(geometry.actions!.left).toBe(geometry.references.left);
        expect(geometry.actions!.right).toBe(geometry.references.right);
      } else {
        expect(geometry.actions).toBeNull();
      }
    }
  });

  it('contains wide report tables and reflows file metrics at narrow detail widths', () => {
    const geometries = renderPanelGeometry();
    const narrow = geometries.find((entry) => entry.width === 360)!;
    const wide = geometries.find((entry) => entry.width === 760)!;

    expect(narrow.breakdown.scrollWidth).toBe(narrow.breakdown.clientWidth);
    expect(narrow.breakdown.tabsScrollWidth).toBeGreaterThan(narrow.breakdown.tabsClientWidth);
    expect(narrow.breakdown.viewScrollWidth).toBeGreaterThan(narrow.breakdown.viewClientWidth);
    expect(narrow.breakdown.fileColumns.trim().split(/\s+/)).toHaveLength(1);

    expect(wide.breakdown.scrollWidth).toBe(wide.breakdown.clientWidth);
    expect(wide.breakdown.fileColumns.trim().split(/\s+/)).toHaveLength(2);
  });
});
