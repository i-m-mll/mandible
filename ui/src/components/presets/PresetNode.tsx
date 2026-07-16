// Bug: e20c88e — Preset tree node component
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { renderMarkdown } from '../../lib/markdown';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
import type { PresetNode as PresetNodeType } from '../../types/presets';

export type PresetNodeProps = {
  node: PresetNodeType;
  depth: number;
  isEditing: boolean;
  isFocused: boolean;
  onStartEdit: (nodeId: string) => void;
  onSaveEdit: (nodeId: string, title: string, body: string) => void;
  onCancelEdit: () => void;
  onDelete: (nodeId: string) => void;
  onAddChild: (parentId: string) => void;
  onAddSibling: (nodeId: string) => void;
  onSplitIntoChildren: (nodeId: string) => void;
  onCopy: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
  onDrop: (sourceId: string, targetId: string, edge: Edge | null) => void;
  isLeaf: boolean;
  children?: JSX.Element | JSX.Element[] | null;
  ariaSetSize: number;
  ariaPosInSet: number;
  isExpanded: boolean;
  onToggleExpand: (nodeId: string) => void;
};

export function PresetNodeView({
  node,
  depth,
  isEditing,
  isFocused,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onAddChild,
  onAddSibling,
  onSplitIntoChildren,
  onCopy,
  onFocus,
  onDrop,
  isLeaf,
  children,
  ariaSetSize,
  ariaPosInSet,
  isExpanded,
  onToggleExpand,
}: PresetNodeProps): JSX.Element {
  const [editTitle, setEditTitle] = useState(node.title);
  const [editBody, setEditBody] = useState(node.body);
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLSpanElement>(null);

  // Wire up pragmatic-drag-and-drop
  useEffect(() => {
    const el = nodeRef.current;
    const handle = dragHandleRef.current;
    if (!el || !handle) return;

    const cleanupDraggable = draggable({
      element: el,
      dragHandle: handle,
      getInitialData: () => ({ nodeId: node.id, type: 'preset-node' }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });

    const cleanupDropTarget = dropTargetForElements({
      element: el,
      getData: ({ input, element }) => {
        return attachClosestEdge(
          { nodeId: node.id },
          { input, element, allowedEdges: ['top', 'bottom'] },
        );
      },
      canDrop: ({ source }) => {
        const data = source.data;
        return data.type === 'preset-node' && data.nodeId !== node.id;
      },
      onDragEnter: ({ self }) => {
        setIsDropTarget(true);
        setClosestEdge(extractClosestEdge(self.data));
      },
      onDrag: ({ self }) => {
        setClosestEdge(extractClosestEdge(self.data));
      },
      onDragLeave: () => {
        setIsDropTarget(false);
        setClosestEdge(null);
      },
      onDrop: ({ source, self }) => {
        setIsDropTarget(false);
        const edge = extractClosestEdge(self.data);
        setClosestEdge(null);
        const sourceId = source.data.nodeId as string;
        onDrop(sourceId, node.id, edge);
      },
    });

    return () => {
      cleanupDraggable();
      cleanupDropTarget();
    };
  }, [node.id, onDrop]);

  useEffect(() => {
    if (isEditing) {
      setEditTitle(node.title);
      setEditBody(node.body);
      requestAnimationFrame(() => {
        titleInputRef.current?.focus();
      });
    }
  }, [isEditing, node.title, node.body]);

  useEffect(() => {
    if (isFocused && nodeRef.current && !isEditing) {
      nodeRef.current.focus();
    }
  }, [isFocused, isEditing]);

  // Close menu on click outside
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const handleSave = useCallback(() => {
    // Bug: e20c88e — Skip API call and undo push if nothing changed
    if (editTitle === node.title && editBody === node.body) {
      onCancelEdit();
      return;
    }
    onSaveEdit(node.id, editTitle, editBody);
  }, [node.id, node.title, node.body, editTitle, editBody, onSaveEdit, onCancelEdit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isEditing) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancelEdit();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          handleSave();
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        onStartEdit(node.id);
      }
    },
    [isEditing, node.id, onStartEdit, onCancelEdit, handleSave],
  );

  const handleCopy = useCallback(() => {
    onCopy(node.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    setShowMenu(false);
  }, [node.id, onCopy]);

  const HeadingTag = `h${Math.min(node.level + 1, 6)}` as keyof JSX.IntrinsicElements;

  const sanitizedBody = renderMarkdown(node.body);

  const hasChildren = !isLeaf;

  return (
    <div
      ref={nodeRef}
      className={`preset-node${isFocused ? ' preset-node--focused' : ''}${isEditing ? ' preset-node--editing' : ''}${isDragging ? ' preset-node--dragging' : ''}${isDropTarget ? ' preset-node--drop-target' : ''}${closestEdge === 'top' ? ' preset-node--drop-top' : ''}${closestEdge === 'bottom' ? ' preset-node--drop-bottom' : ''}`}
      style={{ paddingLeft: `${depth * 16}px` }}
      role="treeitem"
      aria-level={depth + 1}
      aria-setsize={ariaSetSize}
      aria-posinset={ariaPosInSet}
      aria-expanded={hasChildren ? isExpanded : undefined}
      tabIndex={isFocused ? 0 : -1}
      onKeyDown={handleKeyDown}
      onClick={() => onFocus(node.id)}
      data-node-id={node.id}
    >
      <div className="preset-node__header">
        <span ref={dragHandleRef} className="preset-node__drag-handle" aria-hidden="true" title="Drag to reorder">
          <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
            <circle cx="2" cy="2" r="1.2" />
            <circle cx="6" cy="2" r="1.2" />
            <circle cx="2" cy="7" r="1.2" />
            <circle cx="6" cy="7" r="1.2" />
            <circle cx="2" cy="12" r="1.2" />
            <circle cx="6" cy="12" r="1.2" />
          </svg>
        </span>

        {hasChildren && (
          <button
            type="button"
            className="preset-node__expand-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.id);
            }}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="currentColor"
              className={`preset-node__expand-icon${isExpanded ? ' preset-node__expand-icon--expanded' : ''}`}
            >
              <path d="M3 2l4 3-4 3z" />
            </svg>
          </button>
        )}

        {isEditing ? (
          <div className="preset-node__edit-header">
            <span className="preset-node__level-badge">H{node.level + 1}</span>
            <input
              ref={titleInputRef}
              className="preset-node__title-input"
              type="text"
              value={editTitle}
              onInput={(e) => setEditTitle((e.target as HTMLInputElement).value)}
              placeholder="Node title"
            />
          </div>
        ) : (
          <HeadingTag className="preset-node__title">
            {node.title || '(untitled)'}
          </HeadingTag>
        )}

        <div className="preset-node__actions">
          {copied && <span className="preset-node__copied-toast">Copied</span>}
          <div className="preset-node__menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="preset-node__menu-btn"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
              aria-label="Node actions"
            >
              ...
            </button>
            {showMenu && (
              <div className="preset-node__menu">
                <button type="button" onClick={() => { onStartEdit(node.id); setShowMenu(false); }}>
                  Edit
                </button>
                <button type="button" onClick={() => { onAddChild(node.id); setShowMenu(false); }}>
                  Add child
                </button>
                <button type="button" onClick={() => { onAddSibling(node.id); setShowMenu(false); }}>
                  Add sibling
                </button>
                <button
                  type="button"
                  onClick={() => { onSplitIntoChildren(node.id); setShowMenu(false); }}
                  disabled={!node.body || !/^#{1,6}\s+/m.test(node.body)}
                  className={(!node.body || !/^#{1,6}\s+/m.test(node.body)) ? 'preset-node__menu-item--disabled' : ''}
                >
                  Split into children
                </button>
                <button type="button" onClick={handleCopy}>
                  Copy
                </button>
                <button
                  type="button"
                  className="preset-node__menu-item--danger"
                  onClick={() => { onDelete(node.id); setShowMenu(false); }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {isEditing ? (
        <div className="preset-node__edit-body">
          <textarea
            ref={bodyTextareaRef}
            className="preset-node__body-textarea"
            value={editBody}
            onInput={(e) => setEditBody((e.target as HTMLTextAreaElement).value)}
            placeholder="Convention body (Markdown)"
            rows={6}
          />
          <div className="preset-node__edit-actions">
            <button
              type="button"
              className="preset-node__save-btn"
              onClick={handleSave}
            >
              Save
            </button>
            <button
              type="button"
              className="preset-node__cancel-btn"
              onClick={onCancelEdit}
            >
              Cancel
            </button>
            <span className="text-muted" style={{ fontSize: '11px' }}>
              Ctrl+Enter to save, Esc to cancel
            </span>
          </div>
        </div>
      ) : (
        node.body && (
          <div
            className="preset-node__body"
            dangerouslySetInnerHTML={{ __html: sanitizedBody }}
          />
        )
      )}

      {hasChildren && isExpanded && children && (
        <div className="preset-node__children" role="group">
          {children}
        </div>
      )}
    </div>
  );
}
