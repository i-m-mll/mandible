// Bug: a654b69 — P4: group consecutive same-entity RenderNodes for TurnGroup layout

export type GroupEntity = 'user' | 'assistant' | 'system';

export type NodeGroup<T> = {
  id: string;
  entity: GroupEntity;
  nodes: T[];
};

/**
 * Group consecutive items that share the same entity into NodeGroup chunks.
 * One level only — no sub-grouping within groups.
 */
export function groupByEntity<T>(
  items: T[],
  getEntity: (item: T) => GroupEntity,
  getId: (item: T) => string,
): NodeGroup<T>[] {
  const groups: NodeGroup<T>[] = [];

  for (const item of items) {
    const entity = getEntity(item);
    const last = groups[groups.length - 1];

    if (last && last.entity === entity) {
      last.nodes.push(item);
    } else {
      groups.push({
        id: `group-${getId(item)}`,
        entity,
        nodes: [item],
      });
    }
  }

  return groups;
}
