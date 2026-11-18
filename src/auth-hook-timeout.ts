// Most hooks should finish quickly. The built-in Mandible hook may perform a
// cold Rust/Tauri release build after native changes, so it gets a deliberate
// longer ceiling instead of being killed halfway through bundle production.
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const MANDIBLE_REBUILD_HOOK_TIMEOUT_MS = 30 * 60 * 1000;

/** How long the daemon lets a hook run before killing it, measured from its `started_at`. */
export function authHookTimeoutMs(hookId: string): number {
  return hookId === "builtin-mandible-rebuild"
    ? MANDIBLE_REBUILD_HOOK_TIMEOUT_MS
    : DEFAULT_HOOK_TIMEOUT_MS;
}
