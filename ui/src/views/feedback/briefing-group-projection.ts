import type { BriefingBundle, BriefingGroup } from '../../api';

export type BriefingGroupBundleOwners = ReadonlyMap<string, BriefingGroup | null>;

export type BriefingGroupProjection = {
  ownerGroupId: string;
  layoutSource: BriefingBundle | null;
  selectedUpdate: BriefingBundle | null;
};

export function indexBriefingGroupBundleOwners(
  groups: readonly BriefingGroup[],
): BriefingGroupBundleOwners {
  const owners = new Map<string, BriefingGroup | null>();
  for (const group of groups) {
    const bundles = [...(group.current ? [group.current] : []), ...group.updates];
    for (const bundle of bundles) {
      const owner = owners.get(bundle.id);
      owners.set(bundle.id, owner === undefined || owner === group ? group : null);
    }
  }
  return owners;
}

export function resolveBriefingGroupProjection(
  group: BriefingGroup,
  requestedUpdateId: string | null | undefined,
  owners: BriefingGroupBundleOwners,
): BriefingGroupProjection {
  const selectedUpdate = group.updates.find((candidate) => (
    candidate.id === requestedUpdateId && owners.get(candidate.id) === group
  )) ?? null;
  const current = group.current && owners.get(group.current.id) === group
    ? group.current
    : null;
  return {
    ownerGroupId: group.id,
    layoutSource: selectedUpdate ?? current,
    selectedUpdate,
  };
}

export function briefingGroupOwnsUpdate(
  group: BriefingGroup,
  updateId: string,
  owners: BriefingGroupBundleOwners,
): boolean {
  return owners.get(updateId) === group
    && group.updates.some((candidate) => candidate.id === updateId);
}
