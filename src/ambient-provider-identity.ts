export interface AmbientProviderIdentity {
  provider: string;
  provider_session_id: string;
}

interface AmbientProviderDescriptor {
  provider: string;
  envVar: string;
}

const PROVIDER_DESCRIPTORS: readonly AmbientProviderDescriptor[] = [
  { provider: "codex", envVar: "CODEX_THREAD_ID" },
  { provider: "codex", envVar: "CODEX_SESSION_ID" },
  { provider: "claude", envVar: "CLAUDE_CODE_SESSION_ID" },
  { provider: "claude", envVar: "CLAUDE_SESSION_ID" },
  { provider: "gemini", envVar: "GEMINI_SESSION_ID" },
];

const ALLOWED_PROVIDERS = new Set(PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.provider));

/**
 * The canonical set of environment markers that identify a managed-agent
 * invocation context, mirroring `cli/api.sh`'s enrolment gate. It is the union
 * of the allowlisted provider session-env vars (above) and the two Mandible
 * markers a spawned managed client always carries (`MANDIBLE_MANAGED_CLIENT`,
 * `MANDIBLE_SESSION_ID`). Kept here as the single source of truth so process
 * lanes never duplicate the list (issue a64d2de).
 */
export const MANAGED_SESSION_ENV_MARKERS: readonly string[] = [
  "MANDIBLE_MANAGED_CLIENT",
  "MANDIBLE_SESSION_ID",
  ...PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.envVar),
];

/**
 * True when the current process runs inside a managed-agent session, judged by
 * the presence of any managed-session env marker. A process lane that reaches
 * this in the affirmative must NOT assume the local operator: it is an agent
 * (or unknown) principal, not the human running a clean local shell.
 */
export function inManagedSessionContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return MANAGED_SESSION_ENV_MARKERS.some((marker) => {
    const value = env[marker];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** Stable binding keys for an allowlisted provider's ambient session env. */
export function providerSessionEnvBindingValues(provider: string): string[] {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_DESCRIPTORS
    .filter((descriptor) => descriptor.provider === normalized)
    .map((descriptor) => descriptor.envVar);
}

export function resolveAmbientProviderIdentity(
  env: NodeJS.ProcessEnv = process.env,
): AmbientProviderIdentity | null {
  let resolved: AmbientProviderIdentity | null = null;
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    const providerSessionId = normalizeProviderSessionId(env[descriptor.envVar]);
    if (providerSessionId) {
      if (resolved && (resolved.provider !== descriptor.provider || resolved.provider_session_id !== providerSessionId)) {
        return null;
      }
      resolved = { provider: descriptor.provider, provider_session_id: providerSessionId };
    }
  }
  return resolved;
}

/**
 * Normalize an ambient provider identity presented over the wire (the
 * `X-Mandible-Ambient-Provider` / `X-Mandible-Ambient-Provider-Session-Id`
 * headers, or a work-unit's provider fields).
 *
 * SECURITY: these headers are forgeable by any local process that can reach the
 * daemon — there is no cryptographic proof the caller owns the claimed session.
 * The `session_claim` evidence this signal ultimately produces is therefore
 * DELIBERATELY UNVERIFIED, and is further constrained to resolve only to an
 * `agent`-kind user (see `resolveSessionAttributionResult`) so a forged claim
 * can never impersonate a human/operator. Verified attribution closure is
 * strict client-auth mode with real bearer credentials (issue a9b485b); until a
 * request is authenticated, session_claim is a best-effort convenience, not a
 * trust boundary.
 */
export function normalizeAmbientProviderIdentity(value: unknown): AmbientProviderIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim().toLowerCase() : "";
  const providerSessionId = normalizeProviderSessionId(record.provider_session_id);
  if (!ALLOWED_PROVIDERS.has(provider) || !providerSessionId) return null;
  return { provider, provider_session_id: providerSessionId };
}

function normalizeProviderSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
