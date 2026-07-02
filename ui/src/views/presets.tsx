// Bug: e20c88e — Presets tab view
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type {
  Preset,
  PresetNode,
  LibraryConvention,
  UndoCommand,
} from '../types/presets';
import {
  addPresetNode,
  createPreset,
  deletePreset,
  exportPreset,
  fetchPresets,
  updatePreset,
} from '../api';
import { ViewSidebar } from '../components/ViewSidebar';
import { PresetTree } from '../components/presets/PresetTree';
import { ConventionLibrary } from '../components/presets/ConventionLibrary';
import { InsertFromLibraryModal } from '../components/presets/InsertFromLibraryModal';

export type PresetsViewProps = {
  presetsState: {
    presets: Preset[];
    selectedPresetId: string | null;
    libraryMode: boolean;
    editingNodeId: string | null;
    nodes: Record<string, PresetNode[]>;
    undoStack: UndoCommand[];
    redoStack: UndoCommand[];
  };
  dispatch: (action: unknown) => void;
  sidebarHidden?: boolean;
};

export function PresetsView({
  presetsState,
  dispatch,
  sidebarHidden = false,
}: PresetsViewProps): JSX.Element {
  const [insertModalOpen, setInsertModalOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [menuPresetId, setMenuPresetId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Load presets on mount
  useEffect(() => {
    fetchPresets()
      .then((presets) => dispatch({ type: 'presetsLoaded', presets }))
      .catch(() => undefined);
  }, [dispatch]);

  // Close menu on click outside
  useEffect(() => {
    if (!menuPresetId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPresetId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuPresetId]);

  const selectedPreset = presetsState.presets.find(
    (p) => p.id === presetsState.selectedPresetId,
  );

  const handleSelectPreset = useCallback(
    (presetId: string) => {
      dispatch({ type: 'presetSelected', presetId });
    },
    [dispatch],
  );

  const handleLibraryToggle = useCallback(() => {
    dispatch({ type: 'libraryToggled', libraryMode: !presetsState.libraryMode });
  }, [dispatch, presetsState.libraryMode]);

  const handleCreatePreset = useCallback(async () => {
    try {
      const preset = await createPreset({ name: 'New Preset' });
      dispatch({ type: 'presetCreated', preset });
      setEditingName(preset.id);
    } catch (err) {
      console.error('Failed to create preset:', err);
    }
  }, [dispatch]);

  const handleDeletePreset = useCallback(
    async (presetId: string) => {
      try {
        await deletePreset(presetId);
        dispatch({ type: 'presetDeleted', presetId });
      } catch (err) {
        console.error('Failed to delete preset:', err);
      }
      setMenuPresetId(null);
    },
    [dispatch],
  );

  const handleRenamePreset = useCallback(
    async (presetId: string, name: string) => {
      try {
        const updated = await updatePreset(presetId, { name } as Partial<Preset>);
        dispatch({ type: 'presetUpdated', preset: updated });
      } catch (err) {
        console.error('Failed to rename preset:', err);
      }
      setEditingName(null);
    },
    [dispatch],
  );

  const handleExportPreset = useCallback(async (presetId: string) => {
    try {
      const markdown = await exportPreset(presetId);
      const blob = new Blob([markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `preset-${presetId.slice(0, 8)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export preset:', err);
    }
    setMenuPresetId(null);
  }, []);

  const handleNodesLoaded = useCallback(
    (presetId: string, nodes: PresetNode[]) => {
      dispatch({ type: 'nodesLoaded', presetId, nodes });
    },
    [dispatch],
  );

  const handleNodeAdded = useCallback(
    (presetId: string, node: PresetNode) => {
      dispatch({ type: 'nodeAdded', presetId, node });
    },
    [dispatch],
  );

  const handleNodeUpdated = useCallback(
    (presetId: string, node: PresetNode) => {
      dispatch({ type: 'nodeUpdated', presetId, node });
    },
    [dispatch],
  );

  const handleNodeDeleted = useCallback(
    (presetId: string, nodeId: string) => {
      dispatch({ type: 'nodeDeleted', presetId, nodeId });
    },
    [dispatch],
  );

  const handleNodeReordered = useCallback(
    (presetId: string, nodeId: string, newParentId: string | null, newPosition: number) => {
      dispatch({ type: 'nodeReordered', presetId, nodeId, newParentId, newPosition });
    },
    [dispatch],
  );

  const handleEditingNodeSet = useCallback(
    (nodeId: string | null) => {
      dispatch({ type: 'editingNodeSet', nodeId });
    },
    [dispatch],
  );

  const handlePushUndo = useCallback(
    (command: UndoCommand) => {
      dispatch({ type: 'presetsPushUndo', command });
    },
    [dispatch],
  );

  const handleUndo = useCallback(() => {
    dispatch({ type: 'presetsUndo' });
  }, [dispatch]);

  const handleRedo = useCallback(() => {
    dispatch({ type: 'presetsRedo' });
  }, [dispatch]);

  const handleAddConventionToPreset = useCallback(
    async (convention: LibraryConvention) => {
      if (!presetsState.selectedPresetId) return;
      const presetId = presetsState.selectedPresetId;
      const existingNodes = presetsState.nodes[presetId] || [];
      const rootNodes = existingNodes.filter((n) => !n.parent_id);

      try {
        const newNode = await addPresetNode(presetId, {
          parent_id: null,
          title: convention.title,
          body: convention.body,
          level: 0,
          position: rootNodes.length,
        });
        dispatch({ type: 'nodeAdded', presetId, node: newNode });
        // Bug: e20c88e — Push undo for library convention add (was missing)
        dispatch({
          type: 'presetsPushUndo',
          command: { type: 'add', node: newNode },
        });
      } catch (err) {
        console.error('Failed to add convention to preset:', err);
      }
    },
    [dispatch, presetsState.selectedPresetId, presetsState.nodes],
  );

  const handleInsertFromLibrary = useCallback(
    async (convention: LibraryConvention) => {
      if (!presetsState.selectedPresetId) return;
      const presetId = presetsState.selectedPresetId;
      const existingNodes = presetsState.nodes[presetId] || [];
      const rootNodes = existingNodes.filter((n) => !n.parent_id);

      try {
        const newNode = await addPresetNode(presetId, {
          parent_id: null,
          title: convention.title,
          body: convention.body,
          level: 0,
          position: rootNodes.length,
        });
        dispatch({ type: 'nodeAdded', presetId, node: newNode });
        dispatch({
          type: 'presetsPushUndo',
          command: { type: 'add', node: newNode },
        });
      } catch (err) {
        console.error('Failed to insert from library:', err);
      }
    },
    [dispatch, presetsState.selectedPresetId, presetsState.nodes],
  );

  const currentNodes = presetsState.selectedPresetId
    ? presetsState.nodes[presetsState.selectedPresetId] || []
    : [];

  // Compute token estimate from nodes
  const tokenEstimate = currentNodes.reduce((sum, n) => {
    return sum + Math.ceil((n.title.length + n.body.length) / 4);
  }, 0);

  return (
    <div className="presets-view">
      <ViewSidebar
        storageKey="mandible-presets-sidebar-width"
        defaultWidth={260}
        minWidth={200}
        className="presets-sidebar"
        ariaLabel="Presets"
        hidden={sidebarHidden}
        header={
          <button
            type="button"
            className={`presets-sidebar__item presets-sidebar__item--library${presetsState.libraryMode ? ' presets-sidebar__item--active' : ''}`}
            onClick={handleLibraryToggle}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="1" y="1" width="5" height="5" rx="1" />
              <rect x="8" y="1" width="5" height="5" rx="1" />
              <rect x="1" y="8" width="5" height="5" rx="1" />
              <rect x="8" y="8" width="5" height="5" rx="1" />
            </svg>
            <span>Convention Library</span>
          </button>
        }
        bodyClassName="presets-sidebar__list"
        footer={
          <button
            type="button"
            className="presets-sidebar__add-btn"
            onClick={handleCreatePreset}
          >
            + New Preset
          </button>
        }
      >
          {presetsState.presets.map((preset) => {
            const isSelected =
              !presetsState.libraryMode && presetsState.selectedPresetId === preset.id;
            const isMenuOpen = menuPresetId === preset.id;
            const isRenaming = editingName === preset.id;
            const presetNodes = presetsState.nodes[preset.id] || [];
            const tokens = presetNodes.reduce(
              (sum, n) => sum + Math.ceil((n.title.length + n.body.length) / 4),
              0,
            ) || preset.token_estimate || 0;

            return (
              <div
                key={preset.id}
                className={`presets-sidebar__item${isSelected ? ' presets-sidebar__item--active' : ''}`}
                onClick={() => handleSelectPreset(preset.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelectPreset(preset.id);
                  }
                }}
              >
                {isRenaming ? (
                  <input
                    className="presets-sidebar__rename-input"
                    type="text"
                    defaultValue={preset.name}
                    autoFocus
                    onBlur={(e) => handleRenamePreset(preset.id, (e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleRenamePreset(preset.id, (e.target as HTMLInputElement).value);
                      } else if (e.key === 'Escape') {
                        setEditingName(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="presets-sidebar__item-name">{preset.name}</span>
                )}
                {tokens > 0 && (
                  <span className="presets-sidebar__token-badge">
                    {tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}
                  </span>
                )}
                <div
                  className="presets-sidebar__menu-wrap"
                  ref={isMenuOpen ? menuRef : undefined}
                >
                  <button
                    type="button"
                    className="presets-sidebar__menu-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuPresetId(isMenuOpen ? null : preset.id);
                    }}
                    aria-label="Preset actions"
                  >
                    ...
                  </button>
                  {isMenuOpen && (
                    <div className="presets-sidebar__menu">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingName(preset.id);
                          setMenuPresetId(null);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleExportPreset(preset.id);
                        }}
                      >
                        Export
                      </button>
                      <button
                        type="button"
                        className="presets-sidebar__menu-item--danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeletePreset(preset.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </ViewSidebar>

      <div className="presets-main">
        {presetsState.libraryMode ? (
          <ConventionLibrary
            selectedPresetId={presetsState.selectedPresetId}
            onAddToPreset={handleAddConventionToPreset}
          />
        ) : selectedPreset ? (
          <>
            <div className="presets-main__header">
              <h2 className="presets-main__title">{selectedPreset.name}</h2>
              <div className="presets-main__meta">
                <span className="presets-main__token-count text-muted">
                  ~{tokenEstimate > 1000 ? `${(tokenEstimate / 1000).toFixed(1)}k` : tokenEstimate} tokens
                </span>
              </div>
            </div>
            <PresetTree
              presetId={selectedPreset.id}
              nodes={currentNodes}
              editingNodeId={presetsState.editingNodeId}
              onNodesLoaded={handleNodesLoaded}
              onNodeAdded={handleNodeAdded}
              onNodeUpdated={handleNodeUpdated}
              onNodeDeleted={handleNodeDeleted}
              onNodeReordered={handleNodeReordered}
              onEditingNodeSet={handleEditingNodeSet}
              onPushUndo={handlePushUndo}
              onUndo={handleUndo}
              onRedo={handleRedo}
              undoStack={presetsState.undoStack}
              redoStack={presetsState.redoStack}
              onOpenInsertModal={() => setInsertModalOpen(true)}
            />
          </>
        ) : (
          <div className="presets-main__empty">
            <p className="text-muted">
              Select a preset from the sidebar, or browse the Convention Library.
            </p>
          </div>
        )}
      </div>

      <InsertFromLibraryModal
        isOpen={insertModalOpen}
        onClose={() => setInsertModalOpen(false)}
        onInsert={handleInsertFromLibrary}
      />
    </div>
  );
}
