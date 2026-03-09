// Bug: 5733427 — GraphView bigbuild P2: shared graph type definitions
// Bug: bdcc1f5 — removed 'branch' node type and branch-related edge types
export type GraphNodeType = 'issue' | 'session' | 'auth_request'
export type GraphEdgeType =
  | 'session_issue'
  | 'session_parent'
  | 'auth_issue'
  | 'umbrella_child'

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  status?: string
  labels?: string[]
  repo?: string
  branch?: string
  active?: boolean
  created_at?: string
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: GraphEdgeType
}

// Internal simulation types — exported so GraphCanvas.tsx can reference them
export interface SimGraphNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  fx?: number | null
  fy?: number | null
}

export interface SimGraphEdge {
  id: string
  type: GraphEdgeType
  source: string | SimGraphNode
  target: string | SimGraphNode
}
