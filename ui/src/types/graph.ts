// Bug: 5733427 — GraphView bigbuild P2: shared graph type definitions
// Bug: 50c4afb — typed graph workspace contract for provider/artifact lineage
export type GraphMode =
  | 'activity'
  | 'issue'
  | 'work'
  | 'provenance'
  | 'provider-lineage'
  | 'artifact-lineage'

export type GraphNodeType =
  | 'repo'
  | 'issue'
  | 'work_unit'
  | 'session'
  | 'conversation'
  | 'auth_request'
  | 'branch'
  | 'commit'
  | 'preset'
  | 'provider'
  | 'provider_spec'
  | 'provider_manifest'
  | 'run'
  | 'model'
  | 'dataset'
  | 'analysis'
  | 'artifact'
  | 'report'
  | 'curated_topic'
  | (string & {})

export type GraphEdgeType =
  | 'session_issue'
  | 'session_parent'
  | 'auth_issue'
  | 'umbrella_child'
  | 'repo_contains_issue'
  | 'issue_has_work_unit'
  | 'work_unit_uses_branch'
  | 'auth_request_references_issue'
  | 'provider_emitted_manifest'
  | 'manifest_declares'
  | 'manifest_references_artifact'
  | 'produced'
  | 'derived_from'
  | 'validated_by'
  | 'requested_by'
  | 'approved_by'
  | 'blocks'
  | 'implements'
  | 'parent'
  | 'curated_related'
  | (string & {})

export type GraphEdgeClass = 'provenance' | 'lifecycle' | 'semantic' | 'provider' | (string & {})
export type GraphActionKind = 'navigate' | 'preview' | 'validate' | 'ingest' | 'compute' | 'auth_request' | (string & {})

export interface GraphAction {
  id: string
  label: string
  kind: GraphActionKind
  target?: string
  requires_auth?: boolean
  disabled?: boolean
  description?: string
}

export interface GraphVisualHint {
  color?: string
  icon?: string
  shape?: string
  size?: number
}

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  status?: string
  labels?: string[]
  repo?: string
  repo_id?: string
  branch?: string
  provider_id?: string
  active?: boolean
  created_at?: string
  updated_at?: string
  summary?: Record<string, unknown>
  detail?: Record<string, unknown>
  metrics?: Record<string, number | string | boolean>
  visual?: GraphVisualHint
  actions?: GraphAction[]
  source?: string
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: GraphEdgeType
  edge_class?: GraphEdgeClass
  provenance?: string
  confidence?: string
  metadata?: Record<string, unknown>
}

export interface GraphModeDescriptor {
  id: GraphMode
  label: string
  description: string
  count: number
  available: boolean
}

export interface GraphLayerDescriptor {
  id: string
  label: string
  count: number
  enabled: boolean
}

export interface GraphPayload {
  version?: 1
  mode?: GraphMode
  nodes: GraphNode[]
  edges: GraphEdge[]
  modes?: GraphModeDescriptor[]
  layers?: GraphLayerDescriptor[]
  truncated?: boolean
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
