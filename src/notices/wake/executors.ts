import type { WakeExecutor, WakeProvider } from "./types.js";

// Each provider's executor lives in its own file (`claude.ts`, `codex.ts`,
// `antigravity.ts`); until it is built its entry here reports that.
const unbuilt = (provider: WakeProvider): WakeExecutor => async () =>
  ({ ok: false, error: { code: "entry_point_failed", detail: `the ${provider} wake executor is not built` } });

/** The one executor per provider that the reconciler calls. */
export const WAKE_EXECUTORS: Readonly<Record<WakeProvider, WakeExecutor>> = {
  claude: unbuilt("claude"),
  codex: unbuilt("codex"),
  antigravity: unbuilt("antigravity"),
};
