/** Bounded body coverage around a measured semantic point; the viewport engine owns global offsets. */
export function readingPreparationIndices(sizes: readonly number[], index: number, local: number, screen: number, height: number, allowance: number, overscan: number): number[] {
  if (index < 0 || index >= sizes.length) return [];
  let first = index;
  let last = index;
  let above = local;
  let below = sizes[index] - local;
  const wantedAbove = Math.max(0, screen) + allowance;
  const wantedBelow = Math.max(0, height - screen) + allowance;
  while (first > 0 && above < wantedAbove) above += sizes[--first];
  while (last + 1 < sizes.length && below < wantedBelow + Math.max(0, wantedAbove - above)) below += sizes[++last];
  while (first > 0 && above < wantedAbove + Math.max(0, wantedBelow - below)) above += sizes[--first];
  first = Math.max(0, first - overscan);
  last = Math.min(sizes.length - 1, last + overscan);
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}
