import type { SpaceItem } from '../../api';

export function spaceItemRef(item: SpaceItem): string {
  if (item.ref_uri?.trim()) return item.ref_uri.trim();
  if (item.ref_type === 'artifact') return item.ref_id;
  if (item.ref_type === 'issue') return `issue:${item.ref_id}`;
  return `mandible://${item.ref_type}/${item.ref_id}`;
}
