import { useEffect, useMemo, useState } from 'preact/hooks';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import type { GraphEdge, GraphNode, GraphNodeType } from '../types/graph';

// Bug: 5733427 — GraphView bigbuild P2
// Inline fetch function — P3 will wire this to api.ts on merge
async function getGraph(params?: { repo?: string; since?: string; status?: string }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const q = new URLSearchParams();
  if (params?.since) q.set('since', params.since);
  if (params?.repo) q.set('repo', params.repo);
  if (params?.status) q.set('status', params.status);
  const qs = q.toString();
  const r = await fetch(`/api/graph${qs ? '?' + qs : ''}`);
  if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
  return r.json() as Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
}

export type { GraphNodeType };

interface GraphViewProps {
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
  refreshToken?: number
}

export function GraphView({ onNavigate, refreshToken }: GraphViewProps): JSX.Element {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [sinceFilter, setSinceFilter] = useState<'1d' | '3d' | '7d' | 'all'>('3d');
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');

  // Derived repo list from data
  const repos = useMemo(() => {
    const seen = new Set<string>();
    nodes.forEach((n) => n.repo && seen.add(n.repo));
    return ['all', ...Array.from(seen).sort()];
  }, [nodes]);

  // Client-side filtered nodes
  const visibleNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (repoFilter !== 'all' && n.repo !== repoFilter) return false;
      if (statusFilter === 'open') {
        if (n.type === 'session' && n.status !== 'running' && n.status !== 'active') return false;
        if (n.type === 'issue' && n.status !== 'open') return false;
        // auth_request and branch: always include regardless of status filter
      }
      return true;
    });
  }, [nodes, repoFilter, statusFilter]);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleEdges = useMemo(
    () =>
      edges.filter((e) => {
        const srcId = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id;
        const tgtId = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id;
        return visibleNodeIds.has(srcId) && visibleNodeIds.has(tgtId);
      }),
    [edges, visibleNodeIds],
  );

  // Data fetch — re-runs on sinceFilter or refreshToken change
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getGraph({ since: sinceFilter === 'all' ? undefined : sinceFilter })
      .then((data) => {
        if (active) {
          setNodes(data.nodes);
          setEdges(data.edges);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sinceFilter, refreshToken]);

  return (
    <div className="graph-view">
      <div className="view-header">
        <h2>Graph</h2>
        <div className="graph-toolbar">
          <select
            className="graph-toolbar__select"
            value={repoFilter}
            onChange={(e) => setRepoFilter((e.target as HTMLSelectElement).value)}
          >
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <div className="graph-toolbar__toggle-group">
            {(['1d', '3d', '7d', 'all'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`graph-toolbar__toggle${sinceFilter === v ? ' graph-toolbar__toggle--active' : ''}`}
                onClick={() => setSinceFilter(v)}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="graph-toolbar__toggle-group">
            {(['open', 'all'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`graph-toolbar__toggle${statusFilter === v ? ' graph-toolbar__toggle--active' : ''}`}
                onClick={() => setStatusFilter(v)}
              >
                {v === 'open' ? 'open only' : 'all'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <div className="graph-loading">Loading graph…</div>}
      {error && <div className="graph-error">{error}</div>}
      {!loading && !error && visibleNodes.length === 0 && (
        <div className="graph-loading">No graph data for this time range.</div>
      )}
      {!loading && !error && visibleNodes.length > 0 && (
        <div className="graph-canvas-wrap">
          <GraphCanvas nodes={visibleNodes} edges={visibleEdges} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}

export default GraphView;
