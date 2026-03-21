// Bug: e20c88e — Presets tab types

export type Preset = {
  id: string;
  name: string;
  description: string | null;
  markdown: string | null;
  token_estimate: number;
  created_at: number;
  updated_at: number;
};

export type PresetWithNodes = Preset & {
  nodes: PresetNode[];
};

export type PresetNode = {
  id: string;
  preset_id: string;
  parent_id: string | null;
  title: string;
  body: string;
  level: number;
  position: number;
  created_at: number;
  updated_at: number;
};

export type LibraryConvention = {
  id: string;
  title: string;
  body: string;
  preset_id: string;
  preset_name: string;
  source_presets: string[];
};

export type PresetDiff = {
  id: string;
  session_id: string;
  preset_id: string;
  node_id: string | null;
  change_type: 'added' | 'modified' | 'deleted';
  old_title: string | null;
  new_title: string | null;
  old_body: string | null;
  new_body: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: number;
};

// Undo/Redo command pattern
export type UndoCommandType = 'add' | 'delete' | 'edit' | 'move';

export type AddNodeCommand = {
  type: 'add';
  node: PresetNode;
};

export type DeleteNodeCommand = {
  type: 'delete';
  node: PresetNode;
  children: PresetNode[];
};

export type EditNodeCommand = {
  type: 'edit';
  nodeId: string;
  oldTitle: string;
  oldBody: string;
  newTitle: string;
  newBody: string;
};

export type MoveNodeCommand = {
  type: 'move';
  nodeId: string;
  oldParentId: string | null;
  oldPosition: number;
  newParentId: string | null;
  newPosition: number;
};

export type UndoCommand = AddNodeCommand | DeleteNodeCommand | EditNodeCommand | MoveNodeCommand;
