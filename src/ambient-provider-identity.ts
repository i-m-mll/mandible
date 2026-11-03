/** Claimed execution context; never authentication or approval authority. */
export interface AmbientProviderIdentity {
  provider: string;
  agent_id: string | null;
  session_id: string | null;
}

const PROVIDER_ENV = {
  codex: ["CODEX_THREAD_ID", "CODEX_SESSION_ID"],
  claude: ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_AGENT_ID"],
  gemini: ["GEMINI_SESSION_ID"],
} as const;

export const MANAGED_SESSION_ENV_MARKERS: readonly string[] = [
  "MANDIBLE_MANAGED_CLIENT", "MANDIBLE_SESSION_ID", "MANDIBLE_EXECUTION_CONTEXT",
  ...Object.values(PROVIDER_ENV).flat(),
];

export function inManagedSessionContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return MANAGED_SESSION_ENV_MARKERS.some(marker => Boolean(env[marker]?.trim()));
}

export function providerSessionEnvBindingValues(provider: string): string[] {
  return [...(PROVIDER_ENV[provider.trim().toLowerCase() as keyof typeof PROVIDER_ENV] ?? [])].filter(marker => marker !== "CLAUDE_AGENT_ID");
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

export function normalizeAmbientProviderIdentity(value: unknown): AmbientProviderIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (typeof provider !== "string" || !Object.hasOwn(PROVIDER_ENV, provider)) return null;
  if (Object.hasOwn(record, "provider_session_id") && !Object.hasOwn(record, "agent_id") && !Object.hasOwn(record, "session_id")) {
    const legacy = id(record.provider_session_id);
    if (!legacy) return null;
    return { provider, agent_id: provider === "claude" ? null : legacy, session_id: provider === "codex" ? null : legacy };
  }
  if (Object.hasOwn(record, "provider_session_id")) return null;
  const agent_id = id(record.agent_id), session_id = id(record.session_id);
  if ((record.agent_id != null && !agent_id) || (record.session_id != null && !session_id) || (!agent_id && !session_id)) return null;
  if (provider === "claude" && agent_id && !session_id) return null;
  return { provider, agent_id, session_id };
}

export function resolveAmbientProviderIdentity(env: NodeJS.ProcessEnv = process.env): AmbientProviderIdentity | null {
  if (Object.hasOwn(env, "MANDIBLE_EXECUTION_CONTEXT")) {
    try { return normalizeAmbientProviderIdentity(JSON.parse(env.MANDIBLE_EXECUTION_CONTEXT!)); }
    catch { return null; }
  }
  const providers = Object.entries(PROVIDER_ENV).filter(([, markers]) => markers.some(marker => Boolean(env[marker])));
  if (providers.length !== 1) return null;
  const provider = providers[0][0];
  if (provider === "codex") return normalizeAmbientProviderIdentity({ provider, agent_id: env.CODEX_THREAD_ID || null, session_id: env.CODEX_SESSION_ID || null });
  if (provider === "gemini") return normalizeAmbientProviderIdentity({ provider, agent_id: env.GEMINI_SESSION_ID, session_id: env.GEMINI_SESSION_ID });
  if (env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_SESSION_ID && env.CLAUDE_CODE_SESSION_ID !== env.CLAUDE_SESSION_ID) return null;
  return normalizeAmbientProviderIdentity({ provider, agent_id: env.CLAUDE_AGENT_ID || null, session_id: env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID });
}

/** Lossless scalar projection for exact executor aliases. */
export function exactAgentRef(value: AmbientProviderIdentity | null): string | null {
  const context = normalizeAmbientProviderIdentity(value);
  if (!context?.agent_id) return null;
  const agent = encodeId(context.agent_id);
  return context.provider === "claude" ? `agent:claude:${encodeId(context.session_id!)}:${agent}` : `agent:${context.provider}:${agent}`;
}

export function parseExactAgentRef(value: string): AmbientProviderIdentity | null {
  const parts = value.split(":");
  if (parts[0] !== "agent" || !((parts[1] === "claude" && parts.length === 4) || (["codex", "gemini"].includes(parts[1]) && parts.length === 3))) return null;
  try {
    const provider = parts[1], agent_id = decodeURIComponent(parts.at(-1)!);
    const session_id = provider === "claude" ? decodeURIComponent(parts[2]) : provider === "gemini" ? agent_id : null;
    const context = normalizeAmbientProviderIdentity({ provider, agent_id, session_id });
    return context && exactAgentRef(context) === value ? context : null;
  } catch { return null; }
}

function encodeId(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
