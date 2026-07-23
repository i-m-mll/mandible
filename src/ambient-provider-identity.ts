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
  { provider: "claude", envVar: "CLAUDE_CODE_SESSION_ID" },
  { provider: "claude", envVar: "CLAUDE_SESSION_ID" },
  { provider: "gemini", envVar: "GEMINI_SESSION_ID" },
];

const ALLOWED_PROVIDERS = new Set(PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.provider));

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
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    const providerSessionId = normalizeProviderSessionId(env[descriptor.envVar]);
    if (providerSessionId) {
      return {
        provider: descriptor.provider,
        provider_session_id: providerSessionId,
      };
    }
  }
  return null;
}

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
