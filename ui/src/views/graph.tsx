import { useEffect, useMemo, useState } from 'preact/hooks';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import type { GraphEdge, GraphNode, GraphNodeType } from '../types/graph';

// Bug: 5733427 — GraphView bigbuild P2
// Bug: bdcc1f5 — combobox filter (repo+branch), remove branch nodes, fix issue visibility
// Inline fetch function — P3 will wire this to api.ts on merge
async function getGraph(params?: { repo?: string; branch?: string; since?: string; status?: string }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const q = new URLSearchParams();
  if (params?.since) q.set('since', params.since);
  if (params?.repo) q.set('repo', params.repo);
  if (params?.branch) q.set('branch', params.branch);
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

  const [sinceFilter, setSinceFilter] = useState<'1d' | '3d' | '7d' | 'all'>('3d');
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');

  // Repo combobox state
  const [repoInput, setRepoInput] = useState('');
  const [repoFilter, setRepoFilter] = useState<string | null>(null);

  // Branch combobox state
  const [branchInput, setBranchInput] = useState('');
  const [branchFilter, setBranchFilter] = useState<string | null>(null);

  // Derive repo list from loaded nodes
  const repos = useMemo(() => {
    const seen = new Set<string>();
    nodes.forEach((n) => n.repo && seen.add(n.repo));
    return Array.from(seen).sort();
  }, [nodes]);

  // Derive branch list for selected repo from loaded nodes
  const branchesForRepo = useMemo(() => {
    if (!repoFilter) return [];
    const seen = new Set<string>();
    nodes.forEach((n) => {
      if (n.repo === repoFilter && n.branch) seen.add(n.branch);
    });
    return Array.from(seen).sort();
  }, [nodes, repoFilter]);

  // Client-side filtered nodes (status filtering only — repo/branch is server-side)
  const visibleNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (statusFilter === 'open') {
        // Only show sessions that are not yet terminated (idle = between tool calls, still in progress)
        if (n.type === 'session' && (n.status === 'ended' || n.status === 'dead')) return false;
        if (n.type === 'issue' && n.status !== 'open') return false;
        // auth_request: always include regardless of status filter
      }
      return true;
    });
  }, [nodes, statusFilter]);

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

  // Data fetch — re-runs on filter changes or refreshToken change
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getGraph({
      since: sinceFilter === 'all' ? undefined : sinceFilter,
      status: statusFilter === 'all' ? 'all' : undefined,
      repo: repoFilter ?? undefined,
      branch: branchFilter ?? undefined,
    })
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
  }, [sinceFilter, statusFilter, repoFilter, branchFilter, refreshToken]);

  return (
    <div className="graph-view">
      <div className="view-header">
        <h2>Graph</h2>
        <div className="graph-toolbar">
          {/* Repo + Branch comboboxes */}
          <div className="graph-toolbar__combobox-group">
            {/* Repo combobox */}
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
                    // Reset branch when repo changes
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
                <button
                  type="button"
                  className="graph-toolbar__combobox-clear"
                  onClick={() => {
                    setRepoInput('');
                    setRepoFilter(null);
                    setBranchInput('');
                    setBranchFilter(null);
                  }}
                >
                  ×
                </button>
              )}
              <datalist id="graph-repo-list">
                {repos.map((r) => <option key={r} value={r} />)}
              </datalist>
            </div>

            {/* Branch combobox — disabled until repo selected */}
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
                  if (branchesForRepo.includes(val)) {
                    setBranchFilter(val);
                  } else if (val === '') {
                    setBranchFilter(null);
                  }
                }}
              />
              {branchInput && (
                <button
                  type="button"
                  className="graph-toolbar__combobox-clear"
                  onClick={() => {
                    setBranchInput('');
                    setBranchFilter(null);
                  }}
                >
                  ×
                </button>
              )}
              <datalist id="graph-branch-list">
                {branchesForRepo.map((b) => <option key={b} value={b} />)}
              </datalist>
            </div>
          </div>

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
