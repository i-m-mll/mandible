// Issue 037fa85 / f59b5bd — page-level agent session binding.
//
// An agent that opens Mandible in a session-bound browser (e.g. the Codex IAB)
// knows its own provider session id and includes it as a hash-fragment query
// param (#/overview?agent_session=<id-or-short-prefix>). The page adopts it as
// tab-local in-memory state and preserves it through navigation. It is never
// written to localStorage: two concurrent agent sessions can each have a tab
// open on the same daemon, and their bindings must never bleed into each other.
//
// Review R1 (issue f59b5bd) — the Tauri deep-link handoff delivers /r/…
// targets after boot, so extraction is shared by the boot path and deep-link
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
 * Extract the agent_session param from a hash string ("#/route?query").
 */
export function agentSessionFromHash(hash: string): string | null {
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return null;
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  return params.get(AGENT_SESSION_PARAM)?.trim() || null;
}

/** Preserve the current tab binding when constructing an internal hash route. */
export function hashWithAgentSession(hashValue: string, value: string | null): string {
  if (!value) return hashValue;
  const hash = hashValue || '#/spaces';
  const queryIndex = hash.indexOf('?');
  const route = queryIndex < 0 ? hash : hash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex < 0 ? '' : hash.slice(queryIndex + 1));
  params.set(AGENT_SESSION_PARAM, value);
  return `${route}?${params.toString()}`;
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
 * Adopt the agent_session param from the hash-fragment query at boot without
 * removing it from the shareable route. Safe to call again and fails silently.
 */
export function adoptAgentSessionFragment(): void {
  if (typeof window === 'undefined') return;
  try {
    adoptAgentSessionBinding(agentSessionFromHash(window.location.hash));
  } catch {
    // Fail silently: binding is a best-effort display/navigation convenience.
  }
}

/** The tab-local agent session binding currently adopted, if any. */
export function getAgentPageBinding(): string | null {
  return binding;
}

/** Test-only reset so vitest cases can exercise consumption repeatedly. */
export function __resetAgentPageBindingForTests(): void {
  binding = null;
  listeners.clear();
}
