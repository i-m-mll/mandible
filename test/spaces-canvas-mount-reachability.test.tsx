// Reachability guard for the `canvas` renderer mount (umbrella de56ffa).
//
// The canvas mount should expose one integrated node/edge canvas with a
// selection inspector. It must not regress to the old composition where a
// permanent bottom SpaceEdgeLayer form/list duplicated edge actions.

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

it('mounts the integrated canvas inspector without the old permanent edge panel', async () => {
  const Canvas = SPACE_RENDERERS_REGISTRY.canvas!;
  render(h(Canvas, { projectId: 'p1', spaceId: 'sp1', renderer: 'canvas' }));

  await waitFor(() => expect(screen.getByTestId('space-canvas')).toBeTruthy());
  expect(screen.getByTestId('space-canvas-inspector')).toBeTruthy();
  expect(screen.queryByTestId('space-edge-layer')).toBeNull();
  expect(screen.queryByTestId('space-edge-create-form')).toBeNull();
});
