// Spaces renderer registry (umbrella de56ffa).
//
// The SpacesViewShell (C10) exposes a frozen `renderers` extension surface —
// a `Partial<Record<SpaceRenderer, SpaceRendererMountPoint>>` map it mounts the
// active renderer from. Renderer lanes ADD their entry here rather than editing
// the shell frame or the app mount: this module is the single registry the app
// threads into `<SpacesViewShell renderers={SPACE_RENDERERS_REGISTRY} />`.
//
// C8 (this lane) registers `collection`. Sibling renderer lanes (C9a canvas,
// C14b document, C17 board) append their own entries here in their branches;
// an unregistered renderer falls back to the shell empty-state.

import type { SpaceRendererMountPoint, SpaceRendererMountProps } from './SpacesViewShell';
import type { SpaceRenderer } from '../../api';
import { getSpaceFactPacket, type SpaceFactPacket } from '../../api';
import { SpaceCollectionRenderer } from './space-collection';
import { SpaceBoardRenderer } from './SpaceBoard';
import { DocumentBlockEditor } from './DocumentBlockEditor';
import { SpaceCanvas, type SpaceCanvasModel } from './SpaceCanvas';
import './renderers.css';

/**
 * Default canvas loader: reads the Space fact packet (`GET /api/spaces/:id`) and
 * projects it to the canvas's `{ occurrences, items }` model. SpaceCanvas accepts
 * extra props beyond the frozen mount-point contract, so the registry adapter
 * supplies the loader while exposing only `SpaceRendererMountProps` to the shell
 * — keeping the registry entry a valid `SpaceRendererMountPoint`.
 */
async function loadCanvasModel(spaceId: string): Promise<SpaceCanvasModel> {
  const packet = await getSpaceFactPacket(spaceId);
  return canvasModelFromPacket(packet);
}

function canvasModelFromPacket(packet: SpaceFactPacket): SpaceCanvasModel {
  // `edges` is included so the canvas renders authored `space_edges` as lines
  // (drag-created and dropdown-created edges reconcile through the same packet).
  return { occurrences: packet.occurrences, items: packet.items, edges: packet.edges };
}

function CanvasMountPoint(props: SpaceRendererMountProps): JSX.Element {
  const initialModel =
    props.initialFactPacket && props.initialFactPacket.space.id === props.spaceId
      ? canvasModelFromPacket(props.initialFactPacket)
      : undefined;
  return (
    <div className="space-canvas-mount" data-testid="space-canvas-mount">
      <SpaceCanvas {...props} initialModel={initialModel} loadModel={loadCanvasModel} />
    </div>
  );
}

export const SPACE_RENDERERS_REGISTRY: Partial<Record<SpaceRenderer, SpaceRendererMountPoint>> = {
  collection: SpaceCollectionRenderer,
  board: SpaceBoardRenderer,
  // The `canvas` renderer (SpaceCanvas) takes a `loadModel` beyond the frozen
  // mount-point contract; the adapter above injects the real fact-packet loader
  // so the home renderer switcher's `canvas` option mounts a working canvas
  // rather than the shell empty-state.
  canvas: CanvasMountPoint,
  // The `document` renderer mounts the C14c block EDITOR. It gates against C13d
  // custody: a repo-authoritative + drifted document renders read-only/stale
  // with re-import / fork affordances, while Mandible-custody documents are
  // freely editable (it renders the live tree through the C14b read renderer).
  document: DocumentBlockEditor,
};
