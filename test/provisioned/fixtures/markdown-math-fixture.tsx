import { render } from 'preact';
import { ReadingRowView } from '../../../ui/src/chat/ReadingRowView';
import type { ReadingRow } from '../../../ui/src/chat/readingProjection';
import { createReadingRowBatchRenderer } from '../../../ui/src/chat/renderReadingMeasurementBatch';
import { ReadingMeasurementService } from '../../../ui/src/chat/readingMeasurement';
import '../../../ui/src/styles/math.css';
import '../../../ui/src/styles/tokens.css';
import '../../../ui/src/styles/base.css';
import '../../../ui/src/styles/message-blocks.css';
import '../../../ui/src/styles/console.css';

const source = String.raw`The bound is
\[\boxed{A_\theta\ge\alpha(M-r).}\]
Inline \(\frac{1}{2}+\mathbb{R}+\sqrt{x}\) and
$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$
\[\underbrace{x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x}_{\text{wide equation}}\]`;
const row: ReadingRow = { key: 'math', kind: 'content', isFinalResponse: false, protectedPositions: [], items: [], sources: [],
  actionGroup: { key: 'math', start: 117, end: 117 }, disclosureOwner: null,
  nodes: [{ kind: 'assistant_turn', key: 'math', entity: 'assistant', turn: { id: 'math', toolResults: new Map(), assistantEvent: {
    type: 'assistant', session_id: 'fixture', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: source }] },
  } } }],
};
const props = { events: [], streaming: false, expandedBlocks: {}, setBlockExpanded: () => {}, preparing: false, primaryActions: [], onActivityGroupExpandedChange: () => {} };
void (async () => {
  const parent = document.getElementById('root')!;
  const width = 423.203125;
  parent.style.width = `${width}px`;
  const service = new ReadingMeasurementService(parent);
  let measuredHtml = '';
  let loadedAtGeometry: string[] = [];
  const renderer = createReadingRowBatchRenderer(() => props);
  const measurement = await service.measure({ rows: [{ key: row.key, revision: '1' }], layouts: [{ width, styleIdentity: 'math', fonts: [] }],
    materialize: async () => [row],
    renderBatch: (...args) => { const batch = renderer(...args); measuredHtml = batch.elements.get(row.key)!.innerHTML; return batch; },
    onPhase: event => { if (event.phase === 'geometry') loadedAtGeometry = [...document.fonts].filter(font => font.family.startsWith('KaTeX') && font.status === 'loaded').map(font => font.family); },
  });
  service.dispose();
  if (measurement.status !== 'complete') throw new Error(JSON.stringify(measurement));
  render(<ReadingRowView {...props} row={row} />, parent);
  const visible = parent.firstElementChild as HTMLElement;
  const visibleHeight = visible.getBoundingClientRect().height;
  const result = {
    measuredHeight: measurement.measurements[0].height, visibleHeight,
    sameHtml: measuredHtml === visible.innerHTML,
    loadedAtGeometry, fontsReady: document.fonts.status === 'loaded',
    mathCount: visible.querySelectorAll('math').length,
    overflow: [...visible.querySelectorAll<HTMLElement>('.katex-display')].filter(element => element.scrollWidth > element.clientWidth).map(element => {
      const box = element.getBoundingClientRect();
      const bases = [...element.querySelectorAll<HTMLElement>('.katex-html > .katex-base')];
      const startReachable = bases[0].getBoundingClientRect().left >= box.left - 0.05;
      element.scrollLeft = element.scrollWidth;
      const endReachable = bases.at(-1)!.getBoundingClientRect().right <= box.right + 0.05;
      element.scrollLeft = 0;
      return { width: box.width, scroll: getComputedStyle(element).overflowX, startReachable, endReachable };
    }),
    localFonts: [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
      .filter(rule => loadedAtGeometry.includes(rule.style.fontFamily.replaceAll('\"', '')))
      .flatMap(rule => [...rule.style.getPropertyValue('src').matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(match => new URL(match[1], sheet.href ?? document.baseURI).href))),
  };
  document.title = btoa(JSON.stringify(result));
})().catch(error => { document.title = `fixture-error:${btoa(String(error?.stack ?? error))}`; });
