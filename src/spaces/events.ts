/**
 * Shared `space:*` SSE event-name enum for the Spaces feature.
 *
 * Issue: f108bba (umbrella de56ffa) — this is the FROZEN constant set that the
 * C5 transport/SSE child (`feature/spaces-transport-sse`) consumes to broadcast
 * Space mutations over `src/sse.ts`, and that the C2 routes themselves reference
 * when emitting events. Keep the string values stable: they are part of the
 * client/SSE wire contract.
 *
 * ## Event-name extension convention (FROZEN)
 *
 * Later route-adding children MUST append their event names to {@link SPACE_EVENTS}
 * here rather than inventing ad-hoc strings at their call sites. This keeps the
 * SSE topic set discoverable in one place and lets C5 broadcast/route any
 * `space:*` event without per-child special-casing.
 *
 * Rules for extenders:
 * 1. Every Space-mutating event name is a `space:<noun>[:<noun>]:<verb>` string
 *    and lives as a value in {@link SPACE_EVENTS}.
 * 2. Add the new key/value to {@link SPACE_EVENTS} in the section marked for the
 *    owning child, then reference it via {@link SPACE_EVENTS} / {@link SpaceEvent}
 *    in your route handler — never hard-code the literal at the call site.
 * 3. Do not remove or rename an existing value; the SSE topic names are a wire
 *    contract. Superseding an event means adding a new value and deprecating the
 *    old one in a comment, not mutating it in place.
 *
 * Known downstream extenders (do not add their events here pre-emptively; they
 * own those edits in their own branches):
 * - C11 (`feature/spaces-canvas__blocks`) → `space:block:changed`
 *   (and any finer-grained `space:block:*` it needs).
 * - C13b (export/drift) → `space:export:*` / `space:document:*`.
 */
export const SPACE_EVENTS = {
  // --- C2 (feature/spaces-api): spaces / items / occurrences / edges + seed ---
  SPACE_CREATED: "space:created",
  SPACE_UPDATED: "space:updated",
  SPACE_DELETED: "space:deleted",

  SPACE_ITEM_ADDED: "space:item:added",
  SPACE_ITEM_UPDATED: "space:item:updated",
  SPACE_ITEM_REMOVED: "space:item:removed",

  SPACE_OCCURRENCE_CREATED: "space:occurrence:created",
  SPACE_OCCURRENCE_MOVED: "space:occurrence:moved",
  SPACE_OCCURRENCE_UPDATED: "space:occurrence:updated",
  SPACE_OCCURRENCE_REMOVED: "space:occurrence:removed",

  SPACE_EDGE_CREATED: "space:edge:created",
  SPACE_EDGE_UPDATED: "space:edge:updated",
  SPACE_EDGE_REMOVED: "space:edge:removed",

  SPACE_SEEDED: "space:seeded",

  // --- C11 (feature/spaces-canvas__blocks): document/canvas blocks ---
  //   Append here, e.g.:
  //   SPACE_BLOCK_CHANGED: "space:block:changed",

  // --- C13b (export/drift): export + document snapshots ---
  //   Append here, e.g.:
  //   SPACE_EXPORT_STARTED: "space:export:started",
  //   SPACE_DOCUMENT_UPDATED: "space:document:updated",
} as const;

export type SpaceEventKey = keyof typeof SPACE_EVENTS;
export type SpaceEvent = (typeof SPACE_EVENTS)[SpaceEventKey];

/** All frozen `space:*` event-name values, for SSE topic registration. */
export const SPACE_EVENT_VALUES: readonly SpaceEvent[] = Object.freeze(
  Object.values(SPACE_EVENTS) as SpaceEvent[],
);

/** True if `value` is a known frozen `space:*` event name. */
export function isSpaceEvent(value: unknown): value is SpaceEvent {
  return typeof value === "string" && (SPACE_EVENT_VALUES as readonly string[]).includes(value);
}
