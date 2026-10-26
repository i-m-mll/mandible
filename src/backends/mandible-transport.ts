import { PRODUCTION_ORIGIN } from "../canonical-origin.js";

/** Explicit HTTP clients retain their credentialed adapter. Routine local
 * managed launches use the private socket, including inherited public origin. */
export function needsManagedHttpCredential(env: NodeJS.ProcessEnv): boolean {
  const base = env.MANDIBLE_BASE?.trim().replace(/\/+$/, "");
  if (!base) return false;
  if (base === PRODUCTION_ORIGIN && env.MANDIBLE_TRANSPORT !== "http") return false;
  return /^https?:\/\//.test(base);
}

const PROVIDER_MARKERS = [
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID", "GEMINI_SESSION_ID", "MANDIBLE_SESSION_ID",
  "MANDIBLE_SESSION_REF",
  "MANDIBLE_MANAGED_APP",
] as const;

/** Child agents must not inherit the daemon launcher's provider identity. The
 * recorded provider ID is projected only for an actual resumed task (or the
 * SDK's reserved UUID for a fresh Claude query). */
export function projectManagedProviderIdentity(
  env: Record<string, string | undefined>,
  command: string,
  providerSessionId?: string | null,
  localSessionId?: string | null,
): void {
  delete env.MANDIBLE_REQUEST_ORIGIN;
  for (const key of PROVIDER_MARKERS) delete env[key];
  const executable = command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const app = executable.startsWith("codex") ? "codex"
    : executable.startsWith("claude") ? "claude"
    : executable.startsWith("gemini") ? "gemini" : null;
  if (app && localSessionId) {
    env.MANDIBLE_MANAGED_APP = app;
    env.MANDIBLE_SESSION_ID = localSessionId;
  }
  if (!providerSessionId) return;
  if (app === "codex") env.CODEX_THREAD_ID = providerSessionId;
  else if (app === "claude") env.CLAUDE_CODE_SESSION_ID = providerSessionId;
  else if (app === "gemini") env.GEMINI_SESSION_ID = providerSessionId;
}
