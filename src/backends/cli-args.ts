/**
 * Argument-vector helpers shared by the agent backends.
 *
 * The backends have no common base class -- each extends `EventEmitter` and
 * implements `AgenticBackend` independently -- so pure helpers that carry no
 * per-backend policy live here rather than being copied into each class.
 */

/**
 * Read the model named by the last `--model` or `-m` flag in an argument
 * vector, or null when no flag carries a non-blank value.
 *
 * The scan runs right to left so a later flag wins, matching how the
 * underlying CLIs resolve a repeated option.
 */
export function extractModel(args: string[]): string | null {
  for (let i = args.length - 2; i >= 0; i -= 1) {
    const arg = args[i];
    if ((arg === "--model" || arg === "-m") && typeof args[i + 1] === "string" && args[i + 1].trim()) {
      return args[i + 1].trim();
    }
  }
  return null;
}
