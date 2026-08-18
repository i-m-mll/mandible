export function normalizeOrderedPinIds(value: unknown, limit = 1000): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => (
    typeof entry === 'string' && Boolean(entry.trim())
  )))].slice(0, limit);
}

export function reconcileOrderedPinIds(
  orderedIds: readonly string[],
  pinnedIds: readonly string[],
): string[] {
  const seen = new Set(orderedIds);
  const next = [...orderedIds];
  for (const id of pinnedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function orderByPinnedIds<T>(
  items: readonly T[],
  pinnedIds: readonly string[],
  getId: (item: T) => string,
  compareFallback: (left: T, right: T) => number,
): T[] {
  const pinnedOrder = new Map<string, number>();
  for (const id of pinnedIds) {
    if (!pinnedOrder.has(id)) pinnedOrder.set(id, pinnedOrder.size);
  }
  return [...items].sort((left, right) => {
    const leftPin = pinnedOrder.get(getId(left));
    const rightPin = pinnedOrder.get(getId(right));
    if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
    if (leftPin !== undefined) return -1;
    if (rightPin !== undefined) return 1;
    return compareFallback(left, right);
  });
}
