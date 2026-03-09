# D3 SVG Graph Renderer — Implementation Plan (P2)

Issue: 5733427
Partition: D3 SVG graph renderer
Worktree: `feature__graphview__renderer`

---

## 0. Dependency: d3

d3 is not in `package.json`. It must be added before anything builds.

```
npm install d3
npm install --save-dev @types/d3
```

Use **d3 v7** (current stable). Import pattern in this codebase: named submodule imports to keep the bundle tight. esbuild bundles `node_modules` automatically, so no separate config is needed.

```typescript
import {
  forceSimulation, forceManyBody, forceCenter, forceLink, forceCollide,
  type Simulation, type SimulationNodeDatum, type SimulationLinkDatum,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
```

However, `d3` itself re-exports all submodules as a single package. Since esbuild tree-shakes, it is acceptable to use `import * as d3 from 'd3'` (the GoGCanvas reference uses this approach). The plan below uses that style for clarity. Either is fine; the implementer should pick one and be consistent.

---

## 1. File List and Contents

### `ui/src/types/graph.ts` (NEW — ~35 lines)

Shared graph type definitions. Defining them here (not in `graph.tsx`) makes them importable by GraphCanvas without circular deps.

```typescript
export type GraphNodeType = 'issue' | 'session' | 'auth_request' | 'branch'
export type GraphEdgeType =
  | 'session_issue'
  | 'session_parent'
  | 'auth_branch'
  | 'auth_issue'
  | 'branch_issue'
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
```

---

### `ui/src/api.ts` (EDIT — add ~15 lines)

Add `getGraph` to the existing api module:

```typescript
export async function getGraph(params?: {
  repo?: string
  since?: string   // e.g. '1d', '3d', '7d'
  status?: string  // 'open' | 'all'
}): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const query = buildQuery({ repo: params?.repo, since: params?.since, status: params?.status });
  const response = await apiGet(`/api/graph${query}`);
  const payload = await parseMaybeJson(response);
  return payload as { nodes: GraphNode[]; edges: GraphEdge[] };
}
```

Import `GraphNode` / `GraphEdge` from `'./types/graph'`. The `/api/graph` endpoint is implemented by P1; if P1 is not merged, calls will 404 gracefully (the view handles the error).

---

### `ui/src/components/graph/GraphCanvas.tsx` (NEW — ~280 lines)

The D3 SVG canvas. Pure rendering component; owns simulation lifecycle.

#### Props

```typescript
interface GraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
}
```

#### Internal state

```typescript
const containerRef = useRef<HTMLDivElement>(null)
const svgRef = useRef<SVGSVGElement>(null)
const simRef = useRef<d3.Simulation<SimGraphNode, SimGraphEdge> | null>(null)
const nodesRef = useRef<SimGraphNode[]>([])
const edgesRef = useRef<SimGraphEdge[]>([])
const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity)
const [tick, setTick] = useState(0)             // triggers re-render on sim tick
const [tooltip, setTooltip] = useState<{
  node: GraphNode
  x: number
  y: number
} | null>(null)
const [bounds, setBounds] = useState({ width: 800, height: 600 })
```

#### ResizeObserver

```typescript
useEffect(() => {
  if (!containerRef.current) return;
  const ro = new ResizeObserver(entries => {
    const e = entries[0];
    if (e) setBounds({ width: e.contentRect.width, height: e.contentRect.height });
  });
  ro.observe(containerRef.current);
  return () => ro.disconnect();
}, []);
```

#### D3 simulation setup (one effect, deps: [nodes, edges, bounds])

On each prop change, preserve existing node positions (merge by id) and restart:

```
Charge force:   forceManyBody().strength(-250)
Center force:   forceCenter(bounds.width/2, bounds.height/2).strength(0.08)
Link force:     forceLink(edges).id(d => d.id).distance(linkDistance).strength(linkStrength)
Collision:      forceCollide().radius(nodeRadius + 6)
alphaDecay:     0.025  (slow enough to feel alive)
```

Link distance per edge type:
- `session_issue`: 80
- `umbrella_child`: 60
- others: 120

Link strength:
- `session_issue` where `active=true` on either node: 0.8 (active sessions pulled toward issues)
- `umbrella_child`: 0.7
- others: 0.4

Active sessions get an extra radial force pushing them toward their linked issue nodes. This is implemented by adding a custom `forceX`/`forceY` that targets the centroid of the session's linked issues. Computed inside the tick callback using `nodesRef` and `edgesRef`. (Lightweight: O(n*e) per tick, acceptable for expected graph sizes < 500 nodes.)

Node merge logic (preserves layout between data refreshes):
```typescript
const existing = new Map(nodesRef.current.map(n => [n.id, n]));
const next: SimGraphNode[] = incoming.map(node => {
  const prev = existing.get(node.id);
  if (prev) return Object.assign(prev, node);  // update data, keep x/y/vx/vy
  return { ...node, x: bounds.width/2 + (Math.random()-0.5)*200, y: bounds.height/2 + (Math.random()-0.5)*200, vx: 0, vy: 0 };
});
nodesRef.current = next;
edgesRef.current = incomingEdges.map(e => ({ ...e, source: e.source, target: e.target }));

if (simRef.current) {
  simRef.current.nodes(nodesRef.current);
  (simRef.current.force('link') as d3.ForceLink<...>).links(edgesRef.current);
  simRef.current.alpha(0.4).restart();
} else {
  simRef.current = d3.forceSimulation(nodesRef.current)
    .force(...)
    .on('tick', () => setTick(t => t + 1));
}
```

Simulation cleanup: `return () => { simRef.current?.stop(); simRef.current = null; }` — but only on unmount (not on every prop change). The restart path above handles updates.

#### Zoom behavior (one effect, deps: [])

```typescript
useEffect(() => {
  if (!svgRef.current) return;
  const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 3])
    .on('zoom', event => {
      transformRef.current = event.transform;
      d3.select(svgRef.current).select('g.graph-viewport')
        .attr('transform', event.transform.toString());
    });
  d3.select(svgRef.current).call(zoomBehavior);
}, []);
```

#### SVG structure

```
<div ref={containerRef} className="graph-canvas">
  <svg ref={svgRef} width="100%" height="100%">
    <defs>
      <marker id="graph-arrow" ...>  <!-- arrowhead for directed edges -->
    </defs>
    <g className="graph-viewport">
      <!-- Edges (rendered before nodes so nodes sit on top) -->
      {edgesRef.current.map(edge => <EdgeLine key={edge.id} edge={edge} />)}
      <!-- Nodes -->
      {nodesRef.current.map(node => (
        <NodeShape key={node.id} node={node}
          onClick={...}
          onMouseEnter={...}
          onMouseLeave={...}
        />
      ))}
    </g>
  </svg>
  <!-- Tooltip rendered outside SVG as a positioned div -->
  {tooltip && <GraphTooltip node={tooltip.node} x={tooltip.x} y={tooltip.y} />}
</div>
```

The `data-tick={tick}` attribute on the `<svg>` causes Preact to reconcile when tick changes, recomputing node positions from `nodesRef.current`.

#### Node shape rendering (inline helper `NodeShape`)

Node dimensions:
- Session: circle, r=10
- Issue: circle, r=14 (slightly larger)
- Auth request: rotated square (diamond), 18x18 rotated 45°
- Branch: rect, 44x18, rx=3

Implemented as a `<g transform="translate(x,y)">` group containing the shape and a `<text>` label below (or inside for branches). The `transform` is the current simulation x,y position read from `nodesRef`.

Node colors (use CSS variables from style.css):

| Type | Condition | Color |
|------|-----------|-------|
| session | active=true | `var(--accent-green)` with `.graph-node--pulse` animation |
| session | ended | `rgba(154,164,178,0.5)` (text-muted half opacity) |
| auth_request | pending | `var(--accent-yellow)` |
| auth_request | approved/completed | `var(--accent-green)` |
| auth_request | failed/rejected | `var(--accent-red)` |
| issue | labels includes 'umbrella' | `#a855f7` (purple, not in CSS vars — add as `--accent-purple`) |
| issue | labels includes 'error' | `var(--accent-red)` |
| issue | labels includes 'feature' | `var(--accent-blue)` |
| issue | labels includes 'deferred' | `var(--text-muted)` |
| issue | no matching label | `rgba(255,255,255,0.85)` |
| branch | any | `var(--text-muted)` |

Selection: clicked nodes get a white stroke ring (2px). No multi-select needed for P2.

Label text: truncated at 20 chars with ellipsis. Font size 10px for session/branch, 11px for issue. Positioned below the shape using `dy="1.2em"` or explicit y offset.

Click handler:
```typescript
const handleClick = (node: SimGraphNode) => {
  // Derive args for onNavigate by node type
  if (node.type === 'issue') {
    onNavigate('issue', node.id, node.repo);
  } else if (node.type === 'session') {
    onNavigate('session', node.id);
  } else if (node.type === 'auth_request') {
    onNavigate('auth_request', node.id);
  } else if (node.type === 'branch') {
    onNavigate('branch', node.id, node.repo);
  }
};
```

Hover handler sets `tooltip` state with the node and the current mouse clientX/clientY.

#### Edge rendering (inline helper `EdgeLine`)

After simulation resolves, `edge.source` and `edge.target` are `SimGraphNode` objects (D3 mutates them). Cast carefully:
```typescript
const src = edge.source as SimGraphNode;
const tgt = edge.target as SimGraphNode;
if (!src?.x || !tgt?.x) return null;
```

Edge styling per type:
- `session_issue`: solid, `rgba(77,163,255,0.4)`, strokeWidth=1.5
- `umbrella_child`: dashed (`4 3`), `rgba(168,85,247,0.4)`, strokeWidth=1
- `auth_branch`, `auth_issue`: dotted (`2 4`), `rgba(245,194,92,0.4)`, strokeWidth=1
- `branch_issue`: solid, `rgba(154,164,178,0.3)`, strokeWidth=1
- `session_parent`: solid, `rgba(154,164,178,0.25)`, strokeWidth=1, dashed

Arrow marker (`url(#graph-arrow)`) on `session_issue` and `auth_branch` edges only.

Fat invisible hit area (transparent line, strokeWidth=10) overlaid for hover events (same pattern as GoGCanvas).

---

### `ui/src/components/graph/GraphTooltip.tsx` (NEW — ~60 lines)

Simple positioned overlay. Rendered into the parent `graph-canvas` div (which is `position: relative`).

```typescript
interface GraphTooltipProps {
  node: GraphNode
  x: number     // clientX from mouse event
  y: number     // clientY from mouse event
}
```

Implementation: a `<div className="graph-tooltip">` with `position: fixed; left: x+12; top: y-8` (offset slightly to avoid blocking the cursor). Content:

```
<div className="graph-tooltip__type">{node.type}</div>
<div className="graph-tooltip__label">{node.label}</div>
{node.status && <div className="graph-tooltip__row"><span>status</span> {node.status}</div>}
{node.branch && <div className="graph-tooltip__row"><span>branch</span> {node.branch}</div>}
{node.repo && <div className="graph-tooltip__row"><span>repo</span> {node.repo}</div>}
{node.labels?.length > 0 && <div className="graph-tooltip__row"><span>labels</span> {node.labels.join(', ')}</div>}
```

Tooltip is z-index 200, dark background `var(--bg-card)`, border `rgba(255,255,255,0.1)`, border-radius 10px, padding 10px 14px, font-size 12px, pointer-events none (non-blocking).

---

### `ui/src/components/graph/index.ts` (NEW — ~5 lines)

```typescript
export { GraphCanvas } from './GraphCanvas';
export { GraphTooltip } from './GraphTooltip';
export type { GraphCanvasProps } from './GraphCanvas';
```

---

### `ui/src/views/graph.tsx` (NEW — ~200 lines)

Full page view. Owns filter state and data fetching.

#### State

```typescript
const [nodes, setNodes] = useState<GraphNode[]>([])
const [edges, setEdges] = useState<GraphEdge[]>([])
const [loading, setLoading] = useState(true)
const [error, setError] = useState<string | null>(null)

// Filter state
const [repoFilter, setRepoFilter] = useState<string>('all')
const [sinceFilter, setSinceFilter] = useState<'1d' | '3d' | '7d' | 'all'>('3d')
const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open')
```

Derived: list of repos available for the dropdown, computed from node data:
```typescript
const repos = useMemo(() => {
  const seen = new Set<string>();
  nodes.forEach(n => n.repo && seen.add(n.repo));
  return ['all', ...Array.from(seen).sort()];
}, [nodes]);
```

Filtered nodes/edges: filter `nodes` by `repoFilter` and `statusFilter` (open = session status active/running OR issue status open). Then filter `edges` to only include those where both endpoints remain after node filtering.

```typescript
const visibleNodes = useMemo(() => {
  return nodes.filter(n => {
    if (repoFilter !== 'all' && n.repo !== repoFilter) return false;
    if (statusFilter === 'open') {
      if (n.type === 'session' && n.status !== 'running' && n.status !== 'active') return false;
      if (n.type === 'issue' && n.status !== 'open') return false;
      // auth_request and branch: always include regardless of status filter
    }
    return true;
  });
}, [nodes, repoFilter, statusFilter]);

const visibleNodeIds = useMemo(() => new Set(visibleNodes.map(n => n.id)), [visibleNodes]);

const visibleEdges = useMemo(() =>
  edges.filter(e => visibleNodeIds.has(typeof e.source === 'string' ? e.source : (e.source as GraphNode).id)
    && visibleNodeIds.has(typeof e.target === 'string' ? e.target : (e.target as GraphNode).id)),
  [edges, visibleNodeIds]);
```

#### Data fetch

```typescript
useEffect(() => {
  let active = true;
  setLoading(true);
  setError(null);
  getGraph({ since: sinceFilter === 'all' ? undefined : sinceFilter })
    .then(data => { if (active) { setNodes(data.nodes); setEdges(data.edges); } })
    .catch(err => { if (active) setError(err.message); })
    .finally(() => { if (active) setLoading(false); });
  return () => { active = false; };
}, [sinceFilter]); // repo/status filters are client-side only, no re-fetch needed
```

#### onNavigate handler

The view receives no routing props — navigation is done by updating `window.location.hash`:
```typescript
const handleNavigate = (type: GraphNodeType, id: string, repoId?: string) => {
  if (type === 'issue' && repoId) {
    window.location.hash = `#/issues?repo=${encodeURIComponent(repoId)}&issue=${encodeURIComponent(id)}`;
  } else if (type === 'session') {
    window.location.hash = `#/sessions?session=${encodeURIComponent(id)}`;
  } else if (type === 'auth_request') {
    window.location.hash = `#/auth`;
    // auth view doesn't currently support deep-link by id, so just navigate to auth tab
  } else if (type === 'branch') {
    window.location.hash = `#/work${repoId ? '?repo=' + encodeURIComponent(repoId) : ''}`;
  }
};
```

#### JSX structure

```
<div className="graph-view">
  <div className="view-header">
    <h2>Graph</h2>
    <div className="graph-toolbar">
      <!-- Repo dropdown -->
      <select className="graph-toolbar__select" value={repoFilter} onChange={...}>
        {repos.map(r => <option key={r} value={r}>{r}</option>)}
      </select>
      <!-- Recency toggle -->
      <div className="graph-toolbar__toggle-group">
        {(['1d','3d','7d','all'] as const).map(v => (
          <button key={v}
            className={`graph-toolbar__toggle${sinceFilter===v ? ' graph-toolbar__toggle--active' : ''}`}
            onClick={() => setSinceFilter(v)}
          >{v}</button>
        ))}
      </div>
      <!-- Status toggle -->
      <div className="graph-toolbar__toggle-group">
        {(['open','all'] as const).map(v => (
          <button key={v}
            className={`graph-toolbar__toggle${statusFilter===v ? ' graph-toolbar__toggle--active' : ''}`}
            onClick={() => setStatusFilter(v)}
          >{v === 'open' ? 'open only' : 'all'}</button>
        ))}
      </div>
    </div>
  </div>
  {loading && <div className="graph-loading">Loading graph…</div>}
  {error && <div className="graph-error">{error}</div>}
  {!loading && !error && (
    <div className="graph-canvas-wrap">
      <GraphCanvas nodes={visibleNodes} edges={visibleEdges} onNavigate={handleNavigate} />
    </div>
  )}
</div>
```

#### Export

```typescript
export { GraphView as default };
export type { GraphViewProps };
```

---

### `ui/src/style.css` (EDIT — add ~120 lines at end)

New CSS classes:

```css
/* ── Graph view ── */

--accent-purple: #a855f7;   /* added to :root */

.graph-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.graph-canvas-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid rgba(255,255,255,0.04);
}

.graph-canvas {
  width: 100%;
  height: 100%;
  position: relative;
  cursor: grab;
}

.graph-canvas:active {
  cursor: grabbing;
}

/* Toolbar */

.graph-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.graph-toolbar__select {
  background: var(--bg-secondary);
  border: 1px solid rgba(255,255,255,0.1);
  color: var(--text-primary);
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 13px;
  font-family: var(--font-sans);
  cursor: pointer;
}

.graph-toolbar__toggle-group {
  display: flex;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  overflow: hidden;
}

.graph-toolbar__toggle {
  background: transparent;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.1);
  color: var(--text-muted);
  padding: 6px 12px;
  font-size: 12px;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.graph-toolbar__toggle:first-child {
  border-left: none;
}

.graph-toolbar__toggle:hover {
  background: rgba(255,255,255,0.05);
  color: var(--text-primary);
}

.graph-toolbar__toggle--active {
  background: rgba(77,163,255,0.15);
  color: var(--accent-blue);
}

/* Loading/error states */

.graph-loading,
.graph-error {
  padding: 48px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
}

.graph-error {
  color: var(--accent-red);
}

/* Tooltip */

.graph-tooltip {
  position: fixed;
  z-index: 200;
  background: var(--bg-card);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12px;
  pointer-events: none;
  box-shadow: var(--shadow-soft);
  min-width: 140px;
  max-width: 240px;
}

.graph-tooltip__type {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.graph-tooltip__label {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  word-break: break-word;
}

.graph-tooltip__row {
  display: flex;
  gap: 8px;
  color: var(--text-muted);
  margin-top: 3px;
}

.graph-tooltip__row span {
  min-width: 48px;
  opacity: 0.7;
}

/* Active session pulse animation */
@keyframes graph-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.55; }
}

.graph-node--pulse {
  animation: graph-pulse 2s ease-in-out infinite;
}
```

Note: `--accent-purple` must be added inside the existing `:root { }` block, not as a standalone rule. The implementer should edit the `:root` block at the top of style.css.

---

### `ui/src/app.tsx` (EDIT — ~15 lines)

Add graph route. Changes:
1. Import `GraphView` from `'./views/graph'`
2. Add `'graph'` to the `Route['tab']` union type
3. Add `'graph'` to the `parseHashRoute` valid tabs array
4. Add `{route.tab === 'graph' && <GraphView />}` in the render
5. Add a nav link (suggest adding to the overflow menu alongside Work/Review/Logs, not the main tabs)

---

## 2. Data Update Handling

**On initial mount:** fetch once, set nodes/edges, simulation initializes from scratch.

**On filter change (repo/status):** no re-fetch; client-side filtering recomputes `visibleNodes`/`visibleEdges`. Props change → GraphCanvas receives new arrays → the simulation effect fires → `updateSimulationData()` merges new nodes by id (preserving positions for unchanged nodes), removes absent nodes, and calls `sim.alpha(0.4).restart()`. The graph settles naturally from its existing layout.

**On `sinceFilter` change:** triggers a re-fetch. New data arrives, setState triggers re-render, new props flow to GraphCanvas, same merge logic runs. New nodes appear near center; existing nodes retain positions.

**On SSE events (future consideration):** P2 does not wire up SSE. The parent (`GraphView`) can optionally add a `useEffect` that subscribes to `session:updated` / `session:registered` events and re-fetches. This is straightforward to add later since the component handles prop updates gracefully.

---

## 3. onNavigate Call Matrix

| Node type | `onNavigate` call | Result |
|-----------|-------------------|--------|
| `issue` | `('issue', node.id, node.repo)` | `#/issues?repo=…&issue=…` |
| `session` | `('session', node.id)` | `#/sessions?session=…` |
| `auth_request` | `('auth_request', node.id)` | `#/auth` |
| `branch` | `('branch', node.id, node.repo)` | `#/work?repo=…` |

---

## 4. D3 Import Pattern for Preact Compat

Preact compatibility has no issues with D3. D3 does not use React hooks or context — it manipulates the DOM through refs. The `jsxImportSource: 'preact'` in esbuild.config.js handles JSX; D3 itself is framework-agnostic.

Use `import * as d3 from 'd3'` (consistent with GoGCanvas blueprint). esbuild will tree-shake unused exports. If bundle size is a concern, switch to named imports from `d3-force`, `d3-selection`, `d3-zoom` subpackages — each is a separate npm package already installed as part of `d3`.

---

## 5. Estimated Lines of New Code

| File | Lines (est.) |
|------|-------------|
| `ui/src/types/graph.ts` | 35 |
| `ui/src/components/graph/GraphCanvas.tsx` | 280 |
| `ui/src/components/graph/GraphTooltip.tsx` | 60 |
| `ui/src/components/graph/index.ts` | 5 |
| `ui/src/views/graph.tsx` | 200 |
| `ui/src/style.css` additions | 120 |
| `ui/src/api.ts` additions | 15 |
| `ui/src/app.tsx` additions | 15 |
| **Total** | **~730** |

---

## 6. Implementation Order

1. Add `d3` to `package.json` and install
2. Create `ui/src/types/graph.ts`
3. Create `GraphTooltip.tsx` (no deps, simple)
4. Create `GraphCanvas.tsx` (depends on types)
5. Create `ui/src/components/graph/index.ts`
6. Add CSS to `style.css` (including `--accent-purple` in `:root`)
7. Add `getGraph` to `api.ts`
8. Create `ui/src/views/graph.tsx`
9. Wire into `app.tsx`
10. Build and verify (`npm run build:ui`)

---

## 7. Edge Cases and Notes

- **Empty graph:** GraphCanvas receives `nodes=[]`, `edges=[]`. The simulation runs with no nodes — harmless. Show a "no data" message in `GraphView` when `!loading && !error && visibleNodes.length === 0`.
- **Simulation on unmount:** `useEffect` cleanup must call `simRef.current?.stop()` to prevent tick callbacks on an unmounted component. Set `simRef.current = null` after stopping.
- **Diamond shape for auth_request:** Render as `<rect width="20" height="20" transform="rotate(45)" />` centered at origin. The `<g transform="translate(x,y)">` handles positioning.
- **Label truncation:** Truncate at 20 chars with `…` suffix. Full label is shown in tooltip. Branches may show `branch` field instead of `label` if shorter.
- **Type assertion on D3-resolved edges:** After simulation runs, `edge.source` and `edge.target` become `SimGraphNode` objects. TypeScript does not know this — cast with `as SimGraphNode` and guard for undefined before rendering.
- **Tooltip positioning:** `position: fixed` with `clientX`/`clientY` from the mouse event. Clamp to viewport to prevent overflow: check if `x + tooltipWidth > window.innerWidth` and flip to `x - tooltipWidth - 12` if so.
- **No `@types/d3` in devDeps yet:** Add `@types/d3` alongside `d3` in the install step. Without it, TypeScript will error on `d3.*` calls.
