import { useMemo } from 'preact/hooks';
import type { SpaceRendererMountPoint, SpaceRendererMountProps } from './SpacesViewShell';
import type { SpaceRenderer } from '../../api';
import { type SpaceFactPacket } from '../../api';
import { SpaceCollectionRenderer } from './space-collection';
import { SpaceBoardRenderer } from './SpaceBoard';
import { SpaceDocumentEditor } from './SpaceDocumentEditor';
import { SpaceCanvas, type SpaceCanvasModel } from './SpaceCanvas';
import './renderers.css';

function canvasModelFromPacket(packet: SpaceFactPacket): SpaceCanvasModel {
  // `edges` is included so the canvas renders authored `space_edges` as lines
  // (drag-created and dropdown-created edges reconcile through the same packet).
  return { occurrences: packet.occurrences, items: packet.items, edges: packet.edges };
}

function CanvasMountPoint(props: SpaceRendererMountProps): JSX.Element {
  const model = useMemo(() => props.factPacket ? canvasModelFromPacket(props.factPacket) : undefined, [props.factPacket]);
  return (
    <div className="space-canvas-mount" data-testid="space-canvas-mount">
      <SpaceCanvas {...props} model={model} />
    </div>
  );
}

export const SPACE_RENDERERS_REGISTRY: Partial<Record<SpaceRenderer, SpaceRendererMountPoint>> = {
  collection: SpaceCollectionRenderer,
  board: SpaceBoardRenderer,
  canvas: CanvasMountPoint,
  document: SpaceDocumentEditor,
};
