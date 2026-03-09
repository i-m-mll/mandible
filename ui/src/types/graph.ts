// Stub — will be replaced when P2 merges
export type GraphNodeType = 'session' | 'issue' | 'auth_request' | 'branch';
export type GraphEdgeType = 'session_issue' | 'session_parent' | 'auth_branch' | 'auth_issue' | 'branch_issue' | 'umbrella_child';
export interface GraphNode { id: string; type: GraphNodeType; label: string; status?: string; labels?: string[]; repo?: string; branch?: string; active?: boolean; created_at?: string; }
export interface GraphEdge { id: string; source: string; target: string; type: GraphEdgeType; }
