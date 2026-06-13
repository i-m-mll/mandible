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
];

const ALLOWED_PROVIDERS = new Set(PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.provider));

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
