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

import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';

import { getSpace, type Space, type SpaceRenderer } from '../../api';
// `api.ts` re-exports the SpaceRenderer *type* only; the runtime value const
// lives in the canonical contracts module (README §2 permits importing wire
// records from `../../../src/contracts`).
import { SPACE_RENDERERS } from '../../../../src/contracts';
import { SpacesSidebar } from './SpacesSidebar';
import { SpaceTypeIndicator, spaceTypeLabel } from './SpaceTypeIndicator';
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
   * Explicit legacy renderer override from a URL `?renderer=` param. When this
   * is absent, the shell loads the selected Space and opens its primary type
   * (`space.default_renderer`).
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
   * Navigate the URL hash to open a space or a legacy renderer override. The
   * host (app.tsx) rebuilds `#/spaces?...`, preserving `?sidebar=`.
   */
  onNavigate?: (target: { projectId?: string | null; spaceId?: string | null; renderer?: string | null }) => void;
  /** Injected selected-Space loader for tests; defaults to the real API client. */
  loadSpace?: typeof getSpace;
};

const DEFAULT_RENDERER: SpaceRenderer = 'collection';

function isSpaceRenderer(value: unknown): value is SpaceRenderer {
  return typeof value === 'string' && SPACE_RENDERERS.includes(value as SpaceRenderer);
}

/**
 * Renderable Spaces shell. Routed from `route.tab === 'spaces'` in `app.tsx`.
 * On its own (no renderers registered) it renders a stable frame + empty-state;
 * once a renderer child registers, the shell mounts it at the matching point.
 */
export function SpacesViewShell({
  projectId,
  spaceId = null,
  renderer,
  renderers,
  sidebarHidden = false,
  onNavigate,
  loadSpace = getSpace,
}: SpacesViewShellProps): JSX.Element {
  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null);
  const [spaceLoadError, setSpaceLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!spaceId) {
      setSelectedSpace(null);
      setSpaceLoadError(null);
      return undefined;
    }
    let cancelled = false;
    setSelectedSpace(null);
    setSpaceLoadError(null);
    loadSpace(spaceId)
      .then((space) => {
        if (!cancelled) setSelectedSpace(space);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSpaceLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, loadSpace]);

  const explicitRenderer = isSpaceRenderer(renderer) ? renderer : null;
  const primaryRenderer = selectedSpace?.default_renderer ?? DEFAULT_RENDERER;
  // Missing renderer means typed-primary open. A known renderer in the URL is a
  // legacy/deep-link override and is still honored.
  const activeRenderer: SpaceRenderer = explicitRenderer ?? primaryRenderer;
  const waitingForPrimary = Boolean(spaceId && !explicitRenderer && !selectedSpace && !spaceLoadError);
  const legacyRendererActive = Boolean(selectedSpace && explicitRenderer && explicitRenderer !== primaryRenderer);
  const selectedSpaceTitle = selectedSpace?.title?.trim() || 'Untitled space';
  const effectiveProjectId = selectedSpace ? (selectedSpace.project_id ?? '') : projectId;

  const MountPoint = renderers?.[activeRenderer] ?? null;

  return (
    <section
      className="spaces-shell"
      data-testid="spaces-view-shell"
      data-active-renderer={activeRenderer}
      aria-label="Spaces"
    >
      {/* The shared <ViewSidebar> inside SpacesSidebar owns the hidden contract
          (renders null + drops the resize handle when hidden) and the width
          persistence (`sidebar-width:spaces`). The shell just threads hidden. */}
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
            <>
              <div className="spaces-shell__identity" data-testid="spaces-shell-identity">
                <SpaceTypeIndicator
                  renderer={primaryRenderer}
                  className="spaces-shell__type-icon"
                  data-testid="spaces-shell-type"
                />
                <span className="spaces-shell__title" title={selectedSpaceTitle}>
                  {selectedSpace ? selectedSpaceTitle : 'Loading space...'}
                </span>
              </div>
              {legacyRendererActive ? (
                <div className="spaces-shell__legacy" data-testid="spaces-shell-legacy-renderer">
                  <span className="spaces-shell__legacy-label">
                    Legacy surface: {spaceTypeLabel(activeRenderer)}
                  </span>
                  <button
                    type="button"
                    className="spaces-shell__legacy-action"
                    data-testid="spaces-shell-open-primary"
                    onClick={() => onNavigate?.({ renderer: null })}
                  >
                    Open primary
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <span className="spaces-shell__renderer" data-testid="spaces-shell-renderer">
              {spaceTypeLabel(activeRenderer)}
            </span>
          )}
        </header>
        <div className="spaces-shell__body" data-testid="spaces-shell-body">
          {!spaceId ? (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              <p className="spaces-shell__empty-text">
                Select a space, or create one with the <strong>+</strong> in the sidebar.
              </p>
            </div>
          ) : waitingForPrimary ? (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              <p className="spaces-shell__empty-text">Loading space...</p>
            </div>
          ) : spaceLoadError && !explicitRenderer ? (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              <p className="spaces-shell__empty-text">{spaceLoadError}</p>
            </div>
          ) : MountPoint ? (
            <MountPoint projectId={effectiveProjectId} spaceId={spaceId} renderer={activeRenderer} />
          ) : (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              <p className="spaces-shell__empty-text">
                No <strong>{spaceTypeLabel(activeRenderer)}</strong> renderer is available yet.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default SpacesViewShell;
