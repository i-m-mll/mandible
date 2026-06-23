// edgePromote — the promote-to-ledger client call for the SpaceCanvas edge
// layer (umbrella de56ffa, child e16520d / C9b).
//
// Promotion REUSES the existing `POST /api/ledger/relationships` route
// (src/routes/issues.ts:1160-1216); this lane does NOT write a parallel
// relationship writer. The request shape mirrors what the C4 `promote-edge` CLI
// sends: a `source_ref`, one or more `target_refs`, and a valid `link_type`.
//
// This lives in the edge lane's own module (not the shared `ui/src/api.ts`
// client) so the lane owns its promotion surface end-to-end. The fetch is
// injectable for tests via {@link PromoteEdgeDeps}.

import type { LedgerLinkType } from './edgeModel';

/** Request payload for `POST /api/ledger/relationships`. */
export type PromoteEdgeRequest = {
  sourceRef: string;
  targetRef: string;
  linkType: LedgerLinkType;
  /** Optional note carried onto the ledger relationship. */
  note?: string | null;
};

/**
 * The ledger-relationship link result, as returned by the route
 * (`LedgerStore.linkRelationshipEdges`): an `action_id` plus the created edges.
 * Kept structurally minimal — the edge layer only needs to know it succeeded.
 */
export type PromoteEdgeResult = {
  action_id?: string;
  edges?: unknown[];
};

export type PromoteEdgeDeps = {
  /** Injected fetch (defaults to global `fetch`) so the call is testable. */
  fetchImpl?: typeof fetch;
};

const LEDGER_RELATIONSHIPS_PATH = '/api/ledger/relationships';

/**
 * Promote a `space_edge` to a ledger relationship by POSTing to the existing
 * route. The route validates the `link_type` against the 9 valid types and
 * resolves the issue/comment endpoints; a non-issue/comment ref (artifact/URI)
 * is rejected upstream, but the edge layer pre-gates those via
 * `evaluatePromotion` so this call is only made for promotable edges.
 *
 * Throws an `Error` with the server-provided message on a non-2xx response so
 * the UI can surface a clear failure.
 */
export async function promoteEdgeToLedger(
  request: PromoteEdgeRequest,
  deps: PromoteEdgeDeps = {},
): Promise<PromoteEdgeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(LEDGER_RELATIONSHIPS_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_ref: request.sourceRef,
      target_refs: [request.targetRef],
      link_type: request.linkType,
      note: request.note ?? null,
    }),
  });
  if (!response.ok) {
    let message = `promote-to-ledger failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload && typeof payload.error === 'string') message = payload.error;
    } catch {
      // keep the generic message when the server did not return JSON
    }
    throw new Error(message);
  }
  try {
    return (await response.json()) as PromoteEdgeResult;
  } catch {
    return {};
  }
}
