// @provisioned chromium
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runChromium } from '../helpers/chromium';

type Edges = { left: number; right: number; top: number };
type PanelGeometry = { width: number; variant: 'with-actions' | 'single'; columns: string;
  left: Edges; references: Edges; actions: Edges | null; breakdownTop: number };

function renderPanelGeometry(): PanelGeometry[] {
  const authCss = readFileSync(resolve('ui/src/styles/auth.css'), 'utf8');
  const collapsibleCss = readFileSync(resolve('ui/src/styles/collapsible-panel.css'), 'utf8');
  const cases = [
    { width: 360, variant: 'single' }, { width: 760, variant: 'with-actions' },
    { width: 1119, variant: 'with-actions' }, { width: 1120, variant: 'with-actions' },
    { width: 1400, variant: 'with-actions' }, { width: 1400, variant: 'single' },
  ];
  const payload = JSON.stringify({ cases, authCss, collapsibleCss }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html><body><script>
    const { cases, authCss, collapsibleCss } = ${payload};
    const results = [];
    const edges = node => { const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top}; };
    for (const entry of cases) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'display:block;border:0;width:' + entry.width + 'px;height:320px';
      frame.addEventListener('load', () => {
        const doc=frame.contentDocument;
        const actions=doc.querySelector('.auth-action-bundle');
        results.push({...entry, columns:frame.contentWindow.getComputedStyle(doc.querySelector('.auth-detail__panels')).gridTemplateColumns,
          left:edges(doc.querySelector('.auth-detail__left-col')), references:edges(doc.querySelector('.auth-detail__reference-rows')),
          actions:actions?edges(actions):null, breakdownTop:edges(doc.querySelector('.auth-change-breakdown')).top});
        if(results.length===cases.length) document.title=btoa(JSON.stringify(results));
      }, {once:true});
      const actions=entry.variant==='with-actions'?'<section class="collapsible-panel auth-action-bundle">Actions on merge</section>':'';
      frame.srcdoc='<!doctype html><style>*{box-sizing:border-box}html,body{margin:0}.auth-detail-pane{width:100%}'
        +collapsibleCss+authCss+'</style><section class="auth-detail-pane"><div class="auth-detail__body"><div class="auth-detail__panels"><main class="auth-detail__left-col">'
        +'<section class="collapsible-panel">Description</section><section class="collapsible-panel auth-detail__reference-rows">References</section>'
        +actions+'<section class="collapsible-panel auth-change-breakdown">Change breakdown</section></main></div></div></section>';
      document.body.append(frame);
    }
  </script></body></html>`;
  const rendered = runChromium(['--dump-dom', '--window-size=1600,1200', `data:text/html;charset=utf-8,${encodeURIComponent(html)}`], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (rendered.status !== 0) throw new Error(`Chromium Auth detail fixture failed: ${rendered.stderr}`);
  const encoded = rendered.stdout.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!encoded) throw new Error('Chromium Auth detail fixture did not return measurements.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as PanelGeometry[];
}

it('keeps references then actions before the breakdown at every detail width', () => {
  for (const geometry of renderPanelGeometry()) {
    expect(geometry.columns.trim().split(/\s+/)).toHaveLength(1);
    expect(geometry.references.top).toBeGreaterThan(geometry.left.top);
    if (geometry.variant === 'with-actions') {
      expect(geometry.actions!.top).toBeGreaterThan(geometry.references.top);
      expect(geometry.breakdownTop).toBeGreaterThan(geometry.actions!.top);
      expect(geometry.actions!.left).toBe(geometry.references.left);
      expect(geometry.actions!.right).toBe(geometry.references.right);
    } else expect(geometry.actions).toBeNull();
  }
});
