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
// The binding is self-asserted and forgeable. It is display/navigation-only
// and must never be attached to any mutation request, authn/authz decision,
// attribution, or lifecycle action.

const AGENT_SESSION_PARAM = 'agent_session';

let consumed = false;
let binding: string | null = null;

/**
 * Consume the agent_session param from the hash-fragment query at boot,
 * stripping it from the URL via history.replaceState. Idempotent; fails
 * silently — a broken URL or restricted history API must never block boot.
 */
export function consumeAgentSessionFragment(): void {
  if (consumed) return;
  consumed = true;
  if (typeof window === 'undefined') return;
  try {
    const hash = window.location.hash;
    const queryIndex = hash.indexOf('?');
    if (queryIndex < 0) return;
    const route = hash.slice(0, queryIndex);
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    const value = params.get(AGENT_SESSION_PARAM);
    if (!value) return;
    binding = value.trim() || null;
    params.delete(AGENT_SESSION_PARAM);
    const remaining = params.toString();
    const nextHash = `${route}${remaining ? `?${remaining}` : ''}`;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${nextHash}`,
    );
  } catch {
    // Fail silently: detection and binding are best-effort conveniences.
  }
}

/** The tab-local agent session binding consumed at boot, if any. */
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
  consumed = false;
  binding = null;
}
