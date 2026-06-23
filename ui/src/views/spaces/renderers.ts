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

import type { SpaceRendererMountPoint } from './SpacesViewShell';
import type { SpaceRenderer } from '../../api';
import { SpaceCollectionRenderer } from './space-collection';
import { SpaceBoardRenderer } from './SpaceBoard';

export const SPACE_RENDERERS_REGISTRY: Partial<Record<SpaceRenderer, SpaceRendererMountPoint>> = {
  collection: SpaceCollectionRenderer,
  board: SpaceBoardRenderer,
};
