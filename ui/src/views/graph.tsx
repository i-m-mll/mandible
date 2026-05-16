import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  GraphEdge,
  GraphLayerDescriptor,
  GraphMode,
  GraphModeDescriptor,
  GraphNode,
  GraphNodeType,
  GraphPayload,
} from '../types/graph';

type GraphFetchParams = {
  mode: GraphMode
  repo?: string
  branch?: string
  since?: string
  status?: string
}

type ReactFlowNode = {
  id: string
  type: string
  position: { x: number; y: number }
  data: { node: GraphNode }
}

type ReactFlowEdge = {
  id: string
  source: string
  target: string
  type?: string
  label?: string
  animated?: boolean
  markerEnd?: { type: typeof MarkerType.ArrowClosed }
  style?: Record<string, string | number>
  labelStyle?: Record<string, string | number>
  labelBgStyle?: Record<string, string | number>
}

async function getGraph(params: GraphFetchParams): Promise<GraphPayload> {
  const q = new URLSearchParams();
  q.set('mode', params.mode);
  if (params.since) q.set('since', params.since);
  if (params.repo) q.set('repo', params.repo);
  if (params.branch) q.set('branch', params.branch);
  if (params.status) q.set('status', params.status);
  const r = await fetch(`/api/graph?${q.toString()}`);
  if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
  return r.json() as Promise<GraphPayload>;
}

export type { GraphNodeType };

interface GraphViewProps {
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
  refreshToken?: number
  initialMode?: string
}

const NODE_COLUMNS: Record<string, number> = {
  repo: 0,
  provider: 0,
  issue: 1,
  provider_manifest: 1,
  provider_spec: 1,
  work_unit: 2,
  run: 2,
  session: 3,
  analysis: 3,
  model: 3,
  dataset: 3,
  auth_request: 4,
  artifact: 4,
  report: 5,
  commit: 5,
};

const FLOW_LANES = 2;
const FLOW_X_START = 24;
const FLOW_Y_START = 32;
const FLOW_COLUMN_GAP = 210;
const FLOW_ROW_GAP = 112;
const FLOW_GROUP_GAP = 48;

const MODE_LABELS: Record<GraphMode, string> = {
  activity: 'Activity',
  issue: 'Issues',
  work: 'Work',
  provenance: 'Provenance',
  'provider-lineage': 'Provider Lineage',
  'artifact-lineage': 'Artifact Lineage',
};

const GRAPH_MODES = new Set<GraphMode>(Object.keys(MODE_LABELS) as GraphMode[]);

function coerceGraphMode(value: string | undefined): GraphMode {
  return value && GRAPH_MODES.has(value as GraphMode) ? value as GraphMode : 'activity';
}

function typeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (s) => s.toUpperCase());
}

function compactId(id: string): string {
  const parts = id.split(':');
  return parts[parts.length - 1]?.slice(0, 12) || id.slice(0, 12);
}

function nodeColor(node: GraphNode): string {
  if (node.visual?.color) return node.visual.color;
  if (node.type === 'issue') {
    if (node.labels?.includes('error')) return 'var(--accent-red)';
    if (node.labels?.includes('feature')) return 'var(--accent-blue)';
    if (node.labels?.includes('umbrella')) return 'var(--accent-purple)';
    return 'rgba(230,237,243,0.86)';
  }
  if (node.type === 'session') {
    return node.active || node.status === 'active' ? 'var(--accent-green)' : 'rgba(154,164,178,0.64)';
  }
  if (node.type === 'auth_request') {
    if (node.status === 'pending' || node.status === 'executing') return 'var(--accent-yellow)';
    if (node.status === 'completed') return 'var(--accent-green)';
    if (node.status === 'failed' || node.status === 'rejected') return 'var(--accent-red)';
    return 'var(--accent-yellow)';
  }
  if (node.type === 'provider') return '#7dd3fc';
  if (node.type === 'provider_manifest') return '#c4b5fd';
  if (node.type === 'artifact') return '#f7c873';
  if (node.type === 'run' || node.type === 'analysis') return '#8be9b5';
  return 'rgba(230,237,243,0.76)';
}

function edgeColor(edge: GraphEdge): string {
  if (edge.edge_class === 'semantic') return 'rgba(168,85,247,0.62)';
  if (edge.edge_class === 'provider') return 'rgba(125,211,252,0.62)';
  if (edge.edge_class === 'provenance') return 'rgba(50,210,150,0.54)';
  if (edge.type.includes('auth')) return 'rgba(245,194,92,0.58)';
  if (edge.type.includes('session')) return 'rgba(77,163,255,0.5)';
  return 'rgba(154,164,178,0.46)';
}

function firstEntries(value: Record<string, unknown> | undefined, limit = 4): Array<[string, unknown]> {
  if (!value) return [];
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, limit);
}

function layoutNodes(nodes: GraphNode[], mode: GraphMode): ReactFlowNode[] {
  const grouped = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const column = NODE_COLUMNS[node.type] ?? (mode === 'issue' ? 1 : 2);
    const current = grouped.get(column) ?? [];
    current.push(node);
    grouped.set(column, current);
  }

  const sortedColumns = Array.from(grouped.keys()).sort((a, b) => a - b);
  const output: ReactFlowNode[] = [];
  const laneCount = Math.max(1, Math.min(FLOW_LANES, sortedColumns.length));
  const laneOffsets = Array.from({ length: laneCount }, () => FLOW_Y_START);
  for (const [columnIndex, column] of sortedColumns.entries()) {
    const lane = columnIndex % laneCount;
    const baseY = laneOffsets[lane] ?? FLOW_Y_START;
    const group = [...(grouped.get(column) ?? [])].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta || a.label.localeCompare(b.label);
    });
    group.forEach((node, row) => {
      output.push({
        id: node.id,
        type: 'mandible',
        position: {
          x: FLOW_X_START + lane * FLOW_COLUMN_GAP,
          y: baseY + row * FLOW_ROW_GAP,
        },
        data: { node },
      });
    });
    laneOffsets[lane] = baseY + Math.max(1, group.length) * FLOW_ROW_GAP + FLOW_GROUP_GAP;
  }
  return output;
}

function flowEdges(edges: GraphEdge[]): ReactFlowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    label: edge.type.replace(/_/g, ' '),
    animated: edge.edge_class === 'provenance' && edge.provenance === 'provider_manifest',
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: edgeColor(edge), strokeWidth: edge.edge_class === 'semantic' ? 1.4 : 1.8 },
    labelStyle: { fill: 'rgba(230,237,243,0.66)', fontSize: 10 },
    labelBgStyle: { fill: 'rgba(11,15,20,0.86)' },
  }));
}

function MandibleFlowNode({ data, selected }: { data: { node: GraphNode }; selected?: boolean }): JSX.Element {
  const node = data.node;
  const entries = firstEntries(node.metrics && Object.keys(node.metrics).length > 0 ? node.metrics : node.summary, 3);
  return (
    <div className={`graph-flow-node${selected ? ' graph-flow-node--selected' : ''}`} style={{ borderColor: nodeColor(node) }}>
      <div className="graph-flow-node__top">
        <span className="graph-flow-node__dot" style={{ background: nodeColor(node) }} />
        <span className="graph-flow-node__type">{typeLabel(node.type)}</span>
        {node.status && <span className="graph-flow-node__status">{node.status}</span>}
      </div>
      <div className="graph-flow-node__title">{node.label}</div>
      <div className="graph-flow-node__meta">
        {node.repo && <span>{node.repo}</span>}
        {node.branch && <span>{node.branch}</span>}
        {node.provider_id && <span>{node.provider_id}</span>}
        {!node.repo && !node.branch && !node.provider_id && <span>{compactId(node.id)}</span>}
      </div>
      {entries.length > 0 && (
        <div className="graph-flow-node__metrics">
          {entries.map(([key, value]) => (
            <span key={key}>{key}: {String(value)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

const NODE_TYPES = { mandible: MandibleFlowNode };

function ModeButton({
  mode,
  current,
  onSelect,
}: {
  mode: GraphModeDescriptor
  current: GraphMode
  onSelect: (mode: GraphMode) => void
}): JSX.Element {
  const disabled = !mode.available && mode.id !== current;
  return (
    <button
      type="button"
      className={`graph-mode-btn${mode.id === current ? ' graph-mode-btn--active' : ''}`}
      disabled={disabled}
      title={mode.description}
      onClick={() => onSelect(mode.id)}
    >
      <span>{mode.label}</span>
      <span className="graph-mode-btn__count">{mode.count}</span>
    </button>
  );
}

function DetailPane({
  node,
  edges,
  onNavigate,
}: {
  node: GraphNode | null
  edges: GraphEdge[]
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
}): JSX.Element {
  if (!node) {
    return (
      <aside className="graph-detail-pane">
        <div className="graph-detail-pane__empty">Select a node</div>
      </aside>
    );
  }
  const connected = edges.filter((edge) => edge.source === node.id || edge.target === node.id).slice(0, 8);
  const detailEntries = firstEntries(node.detail, 8);
  const summaryEntries = firstEntries(node.summary, 8);
  const canNavigate = node.type === 'issue' || node.type === 'session' || node.type === 'auth_request';
  return (
    <aside className="graph-detail-pane">
      <div className="graph-detail-pane__header">
        <div>
          <div className="graph-detail-pane__type">{typeLabel(node.type)}</div>
          <h3>{node.label}</h3>
        </div>
        {node.status && <span className="graph-detail-pane__status">{node.status}</span>}
      </div>

      <div className="graph-detail-pane__section">
        <div className="graph-detail-pane__section-title">Context</div>
        <div className="graph-detail-pane__kv">
          <span>ID</span><code>{node.id}</code>
          {node.repo && <><span>Repo</span><code>{node.repo}</code></>}
          {node.branch && <><span>Branch</span><code>{node.branch}</code></>}
          {node.provider_id && <><span>Provider</span><code>{node.provider_id}</code></>}
          {node.created_at && <><span>Created</span><code>{new Date(node.created_at).toLocaleString()}</code></>}
        </div>
      </div>

      {(summaryEntries.length > 0 || detailEntries.length > 0) && (
        <div className="graph-detail-pane__section">
          <div className="graph-detail-pane__section-title">Fields</div>
          <div className="graph-detail-pane__kv">
            {summaryEntries.map(([key, value]) => (
              <><span key={`${key}-k`}>{key}</span><code key={`${key}-v`}>{String(value)}</code></>
            ))}
            {detailEntries.map(([key, value]) => (
              <><span key={`${key}-k`}>{key}</span><code key={`${key}-v`}>{String(value)}</code></>
            ))}
          </div>
        </div>
      )}

      <div className="graph-detail-pane__section">
        <div className="graph-detail-pane__section-title">Actions</div>
        <div className="graph-detail-pane__actions">
          {canNavigate && (
            <button type="button" className="btn" onClick={() => onNavigate(node.type, node.id, node.repo_id ?? node.repo)}>
              Open
            </button>
          )}
          {(node.actions ?? []).map((action) => (
            <button
              key={action.id}
              type="button"
              className="btn"
              disabled={action.disabled || action.kind !== 'navigate'}
              onClick={() => action.kind === 'navigate' && onNavigate(node.type, action.target ?? node.id, node.repo_id ?? node.repo)}
              title={action.description}
            >
              {action.label}{action.requires_auth ? ' *' : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="graph-detail-pane__section">
        <div className="graph-detail-pane__section-title">Connected</div>
        <div className="graph-detail-pane__edges">
          {connected.length === 0 && <span className="text-muted">No visible edges</span>}
          {connected.map((edge) => (
            <div key={edge.id} className="graph-detail-pane__edge">
              <span>{edge.type.replace(/_/g, ' ')}</span>
              <code>{edge.source === node.id ? edge.target : edge.source}</code>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

export function GraphView({ onNavigate, refreshToken, initialMode }: GraphViewProps): JSX.Element {
  const routeMode = coerceGraphMode(initialMode);
  const [payload, setPayload] = useState<GraphPayload>({ nodes: [], edges: [], mode: 'activity' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<GraphMode>(routeMode);
  const [sinceFilter, setSinceFilter] = useState<'1d' | '3d' | '7d' | 'all'>('3d');
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');
  const [repoInput, setRepoInput] = useState('');
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState('');
  const [branchFilter, setBranchFilter] = useState<string | null>(null);
  const [enabledLayers, setEnabledLayers] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    setMode(routeMode);
  }, [routeMode]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getGraph({
      mode,
      since: sinceFilter === 'all' ? undefined : sinceFilter,
      status: statusFilter === 'all' ? 'all' : undefined,
      repo: repoFilter ?? undefined,
      branch: branchFilter ?? undefined,
    })
      .then((data) => {
        if (!active) return;
        setPayload(data);
        setEnabledLayers(new Set((data.layers ?? []).map((layer) => layer.id)));
        if (data.nodes.length > 0 && !data.nodes.some((node) => node.id === selectedNodeId)) {
          setSelectedNodeId(data.nodes[0].id);
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, sinceFilter, statusFilter, repoFilter, branchFilter, refreshToken]);

  const modes = payload.modes ?? Object.entries(MODE_LABELS).map(([id, label]) => ({
    id: id as GraphMode,
    label,
    description: label,
    count: id === mode ? payload.nodes.length : 0,
    available: id === mode,
  }));

  const layers = payload.layers ?? [];
  const repos = useMemo(() => {
    const seen = new Set<string>();
    payload.nodes.forEach((node) => (node.repo || node.repo_id) && seen.add(node.repo || node.repo_id || ''));
    return Array.from(seen).filter(Boolean).sort();
  }, [payload.nodes]);

  const branchesForRepo = useMemo(() => {
    if (!repoFilter) return [];
    const seen = new Set<string>();
    payload.nodes.forEach((node) => {
      if ((node.repo === repoFilter || node.repo_id === repoFilter) && node.branch) seen.add(node.branch);
    });
    return Array.from(seen).sort();
  }, [payload.nodes, repoFilter]);

  const visibleNodes = useMemo(() => {
    if (enabledLayers.size === 0) return payload.nodes;
    return payload.nodes.filter((node) => enabledLayers.has(node.type));
  }, [payload.nodes, enabledLayers]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => payload.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [payload.edges, visibleNodeIds],
  );
  const flowNodes = useMemo(() => layoutNodes(visibleNodes, mode), [visibleNodes, mode]);
  const flowEdgeList = useMemo(() => flowEdges(visibleEdges), [visibleEdges]);
  const selectedNode = useMemo(
    () => visibleNodes.find((node) => node.id === selectedNodeId) ?? visibleNodes[0] ?? null,
    [visibleNodes, selectedNodeId],
  );

  const toggleLayer = (layer: GraphLayerDescriptor) => {
    setEnabledLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer.id)) next.delete(layer.id);
      else next.add(layer.id);
      return next;
    });
  };

  return (
    <div className="graph-view">
      <div className="graph-topbar">
        <div className="graph-mode-strip" aria-label="Graph modes">
          {modes.map((item) => (
            <ModeButton key={item.id} mode={item} current={mode} onSelect={setMode} />
          ))}
        </div>
        <div className="graph-toolbar">
          <div className="graph-toolbar__combobox-group">
            <div className="graph-toolbar__combobox">
              <input
                type="text"
                className="graph-toolbar__combobox-input"
                placeholder="All repos"
                value={repoInput}
                list="graph-repo-list"
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setRepoInput(val);
                  if (repos.includes(val)) {
                    setRepoFilter(val);
                    setBranchInput('');
                    setBranchFilter(null);
                  } else if (val === '') {
                    setRepoFilter(null);
                    setBranchInput('');
                    setBranchFilter(null);
                  }
                }}
              />
              {repoInput && (
                <button type="button" className="graph-toolbar__combobox-clear" onClick={() => {
                  setRepoInput('');
                  setRepoFilter(null);
                  setBranchInput('');
                  setBranchFilter(null);
                }}>x</button>
              )}
              <datalist id="graph-repo-list">
                {repos.map((repo) => <option key={repo} value={repo} />)}
              </datalist>
            </div>
            <div className={`graph-toolbar__combobox${!repoFilter ? ' graph-toolbar__combobox--disabled' : ''}`}>
              <input
                type="text"
                className="graph-toolbar__combobox-input"
                placeholder="All branches"
                value={branchInput}
                disabled={!repoFilter}
                list="graph-branch-list"
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setBranchInput(val);
                  if (branchesForRepo.includes(val)) setBranchFilter(val);
                  else if (val === '') setBranchFilter(null);
                }}
              />
              <datalist id="graph-branch-list">
                {branchesForRepo.map((branch) => <option key={branch} value={branch} />)}
              </datalist>
            </div>
          </div>
          <div className="graph-toolbar__toggle-group">
            {(['1d', '3d', '7d', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`graph-toolbar__toggle${sinceFilter === value ? ' graph-toolbar__toggle--active' : ''}`}
                onClick={() => setSinceFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="graph-toolbar__toggle-group">
            {(['open', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`graph-toolbar__toggle${statusFilter === value ? ' graph-toolbar__toggle--active' : ''}`}
                onClick={() => setStatusFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="graph-workspace">
        <div className="graph-layer-rail">
          <div className="graph-layer-rail__title">Layers</div>
          {layers.length === 0 && <div className="graph-layer-rail__empty">No layers</div>}
          {layers.map((layer) => (
            <label key={layer.id} className="graph-layer-chip">
              <input
                type="checkbox"
                checked={enabledLayers.has(layer.id)}
                onChange={() => toggleLayer(layer)}
              />
              <span>{typeLabel(layer.id)}</span>
              <em>{layer.count}</em>
            </label>
          ))}
        </div>

        <div className="graph-canvas-wrap">
          {loading && <div className="graph-loading">Loading graph...</div>}
          {error && <div className="graph-error">{error}</div>}
          {!loading && !error && flowNodes.length === 0 && (
            <div className="graph-empty">
              <h3>No graph data</h3>
              <p>{MODE_LABELS[mode]} has no visible nodes yet.</p>
            </div>
          )}
          {!loading && !error && flowNodes.length > 0 && (
            <ReactFlow
              key={`${mode}:${flowNodes.length}:${flowEdgeList.length}`}
              nodes={flowNodes}
              edges={flowEdgeList}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.16 }}
              minZoom={0.2}
              maxZoom={1.8}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              onNodeDoubleClick={(_event, node) => {
                const graphNode = visibleNodes.find((item) => item.id === node.id);
                if (graphNode && (graphNode.type === 'issue' || graphNode.type === 'session' || graphNode.type === 'auth_request')) {
                  onNavigate(graphNode.type, graphNode.id, graphNode.repo_id ?? graphNode.repo);
                }
              }}
            >
              <Background color="rgba(154,164,178,0.12)" gap={18} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => nodeColor((node.data as { node: GraphNode }).node)}
                maskColor="rgba(11,15,20,0.64)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        <DetailPane node={selectedNode} edges={visibleEdges} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export default GraphView;
