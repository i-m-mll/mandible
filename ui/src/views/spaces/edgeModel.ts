// edgeModel — pure model helpers for the SpaceCanvas EDGE layer (umbrella
// de56ffa, child e16520d / C9b).
//
// This is the load-bearing, side-effect-free core of the edge half of the
// canvas: it resolves a `space_edge`'s endpoints to their backing items, decides
// whether an edge is promotable to a ledger relationship, maps free labels to a
// valid ledger `link_type`, and reconciles SSE-driven edge refetches WITHOUT
// touching ephemeral UI state. Keeping these rules here (not inside the React
// component) makes them unit-testable without mounting React Flow.
//
// Ownership: this lane owns the edge layer ONLY. `space_edges` are AUTHORED
// objects, DISTINCT from `ledger_relationship_edges`. Promotion is ALWAYS an
// explicit user action and reuses the existing `POST /api/ledger/relationships`
// route (src/routes/issues.ts:1160-1216) — this lane never writes a parallel
// relationship writer. The `link_type` mapping below matches the C4 CLI
// `promote-edge` semantics: 9 valid types, issue/comment endpoints only;
// artifact/URI endpoints are NOT promotable.

import type { SpaceEdge, SpaceItem, SpaceItemRefType, SpaceOccurrence } from '../../api';

/**
 * The 9 valid ledger relationship link types. Mirrors the FROZEN backend enum
 * `LEDGER_RELATIONSHIP_TYPES` (src/ledger/types.ts:74) — kept as a local const
 * because the backend module is not exposed to the UI bundle. These string
 * values are part of the `/api/ledger/relationships` wire contract; do not
 * rename them.
 */
export const LEDGER_LINK_TYPES = [
  'parent_child',
  'blocks',
  'duplicate_of',
  'related',
  'references',
  'fixed_by',
  'caused_by',
  'implements',
  'tests',
] as const;

export type LedgerLinkType = (typeof LEDGER_LINK_TYPES)[number];

/** The default link type when a free label does not match a known link type. */
export const DEFAULT_LINK_TYPE: LedgerLinkType = 'references';

/** True for the entity ref types the ledger relationship route accepts. */
export function isLedgerEndpointRefType(
  refType: SpaceItemRefType | null | undefined,
): refType is 'issue' | 'comment' {
  return refType === 'issue' || refType === 'comment';
}

/** True if `value` is one of the 9 valid ledger link types. */
export function isLedgerLinkType(value: unknown): value is LedgerLinkType {
  return (
    typeof value === 'string' && (LEDGER_LINK_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Map a free-text edge label to a ledger `link_type`, matching the C4
 * `promote-edge` CLI semantics: an exact (case/whitespace-insensitive) match of
 * a valid link type is used as-is; everything else falls back to the default
 * `references`. The promote UI lets the user override this guess explicitly, but
 * the guess seeds the dropdown so a label like "blocks" pre-selects `blocks`.
 */
export function mapLabelToLinkType(label: string | null | undefined): LedgerLinkType {
  if (!label) return DEFAULT_LINK_TYPE;
  const normalized = label.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return isLedgerLinkType(normalized) ? normalized : DEFAULT_LINK_TYPE;
}

/** A resolved edge endpoint: the occurrence joined to its backing item. */
export type EdgeEndpoint = {
  occurrenceId: string;
  occurrence: SpaceOccurrence | null;
  item: SpaceItem | null;
  /** Effective ref type of the endpoint (from the item), or null when unbound. */
  refType: SpaceItemRefType | null;
  /** Canonical ledger ref for promotion (item.ref_id) when this is a ledger endpoint. */
  ref: string | null;
  /** Human label for the endpoint, for UI display. */
  label: string;
};

/** A `space_edge` resolved against the current occurrence/item indices. */
export type ResolvedSpaceEdge = {
  edge: SpaceEdge;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
};

/**
 * The promotability verdict for an edge. `promotable` is true only when BOTH
 * endpoints resolve to a ledger endpoint (issue/comment) with a usable ref.
 * Otherwise `reason` carries a clear, user-facing explanation (artifact/URI
 * endpoint, unbound occurrence, or self-loop) — matching the C4 CLI's "not
 * promotable" result.
 */
export type PromotionVerdict =
  | {
      promotable: true;
      sourceRef: string;
      targetRef: string;
      /** Suggested link type seeded from the edge label. */
      suggestedLinkType: LedgerLinkType;
    }
  | { promotable: false; reason: string };

function endpointLabel(occurrence: SpaceOccurrence | null, item: SpaceItem | null, id: string): string {
  if (item?.title) return item.title;
  if (item?.ref_id) return item.ref_id;
  if (occurrence?.note) return occurrence.note;
  return id.slice(0, 8);
}

/** Resolve one edge endpoint (occurrence id) against the occurrence/item indices. */
export function resolveEndpoint(
  occurrenceId: string,
  occurrencesById: Record<string, SpaceOccurrence>,
  itemsById: Record<string, SpaceItem>,
): EdgeEndpoint {
  const occurrence = occurrencesById[occurrenceId] ?? null;
  const item = occurrence?.item_id ? (itemsById[occurrence.item_id] ?? null) : null;
  const refType = item?.ref_type ?? null;
  const ref = item && isLedgerEndpointRefType(refType) ? item.ref_id : null;
  return {
    occurrenceId,
    occurrence,
    item,
    refType,
    ref,
    label: endpointLabel(occurrence, item, occurrenceId),
  };
}

/** Resolve a `space_edge` to its two endpoints for rendering + promotion. */
export function resolveEdge(
  edge: SpaceEdge,
  occurrencesById: Record<string, SpaceOccurrence>,
  itemsById: Record<string, SpaceItem>,
): ResolvedSpaceEdge {
  return {
    edge,
    source: resolveEndpoint(edge.source, occurrencesById, itemsById),
    target: resolveEndpoint(edge.target, occurrencesById, itemsById),
  };
}

function endpointVerdictReason(endpoint: EdgeEndpoint, role: 'source' | 'target'): string | null {
  if (!endpoint.occurrence) return `${role} occurrence is missing`;
  if (!endpoint.item) return `${role} endpoint is not bound to an item`;
  if (!isLedgerEndpointRefType(endpoint.refType)) {
    return `${role} endpoint is a ${endpoint.refType} — ledger relationships only link issues and comments`;
  }
  if (!endpoint.ref) return `${role} endpoint has no ledger ref`;
  return null;
}

/**
 * Decide whether a resolved edge can be promoted to a ledger relationship, and
 * (when promotable) the source/target refs and a suggested link type. This is
 * the authority for "artifact/URI-endpoint edges are not promotable" and the
 * issue/comment-only rule — identical to the C4 `promote-edge` CLI.
 */
export function evaluatePromotion(resolved: ResolvedSpaceEdge): PromotionVerdict {
  const sourceReason = endpointVerdictReason(resolved.source, 'source');
  if (sourceReason) return { promotable: false, reason: sourceReason };
  const targetReason = endpointVerdictReason(resolved.target, 'target');
  if (targetReason) return { promotable: false, reason: targetReason };
  // Both refs are guaranteed non-null here by endpointVerdictReason.
  const sourceRef = resolved.source.ref as string;
  const targetRef = resolved.target.ref as string;
  if (sourceRef === targetRef) {
    return { promotable: false, reason: 'source and target resolve to the same ledger entity' };
  }
  return {
    promotable: true,
    sourceRef,
    targetRef,
    suggestedLinkType: mapLabelToLinkType(resolved.edge.label),
  };
}

/** Index occurrences by id for endpoint joins. */
export function indexOccurrences(
  occurrences: SpaceOccurrence[],
): Record<string, SpaceOccurrence> {
  const byId: Record<string, SpaceOccurrence> = {};
  for (const occurrence of occurrences) byId[occurrence.id] = occurrence;
  return byId;
}

/**
 * Index items by id for occurrence/endpoint joins. Defined here (rather than
 * imported from `SpaceCanvas`) so the edge layer's model has no transitive
 * dependency on the React Flow bundle — the pure model stays mount-free and
 * fast to unit-test.
 */
export function indexItemsById(items: SpaceItem[]): Record<string, SpaceItem> {
  const byId: Record<string, SpaceItem> = {};
  for (const item of items) byId[item.id] = item;
  return byId;
}

/**
 * Reconcile a fresh server edge list into the locally-held edge list. The SSE
 * path: the server edge set becomes canonical, EXCEPT for ids the user is
 * actively editing locally (so an in-flight optimistic label edit is not yanked
 * back by an echo of the older value). Like the node reconciler, this returns
 * only the next edge list — it has no access to selection/viewport, so SSE
 * reconciliation can never reset canvas UI state (acceptance criterion).
 */
export function reconcileEdges(
  incoming: SpaceEdge[],
  editingIds: ReadonlySet<string>,
  previous: SpaceEdge[],
): SpaceEdge[] {
  const previousById = new Map(previous.map((e) => [e.id, e]));
  return incoming.map((next) => {
    if (editingIds.has(next.id)) {
      return previousById.get(next.id) ?? next;
    }
    return next;
  });
}

/** Apply an optimistic label edit to one edge in a list (edit preview). */
export function applyOptimisticLabel(
  edges: SpaceEdge[],
  id: string,
  label: string | null,
): SpaceEdge[] {
  return edges.map((e) => (e.id === id ? { ...e, label } : e));
}
