/** Run synchronous, independently committed units with a 20 ms turn budget. */
export async function forEachInEventLoopSlices<T>(
  units: Iterable<T>,
  apply: (unit: T) => void,
): Promise<void> {
  let deadline = performance.now() + 20;
  for (const unit of units) {
    apply(unit);
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      deadline = performance.now() + 20;
    }
  }
}
