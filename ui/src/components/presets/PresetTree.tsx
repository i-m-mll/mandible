// Bug: e20c88e — Preset tree editor container
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PresetNode, UndoCommand } from '../../types/presets';
import {
  addPresetNode,
  deletePresetNode,
  fetchPresetNodes,
  reorderPresetNode,
  updatePresetNode,
} from '../../api';
import { PresetNodeView } from './PresetNode';

export type PresetTreeProps = {
  presetId: string;
  nodes: PresetNode[];
  editingNodeId: string | null;
  onNodesLoaded: (presetId: string, nodes: PresetNode[]) => void;
  onNodeAdded: (presetId: string, node: PresetNode) => void;
  onNodeUpdated: (presetId: string, node: PresetNode) => void;
  onNodeDeleted: (presetId: string, nodeId: string) => void;
  onNodeReordered: (presetId: string, nodeId: string, newParentId: string | null, newPosition: number) => void;
  onEditingNodeSet: (nodeId: string | null) => void;
  onPushUndo: (command: UndoCommand) => void;
  onUndo: () => void;
  onRedo: () => void;
  undoStack: UndoCommand[];
  redoStack: UndoCommand[];
  onOpenInsertModal: () => void;
};

type TreeNode = PresetNode & {
  childNodes: TreeNode[];
};

function buildTree(nodes: PresetNode[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Create TreeNode wrappers
  for (const node of nodes) {
    nodeMap.set(node.id, { ...node, childNodes: [] });
  }

  // Build parent-child relationships
  for (const node of nodes) {
    const treeNode = nodeMap.get(node.id)!;
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.childNodes.push(treeNode);
    } else {
      roots.push(treeNode);
    }
  }

  // Sort children by position
  const sortChildren = (list: TreeNode[]) => {
    list.sort((a, b) => a.position - b.position);
    for (const node of list) {
      sortChildren(node.childNodes);
    }
  };
  sortChildren(roots);

  return roots;
}

/** Flatten tree in document order for keyboard navigation */
function flattenTree(roots: TreeNode[], expanded: Set<string>): TreeNode[] {
  const result: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      result.push(node);
      if (node.childNodes.length > 0 && expanded.has(node.id)) {
        walk(node.childNodes);
      }
    }
  };
  walk(roots);
  return result;
}

export function PresetTree({
  presetId,
  nodes,
  editingNodeId,
  onNodesLoaded,
  onNodeAdded,
  onNodeUpdated,
  onNodeDeleted,
  onNodeReordered,
  onEditingNodeSet,
  onPushUndo,
  onUndo,
  onRedo,
  undoStack,
  redoStack,
  onOpenInsertModal,
}: PresetTreeProps): JSX.Element {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const announceRef = useRef<HTMLDivElement>(null);

  // Load nodes on mount or when presetId changes
  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchPresetNodes(presetId)
      .then((fetchedNodes) => {
        if (active) {
          onNodesLoaded(presetId, fetchedNodes);
          // Auto-expand all nodes on load
          const allIds = new Set(fetchedNodes.filter((n) =>
            fetchedNodes.some((c) => c.parent_id === n.id)
          ).map((n) => n.id));
          setExpanded(allIds);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [presetId]);

  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const flat = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  const announce = useCallback((msg: string) => {
    if (announceRef.current) {
      announceRef.current.textContent = msg;
    }
  }, []);

  const toggleExpand = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const handleStartEdit = useCallback((nodeId: string) => {
    onEditingNodeSet(nodeId);
  }, [onEditingNodeSet]);

  const handleSaveEdit = useCallback(async (nodeId: string, title: string, body: string) => {
    const existing = nodes.find((n) => n.id === nodeId);
    if (!existing) return;

    // Push undo command
    onPushUndo({
      type: 'edit',
      nodeId,
      oldTitle: existing.title,
      oldBody: existing.body,
      newTitle: title,
      newBody: body,
    });

    onEditingNodeSet(null);

    try {
      const updated = await updatePresetNode(presetId, nodeId, { title, body });
      onNodeUpdated(presetId, updated);
    } catch {
      // Revert on failure
      onNodeUpdated(presetId, existing);
    }
  }, [presetId, nodes, onNodeUpdated, onEditingNodeSet, onPushUndo]);

  const handleCancelEdit = useCallback(() => {
    onEditingNodeSet(null);
  }, [onEditingNodeSet]);

  const handleDelete = useCallback(async (nodeId: string) => {
    const existing = nodes.find((n) => n.id === nodeId);
    if (!existing) return;

    const childNodes = nodes.filter((n) => n.parent_id === nodeId);
    onPushUndo({ type: 'delete', node: existing, children: childNodes });

    onNodeDeleted(presetId, nodeId);
    // Also remove children from state
    for (const child of childNodes) {
      onNodeDeleted(presetId, child.id);
    }

    announce(`Deleted "${existing.title}"`);

    try {
      await deletePresetNode(presetId, nodeId);
    } catch {
      // Revert
      onNodeAdded(presetId, existing);
      for (const child of childNodes) {
        onNodeAdded(presetId, child);
      }
    }
  }, [presetId, nodes, onNodeDeleted, onNodeAdded, onPushUndo, announce]);

  const handleAddChild = useCallback(async (parentId: string) => {
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return;

    const siblings = nodes.filter((n) => n.parent_id === parentId);
    const position = siblings.length;

    // Expand parent so child is visible
    setExpanded((prev) => new Set([...prev, parentId]));

    try {
      const newNode = await addPresetNode(presetId, {
        parent_id: parentId,
        title: 'New convention',
        body: '',
        level: parent.level + 1,
        position,
      });
      onNodeAdded(presetId, newNode);
      onPushUndo({ type: 'add', node: newNode });
      onEditingNodeSet(newNode.id);
      setFocusedNodeId(newNode.id);
      announce(`Added child under "${parent.title}"`);
    } catch {
      // ignore
    }
  }, [presetId, nodes, onNodeAdded, onEditingNodeSet, onPushUndo, announce]);

  const handleAddSibling = useCallback(async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const siblings = nodes.filter((n) => n.parent_id === node.parent_id);
    const position = node.position + 1;

    try {
      const newNode = await addPresetNode(presetId, {
        parent_id: node.parent_id,
        title: 'New convention',
        body: '',
        level: node.level,
        position,
      });
      onNodeAdded(presetId, newNode);
      onPushUndo({ type: 'add', node: newNode });
      onEditingNodeSet(newNode.id);
      setFocusedNodeId(newNode.id);
      announce(`Added sibling after "${node.title}"`);
    } catch {
      // ignore
    }
  }, [presetId, nodes, onNodeAdded, onEditingNodeSet, onPushUndo, announce]);

  const handleSplitIntoChildren = useCallback(async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    // Parse headings from body
    const lines = node.body.split('\n');
    const sections: Array<{ title: string; body: string[] }> = [];
    let current: { title: string; body: string[] } | null = null;

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,6}\s+(.+)/);
      if (headingMatch) {
        if (current) sections.push(current);
        current = { title: headingMatch[1].trim(), body: [] };
      } else if (current) {
        current.body.push(line);
      } else {
        // Text before first heading — keep as parent body
        if (!current) {
          current = { title: '', body: [line] };
        }
      }
    }
    if (current) sections.push(current);

    if (sections.length <= 1) {
      announce('No headings found to split');
      return;
    }

    // Filter out the preamble section (empty title)
    const childSections = sections.filter((s) => s.title);
    if (childSections.length === 0) {
      announce('No headings found to split');
      return;
    }

    // Expand parent
    setExpanded((prev) => new Set([...prev, nodeId]));

    try {
      for (let i = 0; i < childSections.length; i++) {
        const section = childSections[i];
        const newNode = await addPresetNode(presetId, {
          parent_id: nodeId,
          title: section.title,
          body: section.body.join('\n').trim(),
          level: node.level + 1,
          position: i,
        });
        onNodeAdded(presetId, newNode);
      }

      // Clear body of parent
      const updated = await updatePresetNode(presetId, nodeId, {
        body: sections.find((s) => !s.title)?.body.join('\n').trim() || '',
      });
      onNodeUpdated(presetId, updated);

      announce(`Split "${node.title}" into ${childSections.length} children`);
    } catch {
      // ignore
    }
  }, [presetId, nodes, onNodeAdded, onNodeUpdated, announce]);

  const handleCopy = useCallback(async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const childNodes = nodes.filter((n) => n.parent_id === nodeId);
    let text = '';

    if (childNodes.length === 0) {
      // Leaf node: copy body
      text = node.body;
    } else {
      // Group: serialize subtree as markdown
      const serializeNode = (n: PresetNode, depth: number): string => {
        const prefix = '#'.repeat(Math.min(n.level + 1, 6));
        let result = `${prefix} ${n.title}\n\n`;
        if (n.body) result += `${n.body}\n\n`;
        const children = nodes
          .filter((c) => c.parent_id === n.id)
          .sort((a, b) => a.position - b.position);
        for (const child of children) {
          result += serializeNode(child, depth + 1);
        }
        return result;
      };
      text = serializeNode(node, 0).trim();
    }

    try {
      await navigator.clipboard.writeText(text);
      announce(`Copied "${node.title}"`);
    } catch {
      // ignore
    }
  }, [nodes, announce]);

  // Keyboard navigation
  const handleTreeKeyDown = useCallback((e: KeyboardEvent) => {
    // Undo/Redo: Cmd+Z / Cmd+Shift+Z
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undoStack.length > 0) {
        onUndo();
        const cmd = undoStack[undoStack.length - 1];
        applyUndoCommand(cmd, true);
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      if (redoStack.length > 0) {
        onRedo();
        const cmd = redoStack[redoStack.length - 1];
        applyUndoCommand(cmd, false);
      }
      return;
    }

    // Ctrl+I: open insert modal
    if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
      e.preventDefault();
      onOpenInsertModal();
      return;
    }

    // If editing, let the node handle its own keys
    if (editingNodeId) return;

    const focusIdx = flat.findIndex((n) => n.id === focusedNodeId);
    const focusNode = focusIdx >= 0 ? flat[focusIdx] : null;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = focusIdx < flat.length - 1 ? flat[focusIdx + 1] : flat[0];
        if (next) setFocusedNodeId(next.id);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = focusIdx > 0 ? flat[focusIdx - 1] : flat[flat.length - 1];
        if (prev) setFocusedNodeId(prev.id);
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (focusNode && focusNode.childNodes.length > 0) {
          if (!expanded.has(focusNode.id)) {
            setExpanded((prev) => new Set([...prev, focusNode.id]));
          } else {
            // Move to first child
            setFocusedNodeId(focusNode.childNodes[0].id);
          }
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (focusNode && expanded.has(focusNode.id) && focusNode.childNodes.length > 0) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(focusNode.id);
            return next;
          });
        } else if (focusNode && focusNode.parent_id) {
          setFocusedNodeId(focusNode.parent_id);
        }
        break;
      }
      case 'Enter': {
        e.preventDefault();
        if (focusNode) handleStartEdit(focusNode.id);
        break;
      }
      default:
        break;
    }

    // Alt+arrows: reorder / indent / outdent
    if (e.altKey && focusNode) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const siblings = nodes
          .filter((n) => n.parent_id === focusNode.parent_id)
          .sort((a, b) => a.position - b.position);
        const sibIdx = siblings.findIndex((s) => s.id === focusNode.id);
        if (sibIdx < 0) return;

        const targetIdx = e.key === 'ArrowUp' ? sibIdx - 1 : sibIdx + 1;
        if (targetIdx < 0 || targetIdx >= siblings.length) return;

        const oldPos = focusNode.position;
        const newPos = siblings[targetIdx].position;

        onPushUndo({
          type: 'move',
          nodeId: focusNode.id,
          oldParentId: focusNode.parent_id,
          oldPosition: oldPos,
          newParentId: focusNode.parent_id,
          newPosition: newPos,
        });

        onNodeReordered(presetId, focusNode.id, focusNode.parent_id, newPos);
        reorderPresetNode(presetId, {
          nodeId: focusNode.id,
          newParentId: focusNode.parent_id,
          newPosition: newPos,
        }).catch(() => {
          // Revert
          onNodeReordered(presetId, focusNode.id, focusNode.parent_id, oldPos);
        });

        announce(`Moved "${focusNode.title}" ${e.key === 'ArrowUp' ? 'up' : 'down'}`);
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        // Indent: nest as child of previous sibling
        const siblings = nodes
          .filter((n) => n.parent_id === focusNode.parent_id)
          .sort((a, b) => a.position - b.position);
        const sibIdx = siblings.findIndex((s) => s.id === focusNode.id);
        if (sibIdx <= 0) return;

        const newParent = siblings[sibIdx - 1];
        const newChildren = nodes.filter((n) => n.parent_id === newParent.id);
        const newPos = newChildren.length;

        onPushUndo({
          type: 'move',
          nodeId: focusNode.id,
          oldParentId: focusNode.parent_id,
          oldPosition: focusNode.position,
          newParentId: newParent.id,
          newPosition: newPos,
        });

        setExpanded((prev) => new Set([...prev, newParent.id]));
        onNodeReordered(presetId, focusNode.id, newParent.id, newPos);
        reorderPresetNode(presetId, {
          nodeId: focusNode.id,
          newParentId: newParent.id,
          newPosition: newPos,
        }).catch(() => {
          onNodeReordered(presetId, focusNode.id, focusNode.parent_id, focusNode.position);
        });

        announce(`Indented "${focusNode.title}" under "${newParent.title}"`);
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        // Outdent: promote to parent's sibling list
        if (!focusNode.parent_id) return;
        const parent = nodes.find((n) => n.id === focusNode.parent_id);
        if (!parent) return;

        const newParentId = parent.parent_id;
        const newSiblings = nodes.filter((n) => n.parent_id === newParentId);
        const newPos = parent.position + 1;

        onPushUndo({
          type: 'move',
          nodeId: focusNode.id,
          oldParentId: focusNode.parent_id,
          oldPosition: focusNode.position,
          newParentId,
          newPosition: newPos,
        });

        onNodeReordered(presetId, focusNode.id, newParentId, newPos);
        reorderPresetNode(presetId, {
          nodeId: focusNode.id,
          newParentId,
          newPosition: newPos,
        }).catch(() => {
          onNodeReordered(presetId, focusNode.id, focusNode.parent_id, focusNode.position);
        });

        announce(`Outdented "${focusNode.title}"`);
      }
    }
  }, [
    flat, focusedNodeId, editingNodeId, expanded, nodes, presetId,
    undoStack, redoStack, onUndo, onRedo, onOpenInsertModal,
    handleStartEdit, onPushUndo, onNodeReordered, announce,
  ]);

  // Apply undo/redo command effects
  const applyUndoCommand = useCallback(async (cmd: UndoCommand, isUndo: boolean) => {
    switch (cmd.type) {
      case 'edit': {
        const title = isUndo ? cmd.oldTitle : cmd.newTitle;
        const body = isUndo ? cmd.oldBody : cmd.newBody;
        try {
          const updated = await updatePresetNode(presetId, cmd.nodeId, { title, body });
          onNodeUpdated(presetId, updated);
        } catch {
          // ignore
        }
        break;
      }
      case 'add': {
        if (isUndo) {
          onNodeDeleted(presetId, cmd.node.id);
          try { await deletePresetNode(presetId, cmd.node.id); } catch { /* */ }
        } else {
          try {
            const newNode = await addPresetNode(presetId, cmd.node);
            onNodeAdded(presetId, newNode);
          } catch { /* */ }
        }
        break;
      }
      case 'delete': {
        if (isUndo) {
          try {
            const restored = await addPresetNode(presetId, cmd.node);
            onNodeAdded(presetId, restored);
            for (const child of cmd.children) {
              const restoredChild = await addPresetNode(presetId, child);
              onNodeAdded(presetId, restoredChild);
            }
          } catch { /* */ }
        } else {
          onNodeDeleted(presetId, cmd.node.id);
          try { await deletePresetNode(presetId, cmd.node.id); } catch { /* */ }
        }
        break;
      }
      case 'move': {
        const parentId = isUndo ? cmd.oldParentId : cmd.newParentId;
        const position = isUndo ? cmd.oldPosition : cmd.newPosition;
        onNodeReordered(presetId, cmd.nodeId, parentId, position);
        try {
          await reorderPresetNode(presetId, {
            nodeId: cmd.nodeId,
            newParentId: parentId,
            newPosition: position,
          });
        } catch { /* */ }
        break;
      }
    }
  }, [presetId, onNodeAdded, onNodeUpdated, onNodeDeleted, onNodeReordered]);

  const handleAddRoot = useCallback(async () => {
    const rootNodes = nodes.filter((n) => !n.parent_id);
    try {
      const newNode = await addPresetNode(presetId, {
        parent_id: null,
        title: 'New section',
        body: '',
        level: 0,
        position: rootNodes.length,
      });
      onNodeAdded(presetId, newNode);
      onPushUndo({ type: 'add', node: newNode });
      onEditingNodeSet(newNode.id);
      setFocusedNodeId(newNode.id);
    } catch {
      // ignore
    }
  }, [presetId, nodes, onNodeAdded, onEditingNodeSet, onPushUndo]);

  const renderNode = (treeNode: TreeNode, siblings: TreeNode[]): JSX.Element => {
    const isLeaf = treeNode.childNodes.length === 0;
    const childElements = isLeaf
      ? null
      : treeNode.childNodes.map((child) =>
          renderNode(child, treeNode.childNodes),
        );

    return (
      <PresetNodeView
        key={treeNode.id}
        node={treeNode}
        depth={treeNode.level}
        isEditing={editingNodeId === treeNode.id}
        isFocused={focusedNodeId === treeNode.id}
        onStartEdit={handleStartEdit}
        onSaveEdit={handleSaveEdit}
        onCancelEdit={handleCancelEdit}
        onDelete={handleDelete}
        onAddChild={handleAddChild}
        onAddSibling={handleAddSibling}
        onSplitIntoChildren={handleSplitIntoChildren}
        onCopy={handleCopy}
        onFocus={setFocusedNodeId}
        isLeaf={isLeaf}
        ariaSetSize={siblings.length}
        ariaPosInSet={siblings.indexOf(treeNode) + 1}
        isExpanded={expanded.has(treeNode.id)}
        onToggleExpand={toggleExpand}
      >
        {childElements}
      </PresetNodeView>
    );
  };

  if (loading) {
    return (
      <div className="preset-tree__loading">
        <span className="text-muted">Loading conventions...</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="preset-tree"
      role="tree"
      aria-label="Preset conventions tree"
      onKeyDown={handleTreeKeyDown}
    >
      <div ref={announceRef} className="sr-only" aria-live="polite" aria-atomic="true" />

      {tree.length === 0 ? (
        <div className="preset-tree__empty">
          <p className="text-muted">No conventions yet.</p>
          <button
            type="button"
            className="preset-tree__add-root-btn"
            onClick={handleAddRoot}
          >
            + Add first section
          </button>
        </div>
      ) : (
        <>
          <div className="preset-tree__toolbar">
            <button
              type="button"
              className="preset-tree__toolbar-btn"
              onClick={handleAddRoot}
              title="Add root section"
            >
              + Section
            </button>
            <button
              type="button"
              className="preset-tree__toolbar-btn"
              onClick={onOpenInsertModal}
              title="Insert from Library (Ctrl+I)"
            >
              + Insert
            </button>
            <div className="preset-tree__toolbar-spacer" />
            <button
              type="button"
              className="preset-tree__toolbar-btn"
              onClick={() => {
                if (undoStack.length > 0) {
                  onUndo();
                  applyUndoCommand(undoStack[undoStack.length - 1], true);
                }
              }}
              disabled={undoStack.length === 0}
              title="Undo (Cmd+Z)"
            >
              Undo
            </button>
            <button
              type="button"
              className="preset-tree__toolbar-btn"
              onClick={() => {
                if (redoStack.length > 0) {
                  onRedo();
                  applyUndoCommand(redoStack[redoStack.length - 1], false);
                }
              }}
              disabled={redoStack.length === 0}
              title="Redo (Cmd+Shift+Z)"
            >
              Redo
            </button>
          </div>
          <div className="preset-tree__nodes">
            {tree.map((root) => renderNode(root, tree))}
          </div>
        </>
      )}
    </div>
  );
}
