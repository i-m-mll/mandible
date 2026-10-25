import { getSpaceFactPacket, listSpacesGrouped, type InstanceInfo, type SpaceRenderer } from '../../api';
import { detailRequestKey, readPersistedDetail, writePersistedDetail } from '../../detail-cache';
import type { SpacesRouteTarget } from '../../routing';
import { defaultInitialSpaceId, persistGroups } from './SpacesSidebar';
import { SpacesViewShell } from './SpacesViewShell';
import { SPACE_RENDERERS_REGISTRY } from './renderers';
import { savedSpacesSelection, type SpacesLastView } from './last-view';

export type SpacesTabProps = {
  projectId: string;
  spaceId: string | null;
  savedSelection?: SpacesLastView | null;
  renderer?: SpaceRenderer | string;
  sidebarHidden?: boolean;
  instance?: InstanceInfo | null;
  onNavigate?: (target: SpacesRouteTarget) => void;
};

export function SpacesTab(props: SpacesTabProps): JSX.Element {
  return <SpacesViewShell {...props} renderers={SPACE_RENDERERS_REGISTRY} />;
}

export async function warmInitialData(params: Record<string, string>): Promise<void> {
  const groups = await listSpacesGrouped();
  persistGroups(groups);
  const spaceId = params.space?.trim() || savedSpacesSelection(params)?.spaceId || defaultInitialSpaceId(groups);
  if (!spaceId) return;
  const cachedKey = detailRequestKey('spaces', { spaceId });
  if (readPersistedDetail('spaces', cachedKey)) return;
  const packet = await getSpaceFactPacket(spaceId);
  writePersistedDetail(
    'spaces',
    detailRequestKey('spaces', { spaceId: packet.space.id }),
    packet,
  );
}

export default SpacesTab;
