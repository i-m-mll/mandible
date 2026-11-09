// Issue 037fa85 / f59b5bd — page-level agent session binding.
//
// An agent that opens Mandible in a session-bound browser (e.g. the Codex IAB)
// knows its own provider session id and includes it as a query param
// (/overview?agent_session=<id-or-short-prefix>). The page adopts it as
// tab-local in-memory state and preserves it through navigation. It is never
// written to localStorage: two concurrent agent sessions can each have a tab
// open on the same daemon, and their bindings must never bleed into each other.
//
// Review R1 (issue f59b5bd) — the Tauri deep-link handoff delivers
// `mandible:///<path>` targets after boot, so adoption is shared by the boot
// path and deep-link handler, with replace semantics: a newer deep link's
// binding replaces the current one. The binding is display-only, so
// replacement is safe.
//
// The binding is self-asserted and forgeable. It is display/navigation-only
// and must never be attached to any mutation request, authn/authz decision,
// attribution, or lifecycle action.

export const AGENT_SESSION_PARAM = 'agent_session';

let binding: string | null = null;
const listeners = new Set<(value: string | null) => void>();

/** The agent_session param of a query string ("?a=b&agent_session=s"). */
export function agentSessionFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(AGENT_SESSION_PARAM)?.trim() || null;
}

/** Carry the current tab binding into an in-app href ("/path?query"). */
export function withAgentSession(href: string, value: string | null): string {
  if (!value) return href;
  const url = new URL(href, 'http://app.invalid');
  url.searchParams.set(AGENT_SESSION_PARAM, value);
  return `${url.pathname}${url.search}${url.hash}`;
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
 * Adopt the agent_session param from the location's query at boot without
 * removing it from the shareable URL. Safe to call again.
 */
export function adoptAgentSessionFromLocation(): void {
  if (typeof window === 'undefined') return;
  adoptAgentSessionBinding(agentSessionFromSearch(window.location.search));
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
