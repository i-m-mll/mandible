import { wakeAntigravity } from "./antigravity.js";
import { wakeClaude } from "./claude.js";
import { wakeCodex } from "./codex.js";
import type { WakeExecutor, WakeProvider } from "./types.js";

/** The one executor per provider that the reconciler calls. */
export const WAKE_EXECUTORS: Readonly<Record<WakeProvider, WakeExecutor>> = {
  claude: wakeClaude,
  codex: wakeCodex,
  antigravity: wakeAntigravity,
};
