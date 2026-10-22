/**
 * Await observable test state.
 *
 * Tests wait for the state they need, never for a duration. The deadline here
 * exists only to name the missing state before Vitest's per-test hang guard
 * (`testTimeout` in vitest.config.ts) fires, so it sits just under that guard
 * instead of encoding how fast a machine ought to be: a loaded machine makes a
 * test slower, not red.
 *
 * Timers are captured at import so fake-timer tests still poll in real time.
 */
import { vi } from "vitest";

const realSetTimeout = globalThis.setTimeout;
const now = performance.now.bind(performance);

export const STATE_DEADLINE_MS = 45_000;

export async function waitUntil<T>(
  probe: () => T | Promise<T>,
  description: string,
  intervalMs = 10,
): Promise<NonNullable<T>> {
  const deadline = now() + STATE_DEADLINE_MS;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => realSetTimeout(resolve, intervalMs));
  }
}

/**
 * Await an assertion that passes once the state it checks arrives. With fake
 * timers installed, each retry advances them, as `vi.waitFor` does.
 */
export function waitUntilPasses<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: STATE_DEADLINE_MS });
}
