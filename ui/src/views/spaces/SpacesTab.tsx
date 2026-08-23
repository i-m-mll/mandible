import type { InstanceInfo, SpaceRenderer } from '../../api';
import type { SpacesRouteTarget } from '../../routing';
import { SpacesViewShell } from './SpacesViewShell';
import { SPACE_RENDERERS_REGISTRY } from './renderers';

export type SpacesTabProps = {
  projectId: string;
  spaceId: string | null;
  renderer?: SpaceRenderer | string;
  sidebarHidden?: boolean;
  instance?: InstanceInfo | null;
  onNavigate?: (target: SpacesRouteTarget) => void;
};

export function SpacesTab(props: SpacesTabProps): JSX.Element {
  return <SpacesViewShell {...props} renderers={SPACE_RENDERERS_REGISTRY} />;
}

export default SpacesTab;
