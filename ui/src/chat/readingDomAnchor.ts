/** An ephemeral text point, never a selection or persisted source coordinate. */
export type ReadingDomAnchor = {
  key: string; members: readonly string[]; offset: number;
  point: { node: Node; offset: number; path: number[] } | null;
  element: Element | null; protectedKeys: ReadonlySet<string>;
};
function pathFrom(row: Element, node: Node): number[] {
  const path: number[] = [];
  while (node !== row && node.parentNode) { path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node)); node = node.parentNode; }
  return path;
}
function pointBox(node: Node, offset: number): DOMRect | undefined {
  if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.length) return;
  const range = node.ownerDocument!.createRange();
  const start = Math.min(offset, node.textContent.length - 1);
  range.setStart(node, start); range.setEnd(node, start + 1);
  return range.getClientRects()[0];
}
export function captureReadingDomAnchor(scroller: HTMLElement, boxes: ReadonlyMap<string, HTMLElement>, members: ReadonlyMap<string, readonly string[]>, clearance: number): ReadingDomAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  const y = viewport.top + Math.max(1, scroller.clientHeight - clearance) / 2;
  const visible = [...boxes].filter(([, row]) => { const rect = row.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.top + scroller.clientHeight - clearance && row.getAttribute('aria-busy') !== 'true'; });
  if (!visible.length) return null;
  const [key, row] = visible.reduce((best, entry) => {
    const distance = (element: Element) => { const rect = element.getBoundingClientRect(); return Math.max(rect.top - y, y - rect.bottom, 0); };
    return distance(entry[1]) < distance(best[1]) ? entry : best;
  });
  const document = row.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const rect = row.getBoundingClientRect();
  const hitY = Math.max(rect.top + 1, Math.min(y, rect.bottom - 1));
  const x = Math.max(rect.left + 1, Math.min(viewport.left + scroller.clientWidth / 2, rect.right - 1));
  const caret = document.caretPositionFromPoint?.(x, hitY);
  const range = caret ? null : document.caretRangeFromPoint?.(x, hitY);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset ?? 0;
  const text = node && row.contains(node) ? pointBox(node, offset) : undefined;
  const point = text && node ? { node, offset, path: pathFrom(row, node) } : null;
  const element = point ? null : [...row.querySelectorAll('[data-block-id],button,img,pre,p')].reduce<Element | null>((best, candidate) => {
    const box = candidate.getBoundingClientRect();
    if (!box.height) return best;
    return !best || Math.abs(box.top - hitY) < Math.abs(best.getBoundingClientRect().top - hitY) ? candidate : best;
  }, null);
  return { key, members: members.get(key) ?? [key], point, element, offset: (text?.top ?? element?.getBoundingClientRect().top ?? rect.top) - viewport.top, protectedKeys: new Set(visible.map(([key]) => key)) };
}
/** Resolve only within the retained semantic row; never search transcript text. */
export function readingDomAnchorOffset(anchor: ReadingDomAnchor, row: HTMLElement): number {
  let node: Node | undefined = anchor.point?.node;
  if (anchor.point && (!node || !row.contains(node))) {
    node = row;
    for (const index of anchor.point.path) node = node?.childNodes[index];
  }
  const text = anchor.point && node ? pointBox(node, anchor.point.offset) : undefined;
  const element = anchor.element && row.contains(anchor.element) ? anchor.element : row;
  return (text?.top ?? element.getBoundingClientRect().top) - row.getBoundingClientRect().top;
}
