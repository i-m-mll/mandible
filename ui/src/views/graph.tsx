import { Icon } from '../components/icons/Icon';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  GraphEdge,
  GraphLegendItem as GraphPayloadLegendItem,
  GraphMode,
  GraphModeDescriptor,
  GraphNode,
  GraphNodeType,
  GraphPayload,
} from '../types/graph';
import { graphEdgeStyle } from '../graph/edgeStyles';
import { layoutGraph, type RoutedGraphEdge } from '../graph/layout';
import {
  addLedgerIssueComment,
  getGraph,
} from '../api';
import { LedgerIssueDetail } from '../components/ledger/IssueDetail';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { AddToSpace, type AddToSpaceTarget } from '../components/spaces/AddToSpace';
import { appColors } from '../theme';
import { ViewSidebar } from '../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { AppOperationalNoticeOutlet, useRegisterAppRightSidebar, useRouteLoad } from '../app-shell';
import { useAppRightSidebarState } from '../right-sidebar-state';
import { useQuery } from '@tanstack/preact-query';
import { queryClient } from '../query/client';
import { issueDetailOptions, queryErrorMessage, detailQueryData } from '../query/details';
import { useViewActive } from '../app-shell';
import { beginDetailRequest, detailRequestKey, readPersistedDetail, writePersistedDetail } from '../detail-cache';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneShell, type DetailPanePresentation } from '../components/shared/DetailPaneShell';
import { parseRouteFromHash, replaceRouteHash, routeHashWithParams, shortRouteId } from '../routing';

type ReactFlowNode = {
  id: string
  type: string
  position: { x: number; y: number }
  initialWidth?: number
  initialHeight?: number
  data: { node: GraphNode; label: JSX.Element }
  selected?: boolean
}

type GraphAnnotation = {
  id: string
  type: string
  label: string
  status?: string
  target?: string
  link_type?: string
}

type GraphSpecState = {
  preset: GraphMode
  since: '1d' | '3d' | '7d' | 'all'
  status: 'open' | 'all'
  limit: number
  repos: string[]
  branches: string[]
  nodeTypes?: string[]
  edgeTypes?: string[]
}

type GraphLegendKind = 'node' | 'edge'

type GraphLegendItem = {
  id: string
  kind: GraphLegendKind
  label: string
  description: string
  count: number
  enabled: boolean
  visible: boolean
  color: string
  dash?: string
  width?: number
}

const NODE_LEGEND_FALLBACKS: Record<string, { label: string; description: string }> = {
  issue: {
    label: 'Issues',
    description: 'Issues in the current lens. The Issues lens starts here, so other node families stay hidden unless another lens or filter includes them.',
  },
  auth_request: {
    label: 'Approval requests',
    description: 'Merge approval requests and their current review state.',
  },
  session: {
    label: 'Sessions',
    description: 'Agent sessions connected to issues, work units, or auth activity.',
  },
  work_unit: {
    label: 'Work units',
    description: 'Tracked implementation units linked to issues and sessions.',
  },
};

const EDGE_LEGEND_FALLBACKS: Record<string, { label: string; description: string }> = {
  umbrella_child: {
    label: 'Umbrella children',
    description: 'Structural issue hierarchy: an umbrella issue owns or organizes child issues.',
  },
  parent_child: {
    label: 'Parent-child',
    description: 'Canonical parent-to-child issue relationship from the ledger.',
  },
  parent: {
    label: 'Parent links',
    description: 'Legacy or imported parent relationship; shown separately until it is normalized into parent-child edges.',
  },
  blocks: {
    label: 'Blocks',
    description: 'Planning dependency: one issue blocks another.',
  },
  implements: {
    label: 'Implements',
    description: 'Implementation link between a work item and the issue or plan it realizes.',
  },
  references: {
    label: 'References',
    description: 'Lightweight cross-reference between issues; useful context, not hierarchy.',
  },
  related: {
    label: 'Related',
    description: 'Non-structural relationship between issues.',
  },
  curated_related: {
    label: 'Curated related',
    description: 'Manually curated non-structural relationship between issues.',
  },
  auth_issue: {
    label: 'Approval evidence',
    description: 'Approval requests attached to the issues they reference.',
  },
  auth_request_references_issue: {
    label: 'Approval references',
    description: 'Operational auth request references to issues.',
  },
  session_issue: {
    label: 'Session evidence',
    description: 'Agent sessions attached to the issues they worked on or discussed.',
  },
};

function isGenericLegendDescription(
  item: GraphPayloadLegendItem,
  kind: GraphLegendKind,
  description: string,
): boolean {
  const normalizedDescription = description.toLowerCase();
  const normalizedLabel = item.label.toLowerCase();
  const normalizedType = item.id.replace(/_/g, ' ').toLowerCase();
  const noun = kind === 'node' ? 'nodes' : 'edges';
  return normalizedDescription === normalizedLabel
    || normalizedDescription === `${normalizedLabel} ${noun}`
    || normalizedDescription === `${normalizedType} ${noun}`;
}

function applyLegendFallbackCopy(
  item: GraphPayloadLegendItem,
  kind: GraphLegendKind,
): Pick<GraphLegendItem, 'label' | 'description'> {
  const fallback = kind === 'node' ? NODE_LEGEND_FALLBACKS[item.id] : EDGE_LEGEND_FALLBACKS[item.id];
  const payloadDescription = item.description?.trim();
  const hasUsefulPayloadDescription = Boolean(
    payloadDescription
      && !isGenericLegendDescription(item, kind, payloadDescription),
  );
  return {
    label: fallback?.label ?? item.label,
    description: hasUsefulPayloadDescription
      ? payloadDescription!
      : fallback?.description ?? payloadDescription ?? item.label,
  };
}

export type { GraphNodeType };

interface GraphViewProps {
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
  refreshToken?: number
  initialMode?: string
  initialFocus?: string
  sidebarHidden?: boolean
}

const FLOW_NODE_WIDTH = 190;
const FLOW_NODE_HEIGHT = 118;
const GRAPH_SIZE_OPTIONS = [120, 250, 500, 1000] as const;
const DEFAULT_GRAPH_PRESET: GraphMode = 'issue';
const GRAPH_DETAIL_PANEL_OPEN_STORAGE_KEY = 'mandible_graph_detail_panel_open:v1';
const GRAPH_DETAIL_PANEL_HEIGHT_STORAGE_KEY = 'mandible_graph_detail_panel_height:v1';
const DEFAULT_GRAPH_DETAIL_PANEL_WIDTH = 380;
const MIN_GRAPH_DETAIL_PANEL_WIDTH = 280;
const MAX_GRAPH_DETAIL_PANEL_WIDTH = 720;

// Shared empty collections for the pending-payload placeholder. Reusing these
// keeps `payload.nodes` / `payload.edges` referentially stable while a graph
// request is in flight, which the memoized layout and sidebar descriptor
// depend on (issue 80ced49).
const EMPTY_GRAPH_NODES: GraphNode[] = [];
const EMPTY_GRAPH_EDGES: GraphEdge[] = [];

const MODE_LABELS: Record<GraphMode, string> = {
  activity: 'Activity',
  issue: 'Issues',
  work: 'Work',
  provenance: 'Provenance',
  'provider-lineage': 'Provider Lineage',
  'artifact-lineage': 'Artifact Lineage',
};

const MODE_SUMMARIES: Record<GraphMode, string> = {
  issue: 'Open issues with structural relationships first.',
  work: 'Issues with work, auth, session, and branch context.',
  activity: 'Recent operational and ledger activity.',
  provenance: 'Evidence, commits, sessions, and provider context.',
  'provider-lineage': 'Provider, manifest, run, and artifact flow.',
  'artifact-lineage': 'Artifact origins, derivatives, and reports.',
};

const GRAPH_MODES = new Set<GraphMode>(Object.keys(MODE_LABELS) as GraphMode[]);

function coerceGraphMode(value: string | undefined): GraphMode {
  return value && GRAPH_MODES.has(value as GraphMode) ? value as GraphMode : DEFAULT_GRAPH_PRESET;
}

function initialGraphSpec(mode?: string): GraphSpecState {
  return {
    preset: coerceGraphMode(mode),
    since: 'all',
    status: 'open',
    limit: 120,
    repos: [],
    branches: [],
  };
}

function graphRequestForSpec(spec: GraphSpecState) {
  return {
    mode: spec.preset,
    since: spec.since === 'all' ? undefined : spec.since,
    status: spec.status === 'all' ? 'all' as const : undefined,
    repo: spec.repos.join(',') || undefined,
    branch: spec.branches.join(',') || undefined,
    limit: spec.limit,
    nodeTypes: spec.nodeTypes,
    edgeTypes: spec.edgeTypes,
  };
}

function typeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (s) => s.toUpperCase());
}

function compactId(id: string): string {
  const parts = id.split(':');
  return parts[parts.length - 1]?.slice(0, 12) || id.slice(0, 12);
}

function reactFlowId(id: string): string {
  return `rf_${Array.from(id).map((char) => (
    /[A-Za-z0-9-]/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`
  )).join('')}`;
}

function nodeColor(node: GraphNode): string {
  if (node.visual?.color) return node.visual.color;
  if (node.type === 'issue') {
    if (node.summary?.kind === 'bug') return 'var(--accent-red)';
    if (node.summary?.kind === 'feature') return 'var(--accent-blue)';
    if (node.summary?.kind === 'umbrella') return 'var(--accent-purple)';
    return appColors.textPrimarySoft;
  }
  if (node.type === 'session') {
    return node.active || node.status === 'active' ? 'var(--accent-green)' : appColors.graphNodeMutedStrong;
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
  return appColors.textPrimaryMuted;
}

function firstEntries(value: Record<string, unknown> | undefined, limit = 4): Array<[string, unknown]> {
  if (!value) return [];
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, limit);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function legendButtonFromPayload(
  item: GraphPayloadLegendItem,
  kind: GraphLegendKind,
  fallbackColor: string,
): GraphLegendItem {
  const copy = applyLegendFallbackCopy(item, kind);
  return {
    id: item.id,
    kind,
    label: copy.label,
    description: copy.description,
    count: item.count,
    enabled: item.enabled,
    visible: item.enabled && item.visible,
    color: item.visual?.color ?? fallbackColor,
    dash: item.visual?.dash,
    width: item.visual?.stroke_width,
  };
}

function buildNodeLegend(payload: GraphPayload): GraphLegendItem[] {
  if (payload.node_legend && payload.node_legend.length > 0) {
    const nodeSamples = new Map(payload.nodes.map((node) => [node.type, node]));
    return payload.node_legend.map((item) => (
      legendButtonFromPayload(item, 'node', nodeSamples.get(item.id) ? nodeColor(nodeSamples.get(item.id)!) : 'rgba(154,164,178,0.64)')
    ));
  }
  const counts = new Map<string, { count: number; sample: GraphNode }>();
  for (const node of payload.nodes) {
    const current = counts.get(node.type) ?? { count: 0, sample: node };
    current.count += 1;
    counts.set(node.type, current);
  }
  return Array.from(counts.entries()).map(([id, entry]) => ({
    id,
    kind: 'node' as const,
    label: typeLabel(id),
    description: `${typeLabel(id)} nodes`,
    count: entry.count,
    enabled: entry.count > 0,
    visible: entry.count > 0,
    color: nodeColor(entry.sample),
  }));
}

function buildEdgeLegend(payload: GraphPayload): GraphLegendItem[] {
  if (payload.edge_legend && payload.edge_legend.length > 0) {
    return payload.edge_legend.map((item) => (
      legendButtonFromPayload(item, 'edge', 'rgba(154,164,178,0.46)')
    ));
  }
  const counts = new Map<string, number>();
  for (const edge of payload.edges) counts.set(edge.type, (counts.get(edge.type) ?? 0) + 1);
  return Array.from(counts.entries()).map(([id, count]) => {
    const sample = payload.edges.find((edge) => edge.type === id);
    const style = sample ? graphEdgeStyle(sample) : null;
    return {
      id,
      kind: 'edge' as const,
      label: typeLabel(id),
      description: `${typeLabel(id)} edges`,
      count,
      enabled: count > 0,
      visible: count > 0,
      color: style?.stroke ?? 'rgba(154,164,178,0.46)',
      dash: style?.dasharray,
      width: style?.strokeWidth,
    };
  });
}

function visibleLegendIds(items: GraphLegendItem[]): string[] {
  return items.filter((item) => item.enabled && item.visible).map((item) => item.id);
}

function makeFlowNode(node: GraphNode, x: number, y: number): ReactFlowNode {
  return {
    id: reactFlowId(node.id),
    type: 'default',
    position: { x, y },
    initialWidth: FLOW_NODE_WIDTH,
    initialHeight: FLOW_NODE_HEIGHT,
    data: { node, label: <MandibleFlowNodeLabel node={node} /> },
  };
}

function layoutFlow(nodes: GraphNode[], edges: GraphEdge[]): { nodes: ReactFlowNode[]; edges: RoutedGraphEdge[] } {
  const result = layoutGraph(nodes, edges, {
    nodeWidth: FLOW_NODE_WIDTH,
    nodeHeight: FLOW_NODE_HEIGHT,
    availableWidth: 1500,
  });
  return {
    nodes: result.nodes.map((item) => makeFlowNode(item.node, item.position.x, item.position.y)),
    edges: result.edges,
  };
}

function ManualGraphEdges({ edges }: { edges: RoutedGraphEdge[] }): JSX.Element | null {
  if (edges.length === 0) return null;
  return (
    <svg className="graph-manual-edges" aria-hidden="true">
      <defs>
        <marker id="graph-manual-arrow" markerWidth="10" markerHeight="10" viewBox="-10 -10 20 20" orient="auto" refX="-2" refY="0">
          <path d="M -6 -4 L 0 0 L -6 4" />
        </marker>
      </defs>
      {edges.map((routed) => {
        const style = routed.style;
        const path = routed.route?.path;
        if (!path) return null;
        return (
        <path
          key={routed.id}
          className={[
            'graph-manual-edge',
            style.family === 'weak_cross_reference' ? 'graph-manual-edge--weak' : '',
            style.family === 'hierarchy' ? 'graph-manual-edge--structural' : '',
            style.family === 'provider_provenance_artifact' ? 'graph-manual-edge--provenance' : '',
          ].filter(Boolean).join(' ')}
          d={path}
          markerEnd={routed.route?.markerEnd === false ? undefined : 'url(#graph-manual-arrow)'}
          style={{
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
            opacity: style.opacity,
            strokeDasharray: style.dasharray,
          }}
        />
        );
      })}
    </svg>
  );
}

function nodeAnnotations(node: GraphNode): GraphAnnotation[] {
  const annotations = node.detail?.annotations;
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((item): GraphAnnotation[] => {
    const record = recordValue(item);
    if (!record || typeof record.id !== 'string' || typeof record.type !== 'string' || typeof record.label !== 'string') {
      return [];
    }
    return [{
      id: record.id,
      type: record.type,
      label: record.label,
      status: typeof record.status === 'string' ? record.status : undefined,
      target: typeof record.target === 'string' ? record.target : undefined,
      link_type: typeof record.link_type === 'string' ? record.link_type : undefined,
    }];
  });
}

function MandibleFlowNodeLabel({ node }: { node: GraphNode }): JSX.Element {
  const entries = firstEntries(node.metrics && Object.keys(node.metrics).length > 0 ? node.metrics : node.summary, 3);
  return (
    <div className="graph-flow-node" style={{ borderColor: nodeColor(node) }}>
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

function TokenMultiSelect({
  placeholder,
  options,
  selected,
  onChange,
  disabled = false,
}: {
  placeholder: string
  options: string[]
  selected: string[]
  onChange: (values: string[]) => void
  disabled?: boolean
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredOptions = useMemo(() => {
    const normalized = input.trim().toLowerCase();
    return options
      .filter((option) => !selectedSet.has(option))
      .filter((option) => normalized.length === 0 || option.toLowerCase().includes(normalized))
      .slice(0, 40);
  }, [input, options, selectedSet]);
  const activeOption = filteredOptions[Math.min(activeIndex, Math.max(0, filteredOptions.length - 1))];

  const addValue = (value: string) => {
    if (!value || selectedSet.has(value)) return;
    onChange([...selected, value]);
    setInput('');
    setActiveIndex(0);
    setOpen(true);
    inputRef.current?.focus();
  };

  const removeValue = (value: string) => {
    onChange(selected.filter((item) => item !== value));
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, filteredOptions.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const exact = filteredOptions.find((option) => option.toLowerCase() === input.trim().toLowerCase());
      if (exact || activeOption) addValue(exact ?? activeOption);
      return;
    }
    if (event.key === 'Backspace' && input.length === 0 && selected.length > 0) {
      event.preventDefault();
      onChange(selected.slice(0, -1));
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`graph-token-select${open ? ' graph-token-select--open' : ''}${disabled ? ' graph-token-select--disabled' : ''}`}>
      <div
        className="graph-token-select__control"
        onClick={() => {
          if (disabled) return;
          inputRef.current?.focus();
          setOpen(true);
        }}
      >
        {selected.map((value) => (
          <span key={value} className="graph-token-select__pill">
            <span>{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              className="graph-token-select__remove"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => removeValue(value)}
            ><Icon name="removeToken" /></button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="graph-token-select__input"
          disabled={disabled}
          placeholder={selected.length === 0 ? placeholder : ''}
          value={input}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setTimeout(() => setOpen(false), 110);
          }}
          onInput={(event) => {
            setInput((event.target as HTMLInputElement).value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        {selected.length > 0 && (
          <button
            type="button"
            className="graph-token-select__clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange([]);
              inputRef.current?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>
      {open && !disabled && filteredOptions.length > 0 && (
        <div className="graph-token-select__menu">
          {filteredOptions.map((option, index) => (
            <button
              key={option}
              type="button"
              className={`graph-token-select__option${index === activeIndex ? ' graph-token-select__option--active' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                addValue(option);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LensButton({
  lens,
  current,
  onSelect,
}: {
  lens: GraphModeDescriptor
  current: GraphMode
  onSelect: (mode: GraphMode) => void
}): JSX.Element {
  const disabled = !lens.available && lens.id !== current;
  return (
    <button
      type="button"
      className={`graph-lens-btn${lens.id === current ? ' graph-lens-btn--active' : ''}`}
      disabled={disabled}
      title={lens.summary ?? lens.description}
      onClick={() => onSelect(lens.id)}
    >
      <span>{lens.label}</span>
      <span className="graph-lens-btn__count">{lens.count}</span>
    </button>
  );
}

function LegendButton({
  item,
  onToggle,
}: {
  item: GraphLegendItem
  onToggle: (item: GraphLegendItem) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={[
        'graph-legend-btn',
        item.visible ? 'graph-legend-btn--active' : '',
        !item.enabled ? 'graph-legend-btn--disabled' : '',
      ].filter(Boolean).join(' ')}
      disabled={!item.enabled}
      title={item.description}
      onClick={() => onToggle(item)}
    >
      <span
        className={`graph-legend-btn__swatch graph-legend-btn__swatch--${item.kind}`}
        style={{ borderColor: item.color, background: item.kind === 'node' ? item.color : 'transparent' }}
      >
        {item.kind === 'edge' && (
          <span
            style={{
              borderTopColor: item.color,
              height: `${item.width ?? 1.5}px`,
              borderTopStyle: item.dash ? 'dashed' : 'solid',
            }}
          />
        )}
      </span>
      <span className="graph-legend-btn__label">{item.label}</span>
      <span className="graph-legend-btn__count">{item.count.toLocaleString()}</span>
    </button>
  );
}

export function GraphDetailPane({
  node,
  edges,
  onNavigate,
  presentation = 'main',
}: {
  node: GraphNode | null
  edges: GraphEdge[]
  onNavigate: (type: GraphNodeType, id: string, repoId?: string) => void
  presentation?: DetailPanePresentation
}): JSX.Element {
  const ledgerIssueId = node?.type === 'issue' && typeof node.detail?.ledger_issue_id === 'string'
    ? node.detail.ledger_issue_id
    : null;
  const active = useViewActive();
  const detailOptions = issueDetailOptions(ledgerIssueId);
  const ledgerQuery = useQuery({ ...detailOptions, enabled: active && Boolean(ledgerIssueId) }, queryClient);
  const ledgerDetail = ledgerIssueId ? detailQueryData(ledgerQuery, detailOptions) : undefined;
  const ledgerLoading = ledgerQuery.isPending;
  const ledgerError = queryErrorMessage(ledgerQuery.error);
  // Add-to-Space picker visibility for the selected ledger issue (child 08c312a).
  // The graph stays a *picker*: it sends the selected node to a Space the user
  // chooses, never opening the Space editor here.
  const [spacePickerOpen, setSpacePickerOpen] = useState(false);

  useEffect(() => {
    // Reset the picker whenever the selected node changes so it never leaks
    // across selections.
    setSpacePickerOpen(false);
  }, [ledgerIssueId]);

  if (!node) {
    return (
      <DetailPaneShell
        presentation={presentation}
        as="aside"
        headerPlacement={presentation === 'main' ? 'frame' : 'pane'}
        className="graph-detail-pane"
        header={<DetailPaneHeader presentation={presentation} variant="compact" title="Graph detail" />}
      >
        <div className="graph-detail-pane__empty">Select a node</div>
      </DetailPaneShell>
    );
  }
  if (ledgerIssueId) {
    const openLedgerEntity = (type: 'issue' | 'session' | 'auth_request' | 'conversation', id: string, repoId?: string) => {
      if (type === 'issue') {
        const repo = repoId ?? ledgerDetail?.project.repo_id ?? node.repo_id ?? node.repo;
        onNavigate('issue', `issue:${repo ?? ''}:${id}`, repo ?? undefined);
        return;
      }
      if (type === 'auth_request') {
        onNavigate('auth_request', id);
        return;
      }
      if (type === 'session' || type === 'conversation') {
        onNavigate('session', id);
      }
    };
    return (
      <aside className="graph-detail-pane graph-detail-pane--ledger">
        {ledgerLoading && !ledgerDetail ? (
          <LoadingSkeleton variant="detail" label="Loading issue detail" />
        ) : ledgerError && !ledgerDetail ? (
          <DetailPaneNotice severity="error" title="Issue detail unavailable">{ledgerError}</DetailPaneNotice>
        ) : ledgerDetail ? (
          <>
            {ledgerError && <DetailPaneNotice severity="error" title="Issue refresh failed">{ledgerError}</DetailPaneNotice>}
            <LedgerIssueDetail
              compact
              presentation={presentation}
              detail={ledgerDetail}
              onOpenEntity={openLedgerEntity}
              onAddComment={async (body) => {
                const next = await addLedgerIssueComment(ledgerIssueId, body);
                queryClient.setQueryData(detailOptions.queryKey, next);
              }}
              onAddToSpace={() => setSpacePickerOpen(true)}
            />
            {spacePickerOpen && (
              <div className="graph-detail-pane__space-picker">
                <AddToSpace
                  projectId={ledgerDetail.project.id}
                  targets={[
                    {
                      ref_type: 'issue',
                      ref_id: ledgerDetail.id,
                      title: ledgerDetail.title,
                    } satisfies AddToSpaceTarget,
                  ]}
                  label="Add to Space"
                  onAdded={() => setSpacePickerOpen(false)}
                />
              </div>
            )}
          </>
        ) : (
          <div className="graph-detail-pane__empty">No ledger detail</div>
        )}
      </aside>
    );
  }
  const connected = edges.filter((edge) => edge.source === node.id || edge.target === node.id).slice(0, 8);
  const detailEntries = firstEntries(node.detail, 8);
  const summaryEntries = firstEntries(node.summary, 8);
  const annotations = nodeAnnotations(node).slice(0, 12);
  const canNavigate = node.type === 'issue' || node.type === 'session' || node.type === 'auth_request' || node.type === 'artifact' || node.type === 'report';
  const navigateAnnotation = (annotation: GraphAnnotation) => {
    if (!annotation.target) return;
    if (annotation.target.startsWith('auth_request:')) onNavigate('auth_request', annotation.target);
    if (annotation.target.startsWith('session:')) onNavigate('session', annotation.target);
    if (annotation.target.startsWith('artifact:')) onNavigate('artifact', annotation.target);
  };
  const detailActions = canNavigate || (node.actions ?? []).length > 0 ? (
    <>
      {canNavigate && (
        <button type="button" className="btn" onClick={() => onNavigate(node.type, node.id, node.repo_id ?? node.repo)}>
          Open
        </button>
      )}
      {(node.actions ?? []).map((action) => {
        const opensNode = action.kind === 'navigate' || (action.kind === 'preview' && (node.type === 'artifact' || node.type === 'report'));
        return (
          <button
            key={action.id}
            type="button"
            className="btn"
            disabled={action.disabled || !opensNode}
            onClick={() => opensNode && onNavigate(node.type, action.target ?? node.id, node.repo_id ?? node.repo)}
            title={action.description}
          >
            {action.label}{action.requires_auth ? ' *' : ''}
          </button>
        );
      })}
    </>
  ) : undefined;
  return (
    <DetailPaneShell
      presentation={presentation}
      as="aside"
      className="graph-detail-pane"
      bodyClassName="graph-detail-pane__body"
      header={(
        <DetailPaneHeader
          presentation={presentation}
          variant="standard"
          identity={{
            entityLabel: typeLabel(node.type),
            displayRef: shortRouteId(node.id),
            canonicalRef: node.id,
            copyLabel: `Copy ${typeLabel(node.type)} reference`,
          }}
          title={node.label}
          status={node.status ? <span className="graph-detail-pane__status">{node.status}</span> : undefined}
          actions={detailActions}
          actionsLabel="Graph detail actions"
        />
      )}
    >
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

      {annotations.length > 0 && (
        <div className="graph-detail-pane__section">
          <div className="graph-detail-pane__section-title">Evidence</div>
          <div className="graph-detail-pane__edges">
            {annotations.map((annotation) => (
              <button
                key={annotation.id}
                type="button"
                className="graph-detail-pane__edge"
                disabled={!annotation.target}
                onClick={() => navigateAnnotation(annotation)}
              >
                <span>{annotation.link_type ?? typeLabel(annotation.type)}</span>
                <code>{annotation.status ? `${annotation.label} (${annotation.status})` : annotation.label}</code>
              </button>
            ))}
          </div>
        </div>
      )}

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
    </DetailPaneShell>
  );
}

export function GraphView({
  onNavigate,
  refreshToken,
  initialMode,
  initialFocus,
  sidebarHidden = false,
}: GraphViewProps): JSX.Element {
  const routeMode = coerceGraphMode(initialMode);
  const [payloadState, setPayloadState] = useState<{
    requestKey: string | null;
    value: GraphPayload;
  }>({ requestKey: null, value: { nodes: [], edges: [], mode: DEFAULT_GRAPH_PRESET } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spec, setSpec] = useState<GraphSpecState>(() => initialGraphSpec(initialMode));
  const routeFocus = initialFocus?.trim() || null;
  const [selection, setSelection] = useState<{ focus: string | null; id: string | null }>({ focus: routeFocus, id: routeFocus });
  const selectedNodeId = selection.focus === routeFocus ? selection.id : routeFocus;
  const explicitFocus = Boolean(routeFocus && selectedNodeId === routeFocus);
  useEffect(() => {
    setSelection((current) => current.focus === routeFocus ? current : { focus: routeFocus, id: routeFocus });
  }, [routeFocus]);
  const [detailPanelState, updateDetailPanelState] = useAppRightSidebarState('graph', {
    open: true,
    width: DEFAULT_GRAPH_DETAIL_PANEL_WIDTH,
  }, {
    minWidth: MIN_GRAPH_DETAIL_PANEL_WIDTH,
    maxWidth: MAX_GRAPH_DETAIL_PANEL_WIDTH,
    removeKeys: [GRAPH_DETAIL_PANEL_OPEN_STORAGE_KEY, GRAPH_DETAIL_PANEL_HEIGHT_STORAGE_KEY],
    migrate: () => {
      const open = window.localStorage.getItem(GRAPH_DETAIL_PANEL_OPEN_STORAGE_KEY);
      return {
        open: open === null ? true : JSON.parse(open) === true,
        width: DEFAULT_GRAPH_DETAIL_PANEL_WIDTH,
      };
    },
  });
  const detailPanelOpen = detailPanelState.open;
  const setDetailPanelOpen = (open: boolean) => updateDetailPanelState({ open });
  const lastFocusedNodeOpenedRef = useRef<string | null>(null);
  const graphRequest = useMemo(() => graphRequestForSpec(spec), [spec]);
  const graphRequestKey = useMemo(
    () => detailRequestKey('graph', graphRequest),
    [graphRequest],
  );
  // Issue 80ced49: the pending-payload placeholder must keep a stable identity
  // across renders. A fresh object literal here gave `payload.nodes` and
  // `payload.edges` new identities on every render, which invalidated the
  // memoized sidebar descriptor, re-ran the registration effect, set app
  // shell state, and re-rendered this view — an unbounded synchronous render
  // loop that pinned a core whenever the graph request had not resolved yet.
  const pendingPayload = useMemo<GraphPayload>(
    () => ({ nodes: EMPTY_GRAPH_NODES, edges: EMPTY_GRAPH_EDGES, mode: spec.preset }),
    [spec.preset],
  );
  const payload = payloadState.requestKey === graphRequestKey
    ? payloadState.value
    : pendingPayload;

  useEffect(() => {
    setSpec((current) => ({ ...current, preset: routeMode, nodeTypes: undefined, edgeTypes: undefined }));
  }, [routeMode]);

  useLayoutEffect(() => {
    const cached = readPersistedDetail<GraphPayload>('graph', graphRequestKey);
    if (cached) setPayloadState({ requestKey: graphRequestKey, value: cached });
  }, [graphRequestKey]);

  useRouteLoad((register) => {
    let active = true;
    setLoading(true);
    setError(null);
    const detailStarted = beginDetailRequest();
    const initialRead = getGraph(graphRequest)
      .then((result) => {
        const data = result as GraphPayload;
        if (!active) return;
        writePersistedDetail('graph', graphRequestKey, data, undefined, detailStarted);
        setPayloadState({ requestKey: graphRequestKey, value: data });
        if (routeFocus) {
          if (data.nodes.some((node) => node.id === routeFocus) && lastFocusedNodeOpenedRef.current !== routeFocus) {
            setDetailPanelOpen(true);
            lastFocusedNodeOpenedRef.current = routeFocus;
          }
        } else {
          lastFocusedNodeOpenedRef.current = null;
          setSelection((current) => data.nodes.some((node) => node.id === current.id)
            ? current
            : { focus: routeFocus, id: data.nodes[0]?.id ?? null });
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    register(initialRead);
    return () => {
      active = false;
    };
  }, [graphRequest, graphRequestKey, refreshToken, routeFocus]);

  const lenses = (payload.modes ?? Object.entries(MODE_LABELS).map(([id, label]) => ({
    id: id as GraphMode,
    label,
    kind: 'perspective' as const,
    description: MODE_SUMMARIES[id as GraphMode],
    summary: MODE_SUMMARIES[id as GraphMode],
    count: id === spec.preset ? payload.nodes.length : 0,
    available: id === spec.preset,
  }))).map((mode) => ({
    ...mode,
    label: MODE_LABELS[mode.id] ?? mode.label,
    summary: MODE_SUMMARIES[mode.id] ?? mode.summary,
    description: MODE_SUMMARIES[mode.id] ?? mode.description,
  }));
  const activeLensDescriptor = lenses.find((item) => item.id === spec.preset);
  const activeLensSummary = activeLensDescriptor?.summary
    ?? activeLensDescriptor?.description
    ?? MODE_SUMMARIES[spec.preset];
  const activeLensTotal = payload.counts?.total_nodes
    ?? (payload.mode === spec.preset && payload.available_count != null
    ? payload.available_count
    : lenses.find((item) => item.id === spec.preset)?.count ?? payload.nodes.length);
  const displayedCount = payload.counts?.visible_nodes ?? payload.displayed_count ?? payload.nodes.length;
  const displayedEdges = payload.counts?.visible_edges ?? payload.edges.length;
  const availableNodes = payload.counts?.available_nodes ?? displayedCount;
  const availableEdges = payload.counts?.available_edges ?? displayedEdges;

  const repos = useMemo(() => {
    const seen = new Set<string>(payload.filters?.repos ?? []);
    spec.repos.forEach((repo) => seen.add(repo));
    if (seen.size === 0) {
      payload.nodes.forEach((node) => (node.repo || node.repo_id) && seen.add(node.repo || node.repo_id || ''));
    }
    return Array.from(seen).filter(Boolean).sort();
  }, [payload.filters?.repos, payload.nodes, spec.repos]);

  const branches = useMemo(() => {
    const seen = new Set<string>(payload.filters?.branches ?? []);
    spec.branches.forEach((branch) => seen.add(branch));
    if (seen.size === 0) {
      payload.nodes.forEach((node) => {
        if (node.branch) seen.add(node.branch);
      });
    }
    return Array.from(seen).sort();
  }, [payload.filters?.branches, payload.nodes, spec.branches]);

  const nodeLegend = useMemo(() => buildNodeLegend(payload), [payload]);
  const edgeLegend = useMemo(() => buildEdgeLegend(payload), [payload]);
  const visibleNodes = payload.nodes;
  const visibleEdges = payload.edges;
  const layoutResult = useMemo(() => layoutFlow(visibleNodes, visibleEdges), [visibleNodes, visibleEdges]);
  const flowNodes = useMemo(
    () => layoutResult.nodes.map((node) => ({
      ...node,
      selected: (node.data as { node: GraphNode }).node.id === selectedNodeId,
    })),
    [layoutResult.nodes, selectedNodeId],
  );
  const flowEdgeList = layoutResult.edges;
  // Selection stays in React Flow state; the key only tracks structure that should refit.
  const flowSignature = useMemo(
    () => [
      spec.preset,
      layoutResult.nodes.map((node) => node.id).join(','),
      flowEdgeList.map((edge) => edge.id).join(','),
    ].join(':'),
    [flowEdgeList, layoutResult.nodes, spec.preset],
  );
  const selectedNode = useMemo(
    () => payload.nodes.find((node) => node.id === selectedNodeId) ?? (explicitFocus ? null : visibleNodes[0]) ?? null,
    [payload.nodes, visibleNodes, selectedNodeId, explicitFocus],
  );

  const detailPanelContent = useMemo(() => (
    explicitFocus && !selectedNode
      ? <div role="status">{loading ? 'Loading graph focus' : error ? 'Could not load graph focus' : 'Graph focus not found'}: {selectedNodeId}</div>
      : <GraphDetailPane presentation="sidebar" node={selectedNode} edges={visibleEdges} onNavigate={onNavigate} />
  ), [onNavigate, selectedNode, visibleEdges, explicitFocus, loading, error, selectedNodeId]);

  const detailPanelDescriptor = useMemo(() => ({
    id: 'graph-detail',
    kind: 'panel' as const,
    title: 'Graph detail',
    icon: <Icon name="preview" size={18} />,
    ariaLabel: 'Graph detail',
    open: detailPanelOpen,
    width: detailPanelState.width,
    minWidth: MIN_GRAPH_DETAIL_PANEL_WIDTH,
    maxWidth: MAX_GRAPH_DETAIL_PANEL_WIDTH,
    onOpenChange: (open: boolean) => updateDetailPanelState({ open }),
    onWidthChange: (width: number) => updateDetailPanelState({ width }),
    content: selectedNode || explicitFocus ? detailPanelContent : null,
  }), [detailPanelContent, detailPanelOpen, detailPanelState.width, selectedNode, explicitFocus, updateDetailPanelState]);

  useRegisterAppRightSidebar(detailPanelDescriptor);

  const updateSpec = (patch: Partial<GraphSpecState>) => {
    setSpec((current) => ({ ...current, ...patch }));
  };

  const selectPreset = (preset: GraphMode) => {
    setSpec((current) => ({
      ...current,
      preset,
      status: preset === 'issue' ? 'open' : current.status,
      nodeTypes: undefined,
      edgeTypes: undefined,
    }));
  };

  const toggleLegendItem = (item: GraphLegendItem) => {
    if (!item.enabled) return;
    if (item.kind === 'node') {
      const current = new Set(spec.nodeTypes ?? payload.spec?.node_types ?? visibleLegendIds(nodeLegend));
      if (current.has(item.id)) current.delete(item.id);
      else current.add(item.id);
      const next = Array.from(current);
      if (next.length > 0) updateSpec({ nodeTypes: next });
      return;
    }
    const current = new Set(spec.edgeTypes ?? payload.spec?.edge_types ?? visibleLegendIds(edgeLegend));
    if (current.has(item.id)) current.delete(item.id);
    else current.add(item.id);
    const next = Array.from(current);
    if (next.length > 0) updateSpec({ edgeTypes: next });
  };

  const graphDisplaySummary = `Displayed ${displayedCount.toLocaleString()}/${availableNodes.toLocaleString()} nodes and ${displayedEdges.toLocaleString()}/${availableEdges.toLocaleString()} edges`;
  const graphLimitSummary = payload.truncated || availableNodes < activeLensTotal
    ? `Lens total ${activeLensTotal.toLocaleString()} nodes before the current filters and size limit.`
    : '';

  return (
    <div className={`graph-view${sidebarHidden ? ' graph-view--sidebar-hidden' : ''}`}>
      <ViewSidebar
        hidden={sidebarHidden}
        {...VIEW_SIDEBAR_GEOMETRY.graph}
        ariaLabel="Graph controls"
        className="graph-sidebar"
        contentLayout="inset-controls"
      >
            <div className="graph-spec-row graph-spec-row--scope">
              <span className="graph-spec-row__label">Scope</span>
              <div className="graph-toolbar__combobox-group">
                <TokenMultiSelect
                  placeholder="All repos"
                  options={repos}
                  selected={spec.repos}
                  onChange={(repos) => updateSpec({ repos })}
                />
                <TokenMultiSelect
                  placeholder="All branches"
                  options={branches}
                  selected={spec.branches}
                  onChange={(branches) => updateSpec({ branches })}
                  disabled={branches.length === 0}
                />
              </div>
            </div>
            <div className="graph-toolbar" aria-label="Graph filters and size">
              <div className="graph-control-group">
                <span className="graph-control-group__label">Time</span>
                <div className="graph-toolbar__toggle-group">
                  {(['1d', '3d', '7d', 'all'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`graph-toolbar__toggle${spec.since === value ? ' graph-toolbar__toggle--active' : ''}`}
                      onClick={() => updateSpec({ since: value })}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
              <div className="graph-control-group">
                <span className="graph-control-group__label">Status</span>
                <div className="graph-toolbar__toggle-group">
                  {(['open', 'all'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`graph-toolbar__toggle${spec.status === value ? ' graph-toolbar__toggle--active' : ''}`}
                      onClick={() => updateSpec({ status: value })}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
              <div className="graph-control-group" aria-label="Graph size">
                <span className="graph-control-group__label">Size</span>
                <div className="graph-toolbar__toggle-group">
                  {GRAPH_SIZE_OPTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`graph-toolbar__toggle${spec.limit === value ? ' graph-toolbar__toggle--active' : ''}`}
                      onClick={() => updateSpec({ limit: value })}
                    >
                      {value.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="graph-spec-row graph-spec-row--lens">
              <span className="graph-spec-row__label">Lens</span>
              <div className="graph-lens-strip" aria-label="Graph lens presets">
                {lenses.map((item) => (
                  <LensButton key={item.id} lens={item} current={spec.preset} onSelect={selectPreset} />
                ))}
              </div>
            </div>
            <div className="graph-spec-row graph-spec-row--legend">
              <span className="graph-spec-row__label">Nodes</span>
              <div className="graph-legend-stack">
                <div className="graph-legend-strip" aria-label="Visible node families">
                  {nodeLegend.length === 0 && <div className="graph-legend-strip__empty">No node families</div>}
                  {nodeLegend.map((item) => (
                    <LegendButton key={item.id} item={item} onToggle={toggleLegendItem} />
                  ))}
                </div>
                {spec.preset === 'issue' && nodeLegend.length === 1 && nodeLegend[0]?.id === 'issue' && (
                  <div className="graph-row-note">
                    Only issue nodes are shown in this lens by default; auth and session evidence stays attached to issue details.
                  </div>
                )}
              </div>
            </div>
            <div className="graph-spec-row graph-spec-row--legend">
              <span className="graph-spec-row__label">Edges</span>
              <div className="graph-legend-stack">
                <div className="graph-legend-strip" aria-label="Visible edge families">
                  {edgeLegend.length === 0 && <div className="graph-legend-strip__empty">No edge families</div>}
                  {edgeLegend.map((item) => (
                    <LegendButton key={item.id} item={item} onToggle={toggleLegendItem} />
                  ))}
                </div>
                <div className="graph-row-note">
                  Hierarchy edges place parent and umbrella issues; reference and evidence edges add context without changing the issue tree.
                </div>
              </div>
            </div>
            <div className="graph-display-summary" aria-live="polite">
              <strong>{activeLensSummary}</strong>
              <span>{graphDisplaySummary}</span>
              {graphLimitSummary && <span>{graphLimitSummary}</span>}
            </div>
      </ViewSidebar>

      <div className="graph-workspace">
        <div className="graph-canvas-wrap">
          <AppOperationalNoticeOutlet registerAsMain />
          {error ? <DetailPaneNotice severity="error" title="Graph could not be refreshed" className="graph-canvas-notice">{error}</DetailPaneNotice> : null}
          {loading && flowNodes.length === 0 && <LoadingSkeleton variant="canvas" label="Loading graph" />}
          {!loading && !error && flowNodes.length === 0 && (
            <div className="graph-empty">
              <h3>No graph data</h3>
              <p>{MODE_LABELS[spec.preset]} has no visible nodes for the current spec.</p>
            </div>
          )}
          {flowNodes.length > 0 && (
            <ReactFlow
              key={flowSignature}
              nodes={flowNodes}
              defaultEdges={[]}
              proOptions={{ hideAttribution: true }}
              fitView
              fitViewOptions={{ padding: 0.16 }}
              minZoom={0.2}
              maxZoom={1.8}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_event, node) => {
                const id = (node.data as { node: GraphNode }).node.id;
                setSelection({ focus: routeFocus, id });
                if (parseRouteFromHash(window.location.hash).tab === 'graph') {
                  replaceRouteHash(routeHashWithParams(window.location.hash, 'graph', { focus: id }));
                }
                setDetailPanelOpen(true);
              }}
              onNodeDoubleClick={(_event, node) => {
                const graphNode = (node.data as { node: GraphNode }).node;
                if (graphNode && (graphNode.type === 'issue' || graphNode.type === 'session' || graphNode.type === 'auth_request' || graphNode.type === 'artifact' || graphNode.type === 'report')) {
                  onNavigate(graphNode.type, graphNode.id, graphNode.repo_id ?? graphNode.repo);
                }
              }}
            >
              <ViewportPortal>
                <ManualGraphEdges edges={flowEdgeList} />
              </ViewportPortal>
              <Background color={appColors.graphBackgroundGrid} gap={18} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) => nodeColor((node.data as { node: GraphNode }).node)}
                maskColor={appColors.graphMinimapMask}
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>
  );
}

/** Warm the Graph list and only its explicit or default selected issue detail. */
export async function warmInitialData(params: Record<string, string>): Promise<void> {
  const detailStarted = beginDetailRequest();
  const request = graphRequestForSpec(initialGraphSpec(params.mode));
  const requestKey = detailRequestKey('graph', request);
  const data = await getGraph(request) as GraphPayload;
  writePersistedDetail('graph', requestKey, data, undefined, detailStarted);

  const selectedNode = (params.focus
    ? data.nodes.find((node) => node.id === params.focus)
    : data.nodes[0]) ?? null;
  const issueId = selectedNode?.type === 'issue'
    && typeof selectedNode.detail?.ledger_issue_id === 'string'
    ? selectedNode.detail.ledger_issue_id
    : null;
  if (!issueId) return;

  await queryClient.fetchQuery(issueDetailOptions(issueId));
}

export default GraphView;
