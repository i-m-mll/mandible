// Issue 037fa85 / f59b5bd — page-level agent session binding.
//
// An agent that opens Mandible in a session-bound browser (e.g. the Codex IAB)
// knows its own provider session id and includes it as a hash-fragment query
// param (#/overview?agent_session=<id-or-short-prefix>). The page consumes and
// strips it at boot — the same pattern as the mandible_auth fragment token in
// client-auth-token.ts — and keeps it in tab-local in-memory state ONLY. It is
// deliberately never written to localStorage: two concurrent agent sessions
// can each have a tab open on the same daemon, and their bindings must never
// bleed into each other.
//
// Review R1 (issue f59b5bd) — the Tauri deep-link handoff delivers /r/…
// targets after boot, so consumption is a shared pure function
// (consumeAgentSessionFromHash) used by both the boot path and the deep-link
// handler, with replace semantics: a newer deep link's binding replaces the
// current one. The binding is display-only, so replacement is safe.
//
// The binding is self-asserted and forgeable. It is display/navigation-only
// and must never be attached to any mutation request, authn/authz decision,
// attribution, or lifecycle action.

const AGENT_SESSION_PARAM = 'agent_session';

let binding: string | null = null;
const listeners = new Set<(value: string | null) => void>();

/**
 * Extract the agent_session param from a hash string ("#/route?query"),
 * returning the consumed value (null when absent) and the hash with the param
 * stripped. Pure — the single consumption function shared by boot consumption
 * and the Tauri deep-link handoff, so both paths strip identically.
 */
export function consumeAgentSessionFromHash(
  hash: string,
): { value: string | null; hash: string } {
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return { value: null, hash };
  const route = hash.slice(0, queryIndex);
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  const value = params.get(AGENT_SESSION_PARAM)?.trim() || null;
  if (!value) return { value: null, hash };
  params.delete(AGENT_SESSION_PARAM);
  const remaining = params.toString();
  return { value, hash: `${route}${remaining ? `?${remaining}` : ''}` };
}

/**
 * Adopt a consumed binding into tab-local memory and notify subscribers.
 * Replace semantics: a newer deep link's binding replaces the current one.
 * Absence (null/empty) never clears an existing binding — a link without the
 * param is not a directive to unbind.
 */
export function adoptAgentSessionBinding(value: string | null): void {
  const next = value?.trim() || null;
  if (!next || next === binding) return;
  binding = next;
  for (const listener of listeners) listener(binding);
}

/**
 * Subscribe to binding adoption (Tauri deep-link handoffs arriving after
 * boot). Returns an unsubscribe function.
 */
export function subscribeAgentPageBinding(
  listener: (value: string | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Consume the agent_session param from the hash-fragment query at boot,
 * stripping it from the URL via history.replaceState. Safe to call again — a
 * stripped hash simply yields nothing. Fails silently: a broken URL or
 * restricted history API must never block boot.
 */
export function consumeAgentSessionFragment(): void {
  if (typeof window === 'undefined') return;
  try {
    const { value, hash } = consumeAgentSessionFromHash(window.location.hash);
    if (!value) return;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    );
    adoptAgentSessionBinding(value);
  } catch {
    // Fail silently: detection and binding are best-effort conveniences.
  }
}

/** The tab-local agent session binding currently adopted, if any. */
export function getAgentPageBinding(): string | null {
  return binding;
}

/**
 * Probe the WebMCP surface the Codex in-app browser injects. Detection gates
 * the conditional nav shortcut only and must fail silently everywhere else.
 */
export function detectCodexIab(): boolean {
  try {
    const doc = typeof document !== 'undefined'
      ? (document as unknown as { modelContext?: unknown }).modelContext
      : undefined;
    const nav = typeof navigator !== 'undefined'
      ? (navigator as unknown as { modelContext?: unknown }).modelContext
      : undefined;
    const context = (doc ?? nav) as { codexGetTools?: unknown } | undefined;
    return typeof context?.codexGetTools === 'function';
  } catch {
    return false;
  }
}

/** Test-only reset so vitest cases can exercise consumption repeatedly. */
export function __resetAgentPageBindingForTests(): void {
  binding = null;
  listeners.clear();
}
