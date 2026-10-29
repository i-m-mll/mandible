import { useLayoutEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';

import {
  ApiError,
  getSpaceFactPacket,
  type InstanceInfo,
  type SpaceFactPacket,
  type SpaceRenderer,
} from '../../api';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import {
  AppOperationalNoticeOutlet,
  useAppShell,
} from '../../app-shell';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { useSpacePacket } from '../../query/spaces';
import { invalidateProjectionQueries } from '../../query/projectionRefresh';
import { queryClient } from '../../query/client';
import type { SpacesRouteTarget } from '../../routing';
import { discardSpacesLastView, type SpacesLastView } from './last-view';
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
 * Renderers derive their models from the shell's current Query-owned packet.
 * Browser-local intent and staged edits remain owned by each renderer.
 */
export type SpaceRendererMountProps = {
  /** Project scope for the Spaces list/selection (before a Space is opened). */
  projectId: string;
  /** Canonical ledger Space id, or null when no Space is selected yet. */
  spaceId: string | null;
  /** The active renderer this mount point is being rendered for. */
  renderer: SpaceRenderer;
  /** Current Mandible instance metadata; renderers use this for preview-safe UX. */
  instance?: InstanceInfo | null;
  /** Current Query-owned packet; renderer-local edits reconcile against updates. */
  factPacket?: SpaceFactPacket | null;
};

export type SpacesViewShellProps = {
  /** Project scope threaded down to whichever renderer is mounted. */
  projectId: string;
  /** Canonical ledger Space id, or null when no Space is selected yet. */
  spaceId?: string | null;
  /** Browser-local restoration remains separate from explicit URL selection. */
  savedSelection?: SpacesLastView | null;
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
  /** Current Mandible instance metadata from the app-level health probe. */
  instance?: InstanceInfo | null;
  /**
   * Navigate the URL hash to open a space or a legacy renderer override. The
   * host (app.tsx) rebuilds `#/spaces?...`, preserving `?sidebar=`.
   */
  onNavigate?: (target: SpacesRouteTarget) => void;
  /** Injected selected-Space fact packet loader for tests; defaults to the real API client. */
  loadSpaceFactPacket?: typeof getSpaceFactPacket;
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
  spaceId: explicitSpaceId = null,
  savedSelection = null,
  renderer,
  renderers,
  sidebarHidden = false,
  instance = null,
  onNavigate,
  loadSpaceFactPacket = getSpaceFactPacket,
}: SpacesViewShellProps): JSX.Element {
  const appShell = useAppShell();
  const [discardedSavedRef, setDiscardedSavedRef] = useState<string | null>(null);
  const explicitRef = explicitSpaceId?.trim() || null;
  const restoringSaved = Boolean(!explicitRef && savedSelection && savedSelection.spaceId !== discardedSavedRef);
  const spaceId = explicitRef ?? (restoringSaved ? savedSelection!.spaceId : null);
  const query = useSpacePacket(spaceId, loadSpaceFactPacket);
  const selectedFactPacket = query.packet ?? null;
  const selectedSpace = selectedFactPacket?.space ?? null;
  const spaceLoadError = query.error?.message ?? null;
  useLayoutEffect(() => {
    if (!restoringSaved || !appShell.active) return;
    if (query.error instanceof ApiError && query.error.status === 404) {
      discardSpacesLastView(spaceId!);
      setDiscardedSavedRef(spaceId);
    } else if (selectedSpace && !query.error && !query.isFetching && !query.isPlaceholderData) {
      onNavigate?.({ projectId: selectedSpace.project_id, spaceId: selectedSpace.id, renderer: null, preserveSpaceId: true });
    }
  }, [spaceId, restoringSaved, appShell.active, selectedSpace, query.error, query.isFetching, query.isPlaceholderData, onNavigate]);

  const explicitRenderer = isSpaceRenderer(renderer) ? renderer : null;
  const primaryRenderer = selectedSpace?.default_renderer ?? DEFAULT_RENDERER;
  // Missing renderer means typed-primary open. A known renderer in the URL is a
  // legacy/deep-link override and is still honored.
  const activeRenderer: SpaceRenderer = explicitRenderer ?? primaryRenderer;
  const legacyRendererActive = Boolean(selectedSpace && explicitRenderer && explicitRenderer !== primaryRenderer);
  const selectedSpaceTitle =
    selectedSpace?.title?.trim() || 'Untitled space';
  const effectiveProjectId = selectedSpace ? (selectedSpace.project_id ?? '') : projectId;
  const canonicalSpaceId = selectedSpace?.id
    ?? selectedFactPacket?.space.id
    ?? spaceId;

  const MountPoint = renderers?.[activeRenderer] ?? null;
  const previewMutationsBlocked = Boolean(instance && instance.allowed_effects?.includes('ledger:write') !== true);
  const waitingForFactPacket = Boolean(spaceId && !selectedFactPacket && !spaceLoadError);

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
        selectionActive={appShell.active}
        selectedSpaceId={canonicalSpaceId}
        onSelectSpace={(args) => {
          if (!appShell.active) return;
          onNavigate?.({
            projectId: args.projectId,
            projectKey: args.projectKey,
            spaceId: args.spaceId,
            renderer: args.renderer,
            preserveSpaceId: true,
          });
        }}
      />
      <div className="spaces-shell__main">
        {spaceId && previewMutationsBlocked ? (
          <DetailPaneNotice severity="warning" title={`${instance?.role ?? 'preview'} instance`}>
            Saving disabled in copied preview instance.
          </DetailPaneNotice>
        ) : null}
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
                  {selectedSpaceTitle}
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
        <AppOperationalNoticeOutlet registerAsMain />
        {spaceLoadError && (
          <DetailPaneNotice severity="error" density="compact" title="Could not load space">
            {spaceLoadError}
            <button type="button" onClick={() => {
              invalidateProjectionQueries(queryClient, query.options.queryKey);
            }}>Retry space</button>
          </DetailPaneNotice>
        )}
        <div className="spaces-shell__body" data-testid="spaces-shell-body">
          {!spaceId ? (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              <p className="spaces-shell__empty-text">
                No spaces yet. Create one with the <strong>+</strong> in the sidebar.
              </p>
            </div>
          ) : spaceLoadError && !selectedFactPacket ? (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              <p className="spaces-shell__empty-text">Space unavailable.</p>
            </div>
          ) : waitingForFactPacket ? (
            <div data-testid="spaces-shell-loading">
              <LoadingSkeleton variant="canvas" label="Loading space" />
            </div>
          ) : MountPoint ? (
            <MountPoint
              key={canonicalSpaceId}
              projectId={effectiveProjectId}
              spaceId={canonicalSpaceId}
              renderer={activeRenderer}
              instance={instance}
              factPacket={selectedFactPacket}
            />
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
