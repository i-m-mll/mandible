// UI-only view types for the Spaces feature (umbrella de56ffa).
//
// These types describe browser-local view state and rendering props — NOT the
// wire/ledger contract. The canonical wire records (`Space`, `SpaceItem`,
// `SpaceOccurrence`, `SpaceEdge`, `SpaceBlock`, `SpaceExport`) and the
// request/response envelopes live in `src/contracts.ts` and are re-exported
// from `ui/src/api.ts`; import those for anything that crosses the network.
//
// Per the Dataful UX State rule (project CLAUDE.md), keep browser-local view
// state distinct from ledger-backed persisted state in the type system. The
// types below are the browser-local side of that split: they must NOT be
// promoted into canonical project/ledger state without an explicit user action
// flowing through a contract request type.

import type {
  Space,
  SpaceItem,
  SpaceOccurrence,
  SpaceEdge,
  SpaceRenderer,
  SpaceOccurrenceRenderer,
} from '../../api';

/**
 * Identifies a Space view within the dashboard. `spaceId` is the canonical
 * ledger id; `projectId` scopes the list view before a Space is selected.
 */
export type SpaceViewRef = {
  projectId: string;
  spaceId: string | null;
};

/**
 * Per-Space browser-local view state. This is intentionally NOT persisted to
 * the ledger: it captures transient user intent (pan/zoom, selection, filter)
 * that the dataful-UX contract requires we preserve across refreshes/SSE
 * reconciliation but never silently promote to canonical state.
 */
export type SpaceViewState = {
  /** Active renderer for the open Space (defaults to the Space's `default_renderer`). */
  renderer: SpaceRenderer;
  /** Canvas pan/zoom; null until the user has interacted (so we don't override fit-to-view). */
  viewport: SpaceViewport | null;
  /** Currently selected occurrence/edge ids (UI selection, not persisted). */
  selection: SpaceSelection;
  /** Free-text item filter applied in the collection/board views. */
  itemFilter: string;
  /** Collapsed board/section ids, keyed for stable per-section persistence. */
  collapsedSections: Record<string, boolean>;
};

export type SpaceViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type SpaceSelectionKind = 'occurrence' | 'edge' | 'item';

export type SpaceSelection = {
  kind: SpaceSelectionKind | null;
  ids: string[];
};

/**
 * A resolved occurrence joined to its backing item, the shape the renderers
 * actually draw. The join is computed UI-side from the Space fact packet; it is
 * not a wire record.
 */
export type ResolvedSpaceOccurrence = {
  occurrence: SpaceOccurrence;
  item: SpaceItem | null;
  /** Effective renderer for this occurrence (occurrence override → space default). */
  renderer: SpaceOccurrenceRenderer;
};

/**
 * The in-memory model a Space renderer consumes: the Space plus its resolved
 * occurrence/edge graph and the raw item index. Assembled from the API fact
 * packet (`getSpace` + items/occurrences/edges).
 */
export type SpaceViewModel = {
  space: Space;
  itemsById: Record<string, SpaceItem>;
  occurrences: ResolvedSpaceOccurrence[];
  edges: SpaceEdge[];
};

/** Props shared by every concrete Spaces renderer (canvas/board/collection/document). */
export type SpaceRendererProps = {
  model: SpaceViewModel;
  state: SpaceViewState;
  onStateChange: (next: SpaceViewState) => void;
};
