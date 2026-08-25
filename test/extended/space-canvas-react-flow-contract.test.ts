import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { applyLocalNodeChanges } from '../../ui/src/views/spaces/SpaceCanvas';

type ContractNode = Node<{ label: string }, 'spaceOccurrence'>;

function node(id: string, x: number, y: number): ContractNode {
  return {
    id,
    position: { x, y },
    data: { label: id },
    type: 'spaceOccurrence',
  };
}

describe('SpaceCanvas real React Flow node contract', () => {
  it('delegates local controlled-mode updates to the actual React Flow applier', () => {
    const nodes = [node('a', 10, 20), node('b', 30, 40)];
    const replacement = node('b', 70, 80);
    const added = node('c', 90, 100);
    const changes: NodeChange<ContractNode>[] = [
      { type: 'position', id: 'a', position: { x: 25, y: 30 }, dragging: true },
      { type: 'dimensions', id: 'a', dimensions: { width: 240, height: 120 }, setAttributes: true },
      { type: 'remove', id: 'b' },
      { type: 'replace', id: 'b', item: replacement },
      { type: 'add', item: added },
    ];

    expect(applyLocalNodeChanges(nodes, changes)).toEqual(applyNodeChanges(changes, nodes));
  });
});
