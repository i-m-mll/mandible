// SpacesViewShell — the renderable shell for the Spaces tab (umbrella de56ffa,
// child 22b50f5).
//
// This shell is the *frame* the Spaces renderer children mount into. It owns NO
// renderer logic itself: collection (C8), canvas (C9a), document (C14b), and
// board (C17) each register a renderer component via the `renderers` map and the
// shell mounts the one matching the active renderer. The shell only provides:
//   - the routed view frame + header,
//   - named mount points (one per SpaceRenderer),
//   - an empty-state when no renderer is registered yet.
//
// Per the project Dataful UX State rule, the shell does not own or mutate any
// ledger/canonical state. Browser-local view state (active renderer, selection,
// pan/zoom) is owned by the renderer children and their `SpaceViewState`
// (./types.ts); the shell only threads the active-renderer choice through so the
// nav scaffold is reachable before the renderers land.

import { useMemo } from 'preact/hooks';
import type { ComponentType } from 'preact';

import type { SpaceRenderer } from '../../api';
// `api.ts` re-exports the SpaceRenderer *type* only; the runtime value const
// lives in the canonical contracts module (README §2 permits importing wire
// records from `../../../src/contracts`).
import { SPACE_RENDERERS } from '../../../../src/contracts';
import { SpacesSidebar } from './SpacesSidebar';
import './SpacesViewShell.css';

/**
 * The set of renderer mount points the shell exposes. The renderer children
 * (C8 collection, C9a canvas, C14b document, C17 board) each register here; an
 * unregistered renderer falls back to the shell empty-state. This is the frozen
 * extension surface for the renderer lanes — they ADD entries, they do not
 * change the shell frame.
 */
export type SpaceRendererMountPoint = ComponentType<SpaceRendererMountProps>;

/**
 * Props every registered renderer mount point receives from the shell. The shell
 * stays renderer-agnostic: it forwards the active renderer id and the projectId
 * scope and otherwise leaves the renderer to source its own view-model/state via
 * the typed API client (`ui/src/api.ts`) and `./types.ts` view types.
 */
export type SpaceRendererMountProps = {
  /** Project scope for the Spaces list/selection (before a Space is opened). */
  projectId: string;
  /** Canonical ledger Space id, or null when no Space is selected yet. */
  spaceId: string | null;
  /** The active renderer this mount point is being rendered for. */
  renderer: SpaceRenderer;
};

export type SpacesViewShellProps = {
  /** Project scope threaded down to whichever renderer is mounted. */
  projectId: string;
  /** Canonical ledger Space id, or null when no Space is selected yet. */
  spaceId?: string | null;
  /**
   * Active renderer. Accepts a raw string (e.g. a URL `?renderer=` param) and is
   * normalized to a known {@link SpaceRenderer}, defaulting to `collection` for
   * unknown/missing values. The render branch / nav scaffold drives the default;
   * renderer children may drive it from their own view state once they mount.
   * Kept as a prop (not shell-owned state) so the shell never silently promotes
   * view state to canonical state.
   */
  renderer?: SpaceRenderer | string;
  /**
   * Renderer registry: collection/canvas/document/board mount points. Children
   * (C8/C9a/C14b/C17) register here. Unregistered renderers render the shell
   * empty-state rather than throwing, so the shell is renderable on its own.
   */
  renderers?: Partial<Record<SpaceRenderer, SpaceRendererMountPoint>>;
  /**
   * When true the shared view-sidebar is hidden (the rail toggle / `?sidebar=`
   * param). Threaded down so the Spaces home sidebar participates in the same
   * show/hide contract every other VIEW_SIDEBAR_TABS view uses.
   */
  sidebarHidden?: boolean;
  /**
   * Navigate the URL hash to open a space or switch the active renderer. The
   * host (app.tsx) rebuilds `#/spaces?project=…&space=…&renderer=…` preserving
   * the `?sidebar=` param. Selection + renderer choice stay URL-canonical, never
   * promoted to shell-owned state. When omitted the shell renders read-only
   * (e.g. unit smoke tests) — the sidebar/switcher affordances no-op.
   */
  onNavigate?: (target: { projectId?: string | null; spaceId?: string | null; renderer?: string }) => void;
};

const DEFAULT_RENDERER: SpaceRenderer = 'collection';

/**
 * Renderable Spaces shell. Routed from `route.tab === 'spaces'` in `app.tsx`.
 * On its own (no renderers registered) it renders a stable frame + empty-state;
 * once a renderer child registers, the shell mounts it at the matching point.
 */
export function SpacesViewShell({
  projectId,
  spaceId = null,
  renderer = DEFAULT_RENDERER,
  renderers,
  sidebarHidden = false,
  onNavigate,
}: SpacesViewShellProps): JSX.Element {
  // Normalize to a known renderer so an unexpected value can never break the
  // frame; fall back to the default rather than rendering nothing.
  const activeRenderer: SpaceRenderer = useMemo(
    () =>
      SPACE_RENDERERS.includes(renderer as SpaceRenderer)
        ? (renderer as SpaceRenderer)
        : DEFAULT_RENDERER,
    [renderer],
  );

  const MountPoint = renderers?.[activeRenderer] ?? null;
  // The switcher only offers renderers that are actually registered, so a
  // choice can never strand the user on the shell empty-state.
  const availableRenderers = useMemo<SpaceRenderer[]>(
    () => SPACE_RENDERERS.filter((value) => Boolean(renderers?.[value])),
    [renderers],
  );

  return (
    <section
      className="spaces-shell"
      data-testid="spaces-view-shell"
      data-active-renderer={activeRenderer}
      aria-label="Spaces"
    >
      <SpacesSidebar
        hidden={sidebarHidden}
        selectedSpaceId={spaceId}
        onSelectSpace={(args) =>
          onNavigate?.({ projectId: args.projectId, spaceId: args.spaceId, renderer: args.renderer })
        }
      />
      <div className="spaces-shell__main">
        <header className="spaces-shell__header">
          {spaceId ? (
            <div
              className="spaces-shell__switcher"
              role="tablist"
              aria-label="Space renderer"
              data-testid="spaces-shell-switcher"
            >
              {(availableRenderers.length > 0 ? availableRenderers : SPACE_RENDERERS).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={value === activeRenderer}
                  className="spaces-shell__switcher-btn"
                  data-active={value === activeRenderer}
                  data-testid={`spaces-renderer-${value}`}
                  onClick={() => onNavigate?.({ renderer: value })}
                >
                  {value}
                </button>
              ))}
            </div>
          ) : (
            <span className="spaces-shell__renderer" data-testid="spaces-shell-renderer">
              {activeRenderer}
            </span>
          )}
        </header>
        <div className="spaces-shell__body" data-testid="spaces-shell-body">
          {!spaceId ? (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              Select a space, or create one with the <strong>+</strong> in the sidebar.
            </div>
          ) : MountPoint ? (
            <MountPoint projectId={projectId} spaceId={spaceId} renderer={activeRenderer} />
          ) : (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              No <strong>{activeRenderer}</strong> renderer is available yet.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default SpacesViewShell;
