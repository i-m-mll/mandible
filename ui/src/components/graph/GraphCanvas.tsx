import * as d3 from 'd3';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GraphEdge, GraphNode, GraphNodeType, SimGraphEdge, SimGraphNode } from '../../types/graph';
import { GraphTooltip } from './GraphTooltip';

export interface GraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
}

const NODE_RADIUS_SESSION = 10;
const NODE_RADIUS_ISSUE = 14;

function truncate(s: string, max = 20): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function getNodeColor(node: GraphNode): string {
  switch (node.type) {
    case 'session':
      if (node.active || node.status === 'running' || node.status === 'active') {
        return 'var(--accent-green)';
      }
      return 'rgba(154,164,178,0.5)';
    case 'auth_request':
      if (node.status === 'pending') return 'var(--accent-yellow)';
      if (node.status === 'approved' || node.status === 'completed') return 'var(--accent-green)';
      if (node.status === 'failed' || node.status === 'rejected') return 'var(--accent-red)';
      return 'var(--accent-yellow)';
    case 'issue':
      if (node.labels?.includes('umbrella')) return 'var(--accent-purple)';
      if (node.labels?.includes('error')) return 'var(--accent-red)';
      if (node.labels?.includes('feature')) return 'var(--accent-blue)';
      if (node.labels?.includes('deferred')) return 'var(--text-muted)';
      return 'rgba(255,255,255,0.85)';
    default:
      return 'rgba(255,255,255,0.5)';
  }
}

function getLinkDistance(type: string): number {
  if (type === 'session_issue') return 80;
  if (type === 'umbrella_child') return 60;
  return 120;
}

function getLinkStrength(edge: GraphEdge, nodes: GraphNode[]): number {
  if (edge.type === 'umbrella_child') return 0.7;
  if (edge.type === 'session_issue') {
    const src = nodes.find(n => n.id === edge.source);
    const tgt = nodes.find(n => n.id === edge.target);
    if (src?.active || tgt?.active) return 0.8;
  }
  return 0.4;
}

interface NodeShapeProps {
  node: SimGraphNode
  selected: boolean
  onClick: (node: SimGraphNode) => void
  onMouseEnter: (node: SimGraphNode, e: MouseEvent) => void
  onMouseLeave: () => void
}

function NodeShape({ node, selected, onClick, onMouseEnter, onMouseLeave }: NodeShapeProps): JSX.Element | null {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return null;

  const color = getNodeColor(node);
  const isActiveSession = node.type === 'session' && (node.active || node.status === 'running' || node.status === 'active');
  const labelText = truncate(node.label);

  const strokeProps = selected
    ? { stroke: 'white', strokeWidth: 2 }
    : { stroke: 'rgba(255,255,255,0.15)', strokeWidth: 1 };

  let shape: JSX.Element;
  let labelY: number;

  if (node.type === 'session') {
    shape = (
      <circle
        r={NODE_RADIUS_SESSION}
        fill={color}
        className={isActiveSession ? 'graph-node--pulse' : undefined}
        {...strokeProps}
      />
    );
    labelY = NODE_RADIUS_SESSION + 12;
  } else if (node.type === 'issue') {
    shape = (
      <circle
        r={NODE_RADIUS_ISSUE}
        fill={color}
        {...strokeProps}
      />
    );
    labelY = NODE_RADIUS_ISSUE + 12;
  } else if (node.type === 'auth_request') {
    // Diamond: rect rotated 45deg
    shape = (
      <rect
        x={-10}
        y={-10}
        width={20}
        height={20}
        transform="rotate(45)"
        fill={color}
        {...strokeProps}
      />
    );
    labelY = 18;
  } else {
    // Fallback: small circle
    shape = (
      <circle
        r={8}
        fill={color}
        {...strokeProps}
      />
    );
    labelY = 20;
  }

  const fontSize = node.type === 'issue' ? 11 : 10;

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      style={{ cursor: 'pointer' }}
      onClick={() => onClick(node)}
      onMouseEnter={(e: MouseEvent) => onMouseEnter(node, e)}
      onMouseLeave={() => onMouseLeave()}
    >
      {shape}
      <text
        textAnchor="middle"
        y={labelY}
        fontSize={fontSize}
        fill="rgba(230,237,243,0.75)"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {labelText}
      </text>
    </g>
  );
}

interface EdgeLineProps {
  edge: SimGraphEdge
}

function EdgeLine({ edge }: EdgeLineProps): JSX.Element | null {
  const src = edge.source as SimGraphNode;
  const tgt = edge.target as SimGraphNode;
  if (!Number.isFinite(src?.x) || !Number.isFinite(tgt?.x)) return null;

  let stroke: string;
  let strokeWidth: number;
  let strokeDasharray: string | undefined;
  let markerEnd: string | undefined;

  switch (edge.type) {
    case 'session_issue':
      stroke = 'rgba(77,163,255,0.4)';
      strokeWidth = 1.5;
      markerEnd = 'url(#graph-arrow)';
      break;
    case 'umbrella_child':
      stroke = 'rgba(168,85,247,0.4)';
      strokeWidth = 1;
      strokeDasharray = '4 3';
      break;
    case 'auth_issue':
      stroke = 'rgba(245,194,92,0.4)';
      strokeWidth = 1;
      strokeDasharray = '2 4';
      break;
    case 'session_parent':
      stroke = 'rgba(154,164,178,0.25)';
      strokeWidth = 1;
      strokeDasharray = '3 3';
      break;
    default:
      stroke = 'rgba(154,164,178,0.2)';
      strokeWidth = 1;
  }

  return (
    <g>
      <line
        x1={src.x}
        y1={src.y}
        x2={tgt.x}
        y2={tgt.y}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        markerEnd={markerEnd}
      />
      {/* Fat invisible hit area */}
      <line
        x1={src.x}
        y1={src.y}
        x2={tgt.x}
        y2={tgt.y}
        stroke="transparent"
        strokeWidth={10}
      />
    </g>
  );
}

export function GraphCanvas({ nodes, edges, onNavigate }: GraphCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimGraphNode, SimGraphEdge> | null>(null);
  const nodesRef = useRef<SimGraphNode[]>([]);
  const edgesRef = useRef<SimGraphEdge[]>([]);
  // Store zoom behavior in a ref so it persists across rerenders and data refreshes.
  // This ensures the zoom transform is never reset when nodes/edges change — only on
  // first mount is the transform initialized to identity.
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [tick, setTick] = useState(0);
  const [tooltip, setTooltip] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const [bounds, setBounds] = useState({ width: 800, height: 600 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ResizeObserver
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setBounds({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // D3 simulation setup
  useEffect(() => {
    const incoming = nodes;
    const incomingEdges = edges;

    // Merge: preserve x/y/vx/vy for existing nodes
    const existing = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next: SimGraphNode[] = incoming.map((node) => {
      const prev = existing.get(node.id);
      if (prev) return Object.assign(prev, node);
      return {
        ...node,
        x: bounds.width / 2 + (Math.random() - 0.5) * 200,
        y: bounds.height / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
      };
    });
    nodesRef.current = next;
    edgesRef.current = incomingEdges.map((e) => ({
      ...e,
      source: e.source,
      target: e.target,
    }));

    if (simRef.current) {
      simRef.current.nodes(nodesRef.current);
      (simRef.current.force('link') as d3.ForceLink<SimGraphNode, SimGraphEdge>)
        .links(edgesRef.current);
      // Zero residual velocity on existing nodes — prevents charge force from
      // amplifying stale vx/vy over many simulation ticks. New nodes still settle
      // naturally into good positions. Bug: 98cc82a
      for (const node of nodesRef.current) {
        if (existing.has(node.id)) {
          node.vx = 0;
          node.vy = 0;
        }
      }
      // Conditional alpha: if new nodes arrived, give them energy to settle (0.1).
      // If it's a pure data update (no new nodes), use minimal alpha (0.01) so
      // existing layout is essentially frozen. Bug: 98cc82a
      const hasNewNodes = nodesRef.current.some((n) => !existing.has(n.id));
      simRef.current.alpha(hasNewNodes ? 0.1 : 0.01).restart();
    } else {
      const sim = d3
        .forceSimulation<SimGraphNode, SimGraphEdge>(nodesRef.current)
        .alphaDecay(0.025)
        .force('charge', d3.forceManyBody<SimGraphNode>().strength(-250))
        .force('center', d3.forceCenter<SimGraphNode>(bounds.width / 2, bounds.height / 2).strength(0.08))
        .force(
          'link',
          d3
            .forceLink<SimGraphNode, SimGraphEdge>(edgesRef.current)
            .id((d) => d.id)
            .distance((link) => getLinkDistance((link as SimGraphEdge).type))
            .strength((link) => getLinkStrength(link as GraphEdge, incoming)),
        )
        .force('collide', d3.forceCollide<SimGraphNode>().radius(NODE_RADIUS_ISSUE + 6))
        .on('tick', () => setTick((t) => t + 1));

      simRef.current = sim;
    }
  }, [nodes, edges, bounds]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      simRef.current?.stop();
      simRef.current = null;
    };
  }, []);

  // Zoom behavior — initialized once on mount. Storing in zoomRef ensures the
  // transform is never reset when nodes/edges change (data refreshes only
  // update simulation data; they never touch the zoom transform).
  useEffect(() => {
    if (!svgRef.current) return;
    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 3])
      .on('zoom', (event) => {
        d3.select(svgRef.current).select('g.graph-viewport').attr('transform', event.transform.toString());
      });
    zoomRef.current = zoomBehavior;
    d3.select(svgRef.current).call(zoomBehavior);
  }, []);

  const handleNodeClick = (node: SimGraphNode) => {
    setSelectedId(node.id);
    if (node.type === 'issue') {
      onNavigate('issue', node.id, node.repo);
    } else if (node.type === 'session') {
      onNavigate('session', node.id);
    } else if (node.type === 'auth_request') {
      onNavigate('auth_request', node.id);
    }
  };

  const handleNodeMouseEnter = (node: SimGraphNode, e: MouseEvent) => {
    setTooltip({ node, x: e.clientX, y: e.clientY });
  };

  const handleNodeMouseLeave = () => {
    setTooltip(null);
  };

  return (
    <div ref={containerRef} className="graph-canvas">
      <svg ref={svgRef} width="100%" height="100%" data-tick={tick}>
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 -5 10 10"
            refX="18"
            refY="0"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0,-5L10,0L0,5" fill="rgba(77,163,255,0.5)" />
          </marker>
        </defs>
        <g className="graph-viewport">
          {edgesRef.current.map((edge) => (
            <EdgeLine key={edge.id} edge={edge} />
          ))}
          {nodesRef.current.map((node) => (
            <NodeShape
              key={node.id}
              node={node}
              selected={selectedId === node.id}
              onClick={handleNodeClick}
              onMouseEnter={handleNodeMouseEnter}
              onMouseLeave={handleNodeMouseLeave}
            />
          ))}
        </g>
      </svg>
      {tooltip && <GraphTooltip node={tooltip.node} x={tooltip.x} y={tooltip.y} />}
    </div>
  );
}
