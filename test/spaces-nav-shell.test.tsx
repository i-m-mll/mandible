// Routing + shell tests for Spaces nav/route scaffold (umbrella de56ffa,
// child 22b50f5).
import { render, screen, cleanup } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { h } from 'preact';

import { parseRouteFromHash } from '../ui/src/routing';
import {
  SpacesViewShell,
  type SpaceRendererMountProps,
} from '../ui/src/views/spaces/SpacesViewShell';

afterEach(() => {
  cleanup();
});

describe('Spaces routing', () => {
  it('parses #/spaces into the spaces tab', () => {
    expect(parseRouteFromHash('#/spaces').tab).toBe('spaces');
  });

  it('preserves query params on the spaces route', () => {
    const route = parseRouteFromHash('#/spaces?project=p1&space=s1&renderer=canvas');
    expect(route.tab).toBe('spaces');
    expect(route.params).toMatchObject({ project: 'p1', space: 's1', renderer: 'canvas' });
  });

  it('defaults empty and unknown routes to spaces (graph demoted to drill-down)', () => {
    expect(parseRouteFromHash('').tab).toBe('spaces');
    expect(parseRouteFromHash('#/').tab).toBe('spaces');
    // An unknown path now falls back to spaces, not graph.
    expect(parseRouteFromHash('#/not-a-real-tab').tab).toBe('spaces');
    // Graph remains reachable as an explicit drill-down route.
    expect(parseRouteFromHash('#/graph').tab).toBe('graph');
  });
});

describe('SpacesViewShell', () => {
  it('renders the shell frame as a smoke test', () => {
    render(<SpacesViewShell projectId="p1" />);
    expect(screen.getByTestId('spaces-view-shell')).toBeTruthy();
    expect(screen.getByTestId('spaces-shell-body')).toBeTruthy();
  });

  it('defaults to the collection renderer and shows the empty-state when no renderer is registered', () => {
    render(<SpacesViewShell projectId="p1" />);
    const shell = screen.getByTestId('spaces-view-shell');
    expect(shell.getAttribute('data-active-renderer')).toBe('collection');
    expect(screen.getByTestId('spaces-shell-empty')).toBeTruthy();
  });

  it('normalizes an unknown renderer value back to the default', () => {
    render(<SpacesViewShell projectId="p1" renderer="bogus" />);
    expect(
      screen.getByTestId('spaces-view-shell').getAttribute('data-active-renderer'),
    ).toBe('collection');
  });

  it('honors a known renderer value', () => {
    render(<SpacesViewShell projectId="p1" renderer="canvas" />);
    expect(
      screen.getByTestId('spaces-view-shell').getAttribute('data-active-renderer'),
    ).toBe('canvas');
    expect(screen.getByTestId('spaces-shell-renderer').textContent).toBe('canvas');
  });

  it('mounts a registered renderer at the matching mount point and forwards props', () => {
    const seen: SpaceRendererMountProps[] = [];
    function CanvasMount(props: SpaceRendererMountProps): JSX.Element {
      seen.push(props);
      return <div data-testid="canvas-mount">canvas mount</div>;
    }
    render(
      <SpacesViewShell
        projectId="p1"
        spaceId="s1"
        renderer="canvas"
        renderers={{ canvas: CanvasMount }}
      />,
    );
    expect(screen.getByTestId('canvas-mount')).toBeTruthy();
    // The empty-state is replaced when a renderer is registered.
    expect(screen.queryByTestId('spaces-shell-empty')).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ projectId: 'p1', spaceId: 's1', renderer: 'canvas' });
  });

  it('falls back to the empty-state when the active renderer has no registered mount point', () => {
    function CanvasMount(): JSX.Element {
      return <div data-testid="canvas-mount">canvas mount</div>;
    }
    // collection is active (default) but only a canvas mount is registered.
    render(<SpacesViewShell projectId="p1" renderers={{ canvas: CanvasMount }} />);
    expect(screen.queryByTestId('canvas-mount')).toBeNull();
    expect(screen.getByTestId('spaces-shell-empty')).toBeTruthy();
  });
});
