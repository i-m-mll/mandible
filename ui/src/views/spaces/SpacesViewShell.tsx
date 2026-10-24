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

import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';

import {
  ApiError,
  getSpace,
  getSpaceFactPacket,
  invalidateApiGetCache,
  type InstanceInfo,
  type Space,
  type SpaceFactPacket,
  type SpaceRenderer,
} from '../../api';
import { DetailPaneNotice } from '../../components/shared/DetailPaneNotice';
import {
  AppOperationalNoticeOutlet,
  useAppShell,
  useRouteLoad,
} from '../../app-shell';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { detailRequestKey, readPersistedDetail, removePersistedDetail, writePersistedDetail } from '../../detail-cache';
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
  /** Current Mandible instance metadata; renderers use this for preview-safe UX. */
  instance?: InstanceInfo | null;
  /** Optional shell-preloaded fact packet for renderers that use `/api/spaces/:id`. */
  initialFactPacket?: SpaceFactPacket | null;
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
  /** Injected selected-Space loader for tests; defaults to the real API client. */
  loadSpace?: typeof getSpace;
  /** Injected selected-Space fact packet loader for tests; defaults to the real API client. */
  loadSpaceFactPacket?: typeof getSpaceFactPacket;
};

const DEFAULT_RENDERER: SpaceRenderer = 'collection';
const SPACE_SELECTION_CACHE_KEY = 'spaces:selected-space:v1';

type SpaceSelectionSnapshot = {
  id: string;
  project_id: string | null;
  title: string;
  default_renderer: SpaceRenderer;
};

function isSpaceRenderer(value: unknown): value is SpaceRenderer {
  return typeof value === 'string' && SPACE_RENDERERS.includes(value as SpaceRenderer);
}

function snapshotFromSpace(space: Space): SpaceSelectionSnapshot {
  return {
    id: space.id,
    project_id: space.project_id ?? null,
    title: space.title,
    default_renderer: space.default_renderer,
  };
}

function loadCachedSelection(spaceId: string | null): SpaceSelectionSnapshot | null {
  if (!spaceId || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SPACE_SELECTION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SpaceSelectionSnapshot>;
    if (
      parsed.id === spaceId &&
      typeof parsed.title === 'string' &&
      isSpaceRenderer(parsed.default_renderer)
    ) {
      return {
        id: parsed.id,
        project_id: typeof parsed.project_id === 'string' ? parsed.project_id : null,
        title: parsed.title,
        default_renderer: parsed.default_renderer,
      };
    }
  } catch {
    // best-effort route-local view cache
  }
  return null;
}

function isGeneratedShortSpaceRef(spaceRef: string): boolean {
  return /^[0-9a-f]{8}$/i.test(spaceRef);
}

function persistCachedSelection(snapshot: SpaceSelectionSnapshot): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SPACE_SELECTION_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // best-effort route-local view cache
  }
}

function discardCachedSelection(spaceId: string): void {
  if (!loadCachedSelection(spaceId)) return;
  try {
    localStorage.removeItem(SPACE_SELECTION_CACHE_KEY);
  } catch {
    // best-effort route-local view cache
  }
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
  loadSpace,
  loadSpaceFactPacket,
}: SpacesViewShellProps): JSX.Element {
  const appShell = useAppShell();
  const [discardedSavedRef, setDiscardedSavedRef] = useState<string | null>(null);
  const explicitRef = explicitSpaceId?.trim() || null;
  const restoringSaved = Boolean(!explicitRef && savedSelection && savedSelection.spaceId !== discardedSavedRef);
  const spaceId = explicitRef ?? (restoringSaved ? savedSelection!.spaceId : null);
  const [retryToken, setRetryToken] = useState(0);
  const selectionGeneration = useRef(0);
  const resolvedLoadSpaceFactPacket = useMemo(
    () => {
      if (loadSpaceFactPacket) return loadSpaceFactPacket;
      if (loadSpace) {
        return (id: string) =>
          loadSpace(id).then((space) => ({
            space,
            items: [],
            occurrences: [],
            edges: [],
          } satisfies SpaceFactPacket));
      }
      return getSpaceFactPacket;
    },
    [loadSpace, loadSpaceFactPacket],
  );
  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null);
  const [selectedFactPacket, setSelectedFactPacket] = useState<SpaceFactPacket | null>(() => (
    spaceId && !isGeneratedShortSpaceRef(spaceId)
      ? readPersistedDetail<SpaceFactPacket>('spaces', detailRequestKey('spaces', { spaceId }))
      : null
  ));
  const [selectedSnapshot, setSelectedSnapshot] = useState<SpaceSelectionSnapshot | null>(
    () => (spaceId && !isGeneratedShortSpaceRef(spaceId) ? loadCachedSelection(spaceId) : null),
  );
  const [spaceLoadError, setSpaceLoadError] = useState<string | null>(null);

  useRouteLoad((registerInitialRouteLoad) => {
    const generation = ++selectionGeneration.current;
    if (!spaceId) {
      setSelectedSpace(null);
      setSelectedFactPacket(null);
      setSelectedSnapshot(null);
      setSpaceLoadError(null);
      return undefined;
    }
    let cancelled = false;
    if (restoringSaved && !appShell.active) return undefined;
    const canUseCachedSelection = !isGeneratedShortSpaceRef(spaceId);
    const cachedPacket = canUseCachedSelection
      ? readPersistedDetail<SpaceFactPacket>('spaces', detailRequestKey('spaces', { spaceId }))
      : null;
    setSelectedSpace((current) => (current?.id === spaceId ? current : null));
    setSelectedFactPacket((current) => (current?.space.id === spaceId ? current : cachedPacket));
    setSelectedSnapshot((current) => (
      canUseCachedSelection && current?.id === spaceId
        ? current
        : canUseCachedSelection
          ? loadCachedSelection(spaceId)
          : null
    ));
    setSpaceLoadError(null);
    if (restoringSaved) invalidateApiGetCache(`/api/spaces/${encodeURIComponent(spaceId)}`);
    const initialLoad = resolvedLoadSpaceFactPacket(spaceId)
      .then((packet) => {
        if (!cancelled && generation === selectionGeneration.current) {
          const { space } = packet;
          const snapshot = snapshotFromSpace(space);
          setSelectedSpace(space);
          setSelectedFactPacket(packet);
          writePersistedDetail(
            'spaces',
            detailRequestKey('spaces', { spaceId: packet.space.id }),
            packet,
          );
          setSelectedSnapshot(snapshot);
          persistCachedSelection(snapshot);
          if (restoringSaved && appShell.active) {
            onNavigate?.({ projectId: space.project_id, spaceId: space.id, renderer: null, preserveSpaceId: true });
          }
        }
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== selectionGeneration.current) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
          removePersistedDetail('spaces', detailRequestKey('spaces', { spaceId }));
          discardCachedSelection(spaceId);
          setSelectedSpace(null);
          setSelectedFactPacket(null);
          setSelectedSnapshot(null);
          if (restoringSaved && error.status === 404) {
            discardSpacesLastView(spaceId);
            setDiscardedSavedRef(spaceId);
            return;
          }
        }
        setSpaceLoadError(error instanceof Error ? error.message : String(error));
      });
    registerInitialRouteLoad(initialLoad);
    return () => {
      cancelled = true;
    };
  }, [resolvedLoadSpaceFactPacket, spaceId, restoringSaved, appShell.active, onNavigate, retryToken]);

  const handleSidebarSpaceResolved = useCallback((space: Space) => {
    if (!spaceId || space.id !== spaceId || spaceLoadError) return;
    const snapshot = snapshotFromSpace(space);
    setSelectedSnapshot(snapshot);
    persistCachedSelection(snapshot);
  }, [spaceId, spaceLoadError]);

  const explicitRenderer = isSpaceRenderer(renderer) ? renderer : null;
  const primaryRenderer = selectedSpace?.default_renderer ?? selectedSnapshot?.default_renderer ?? DEFAULT_RENDERER;
  // Missing renderer means typed-primary open. A known renderer in the URL is a
  // legacy/deep-link override and is still honored.
  const activeRenderer: SpaceRenderer = explicitRenderer ?? primaryRenderer;
  const legacyRendererActive = Boolean(selectedSpace && explicitRenderer && explicitRenderer !== primaryRenderer);
  const selectedSpaceTitle =
    selectedSpace?.title?.trim() || selectedSnapshot?.title?.trim() || 'Untitled space';
  const effectiveProjectId = selectedSpace
    ? (selectedSpace.project_id ?? '')
    : selectedSnapshot
      ? (selectedSnapshot.project_id ?? '')
      : projectId;
  const canonicalSpaceId = selectedSpace?.id
    ?? selectedFactPacket?.space.id
    ?? selectedSnapshot?.id
    ?? spaceId;

  const MountPoint = renderers?.[activeRenderer] ?? null;
  const previewMutationsBlocked = Boolean(instance && instance.allowed_effects?.includes('ledger:write') !== true);
  const requiresAuthoritativeResolution = Boolean(spaceId && isGeneratedShortSpaceRef(spaceId));
  const waitingForFactPacket = Boolean(
    spaceId &&
    !selectedFactPacket &&
    !spaceLoadError &&
    (!explicitRenderer || loadSpaceFactPacket || requiresAuthoritativeResolution),
  );

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
        onSelectedSpaceResolved={handleSidebarSpaceResolved}
        onSelectSpace={(args) => {
          if (!appShell.active) return;
          ++selectionGeneration.current;
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
              if (spaceId) invalidateApiGetCache(`/api/spaces/${encodeURIComponent(spaceId)}`);
              setRetryToken((current) => current + 1);
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
          ) : spaceLoadError &&
              (!explicitRenderer || requiresAuthoritativeResolution) &&
              !selectedSpace &&
              !selectedSnapshot &&
              !selectedFactPacket ? (
            <div className="spaces-shell__empty" data-testid="spaces-shell-empty">
              <p className="spaces-shell__empty-text">Space unavailable.</p>
            </div>
          ) : waitingForFactPacket ? (
            <div data-testid="spaces-shell-loading">
              <LoadingSkeleton variant="canvas" label="Loading space" />
            </div>
          ) : MountPoint ? (
            <MountPoint
              projectId={effectiveProjectId}
              spaceId={canonicalSpaceId}
              renderer={activeRenderer}
              instance={instance}
              initialFactPacket={selectedFactPacket}
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
