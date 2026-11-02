const capacities = new WeakMap<Document, { totalHeight: number; maxRowHeight: number }>();
export function nativeReadingCapacity(parent: HTMLElement) {
  const doc = parent.ownerDocument;
  const existing = capacities.get(doc); if (existing) return existing;
  const probe = doc.createElement('div'); const row = doc.createElement('div');
  Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', width: '10px', height: '10px', overflow: 'scroll' });
  row.style.height = '1000000000px'; probe.append(row); parent.append(probe);
  const value = { totalHeight: probe.scrollHeight, maxRowHeight: row.getBoundingClientRect().height };
  probe.remove(); capacities.set(doc, value); return value;
}
