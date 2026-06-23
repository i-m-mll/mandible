// Reachability guard for the `canvas` renderer mount (umbrella de56ffa, UX-review
// child bd0a4cf).
//
// Seam found in the UX review: SpaceEdgeLayer (C9b edge CRUD + promote-to-ledger)
// is a built renderer surface that was mounted NOWHERE in the app — the canvas
// mount point only rendered SpaceCanvas (nodes), so the entire authored-edge +
// promote-to-ledger feature was unreachable. The fix composes both siblings in
// the registry's `canvas` mount point. This test pins that composition so the
// edge surface cannot silently fall out of the app again.

import { render, screen, cleanup, waitFor } from '@testing-library/preact';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { h } from 'preact';

// The canvas mount adapter loads the Space fact packet through the real
// `getSpaceFactPacket`; stub it so the mount renders without a daemon.
vi.mock('../ui/src/api', async (importActual) => {
  const actual = await importActual<typeof import('../ui/src/api')>();
  return {
    ...actual,
    getSpaceFactPacket: vi.fn().mockResolvedValue({
      space: { id: 'sp1' },
      items: [],
      occurrences: [],
      edges: [],
    }),
  };
});

import { SPACE_RENDERERS_REGISTRY } from '../ui/src/views/spaces/renderers';

// Both mounted renderers open a real SSE client (the browser provides
// `EventSource`); jsdom does not, so stub a no-op implementation for the mount.
class FakeEventSource {
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeAll(() => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource as unknown;
});

afterAll(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('registers a canvas renderer', () => {
  expect(SPACE_RENDERERS_REGISTRY.canvas).toBeTruthy();
});

it('mounts BOTH the node canvas and the edge-authoring layer for the canvas renderer', async () => {
  const Canvas = SPACE_RENDERERS_REGISTRY.canvas!;
  render(h(Canvas, { projectId: 'p1', spaceId: 'sp1', renderer: 'canvas' }));

  // The node half (SpaceCanvas) is present...
  await waitFor(() => expect(screen.getByTestId('space-canvas')).toBeTruthy());
  // ...and the edge-authoring half (SpaceEdgeLayer) is reachable in the same
  // mount — the seam this lane closed.
  expect(screen.getByTestId('space-edge-layer')).toBeTruthy();
  // The edge create form (the affordance that was previously unreachable).
  expect(screen.getByTestId('space-edge-create-form')).toBeTruthy();
});
