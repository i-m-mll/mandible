import type { GraphEdge } from '../types/graph';

export type GraphEdgeFamily =
  | 'hierarchy'
  | 'blocking_dependency'
  | 'operational'
  | 'provider_provenance_artifact'
  | 'weak_cross_reference'
  | 'other';

export type GraphEdgeRoutePreference = 'orthogonal' | 'elbow' | 'loose' | 'straight';

export interface GraphEdgeClassification {
  family: GraphEdgeFamily
  structural: boolean
  weak: boolean
  route: GraphEdgeRoutePreference
  labelDefaultVisible: boolean
}

export interface GraphEdgeStyleDescriptor {
  family: GraphEdgeFamily
  stroke: string
  strokeWidth: number
  opacity: number
  dasharray?: string
  route: GraphEdgeRoutePreference
  labelDefaultVisible: boolean
}

const HIERARCHY_EDGE_TYPES = new Set([
  'umbrella_child',
  'parent_child',
  'parent',
  'child',
  'contains_issue',
]);

const BLOCKING_DEPENDENCY_EDGE_TYPES = new Set([
  'blocks',
  'blocked_by',
  'depends_on',
  'dependency',
  'implements',
  'implemented_by',
]);

const OPERATIONAL_EDGE_TYPES = new Set([
  'auth_issue',
  'auth_request_references_issue',
  'auth_work_unit',
  'issue_has_work_unit',
  'session_issue',
  'session_parent',
  'session_work_unit',
  'work_unit_uses_branch',
  'work_unit_branch',
  'branch_contains_commit',
  'commit_references_issue',
]);

const PROVIDER_PROVENANCE_ARTIFACT_EDGE_TYPES = new Set([
  'provider_emitted_manifest',
  'manifest_declares',
  'manifest_references_artifact',
  'model_references_store',
  'model_used_spec',
  'produced',
  'derived_from',
  'validated_by',
  'requested_by',
  'approved_by',
  'run_used_spec',
  'artifact_derived_from',
  'artifact_references_issue',
]);

const WEAK_REFERENCE_EDGE_TYPES = new Set([
  'references',
  'reference',
  'related',
  'curated_related',
  'mentions',
  'mentioned_by',
  'cross_reference',
  'duplicate',
]);

function metadataString(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function metadataBoolean(edge: GraphEdge, key: string): boolean | undefined {
  const value = edge.metadata?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function normalizedEdgeType(edge: GraphEdge): string {
  return metadataString(edge, 'relationship_type') ?? edge.type;
}

export function classifyGraphEdge(edge: GraphEdge): GraphEdgeClassification {
  const type = normalizedEdgeType(edge);
  const layout = metadataString(edge, 'layout');
  const familyHint = metadataString(edge, 'family');
  const confidence = edge.confidence?.toLowerCase();

  if (layout === 'hierarchical' || familyHint === 'hierarchy' || HIERARCHY_EDGE_TYPES.has(type)) {
    return {
      family: 'hierarchy',
      structural: true,
      weak: false,
      route: 'orthogonal',
      labelDefaultVisible: metadataBoolean(edge, 'label_default_visible') === true,
    };
  }

  if (
    edge.edge_class === 'provenance'
    || edge.edge_class === 'provider'
    || edge.edge_class === 'lifecycle'
    || familyHint === 'provider'
    || familyHint === 'provenance'
    || familyHint === 'artifact'
    || PROVIDER_PROVENANCE_ARTIFACT_EDGE_TYPES.has(type)
    || type.includes('provider')
    || type.includes('artifact')
    || type.includes('provenance')
    || type.includes('manifest')
  ) {
    return {
      family: 'provider_provenance_artifact',
      structural: false,
      weak: false,
      route: 'elbow',
      labelDefaultVisible: metadataBoolean(edge, 'label_default_visible') === true,
    };
  }

  if (
    familyHint === 'operational'
    || OPERATIONAL_EDGE_TYPES.has(type)
    || type.includes('auth')
    || type.includes('session')
    || type.includes('work_unit')
    || type.includes('branch')
    || type.includes('commit')
  ) {
    return {
      family: 'operational',
      structural: false,
      weak: false,
      route: 'elbow',
      labelDefaultVisible: metadataBoolean(edge, 'label_default_visible') === true,
    };
  }

  if (
    familyHint === 'blocking_dependency'
    || BLOCKING_DEPENDENCY_EDGE_TYPES.has(type)
    || type.includes('block')
    || type.includes('depend')
    || type.includes('implement')
  ) {
    return {
      family: 'blocking_dependency',
      structural: true,
      weak: false,
      route: 'elbow',
      labelDefaultVisible: metadataBoolean(edge, 'label_default_visible') === true,
    };
  }

  if (
    familyHint === 'weak_cross_reference'
    || WEAK_REFERENCE_EDGE_TYPES.has(type)
    || type.includes('reference')
    || type.includes('related')
    || confidence === 'weak'
  ) {
    return {
      family: 'weak_cross_reference',
      structural: false,
      weak: true,
      route: 'loose',
      labelDefaultVisible: metadataBoolean(edge, 'label_default_visible') === true,
    };
  }

  return {
    family: 'other',
    structural: false,
    weak: false,
    route: 'straight',
    labelDefaultVisible: metadataBoolean(edge, 'label_default_visible') === true,
  };
}

export function graphEdgeStyle(edge: GraphEdge): GraphEdgeStyleDescriptor {
  const classification = classifyGraphEdge(edge);
  switch (classification.family) {
    case 'hierarchy':
      return {
        ...classification,
        stroke: 'rgba(168,85,247,0.72)',
        strokeWidth: 1.9,
        opacity: 0.82,
      };
    case 'blocking_dependency':
      return {
        ...classification,
        stroke: 'rgba(245,92,92,0.66)',
        strokeWidth: 1.6,
        opacity: 0.74,
      };
    case 'operational':
      return {
        ...classification,
        stroke: 'rgba(245,194,92,0.58)',
        strokeWidth: 1.45,
        opacity: 0.68,
      };
    case 'provider_provenance_artifact':
      return {
        ...classification,
        stroke: edge.edge_class === 'provider' ? 'rgba(125,211,252,0.62)' : 'rgba(50,210,150,0.58)',
        strokeWidth: 1.55,
        opacity: 0.7,
      };
    case 'weak_cross_reference':
      return {
        ...classification,
        stroke: 'rgba(154,164,178,0.34)',
        strokeWidth: 1.05,
        opacity: 0.48,
        dasharray: '4 5',
      };
    default:
      return {
        ...classification,
        stroke: 'rgba(154,164,178,0.46)',
        strokeWidth: 1.3,
        opacity: 0.62,
      };
  }
}

export function isHierarchyEdge(edge: GraphEdge): boolean {
  return classifyGraphEdge(edge).family === 'hierarchy';
}

export function isWeakReferenceEdge(edge: GraphEdge): boolean {
  return classifyGraphEdge(edge).family === 'weak_cross_reference';
}
