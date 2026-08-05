/**
 * Vitest `setupFiles` backstop for the `src/db.ts` singleton (issue c4f456c).
 *
 * Registered before any test file's own hooks, so with Vitest's default
 * `sequence.hooks: "stack"` ordering this `afterEach` runs *last* — after each
 * test file has closed whatever databases it owns. It then drops a
 * test-installed binding and poisons the slot, so any later `getDb()` fails
 * loudly instead of reading a closed handle or the real user database.
 *
 * This file deliberately does not import `src/db.ts`. It reads the hooks that
 * `src/db.ts` publishes on `globalThis` under VITEST, so test files that never
 * touch SQLite do not pay for loading the native binding.
 */
import { afterEach } from "vitest";

interface DbTestHooks {
  inspectDbBinding: () => { db: unknown; source: string | null; poisonReason: string | null };
  resetDb: (options?: { reason?: string; poison?: boolean }) => {
    cleared: boolean;
    source: string | null;
  };
}

afterEach(() => {
  const hooks = (globalThis as Record<string, unknown>).__mandibleDbTestHooks as
    | DbTestHooks
    | undefined;
  // Undefined when this test file never loaded src/db.ts. Nothing to restore.
  if (!hooks) return;
  if (hooks.inspectDbBinding().source !== "set") return;
  hooks.resetDb({ reason: "the test that installed it has finished" });
});
