import type { GraphQueryParams } from '../api';
import type { ProjectTimelineInput } from '../types/timeline';

const sortedSet = <T extends string>(values: readonly T[] | undefined): T[] | undefined =>
  values?.length ? [...new Set(values)].sort() : undefined;
const csvSet = (value: string | undefined) => sortedSet(value?.split(',').map((part) => part.trim()).filter(Boolean))?.join(',');

export function normalizeGraphInput(input: GraphQueryParams = {}): GraphQueryParams {
  return {
    mode: input.mode ?? 'issue',
    repo: csvSet(input.repo), branch: csvSet(input.branch), since: input.since || undefined,
    limit: input.limit ?? 120, status: input.status,
    nodeTypes: sortedSet(input.nodeTypes), edgeTypes: sortedSet(input.edgeTypes),
  };
}

export function normalizeTimelineInput(input: ProjectTimelineInput): ProjectTimelineInput {
  const { root_row_specs, ...rest } = input;
  return {
    ...rest,
    root_specs: input.root_specs ?? root_row_specs,
    expanded_event_ids: sortedSet(input.expanded_event_ids),
    expanded_paths: sortedSet(input.expanded_paths),
    event_kinds: input.event_kinds ? [...new Set(input.event_kinds)].sort() : undefined,
  };
}

export const projectionKeys = {
  graphs: ['graph'] as const,
  timelines: ['timeline'] as const,
  graph: (input: GraphQueryParams = {}) => ['graph', normalizeGraphInput(input)] as const,
  timeline: (input: ProjectTimelineInput) => ['timeline', normalizeTimelineInput(input)] as const,
};

export const isProjectionKey = (key: readonly unknown[]) => key[0] === 'graph' || key[0] === 'timeline';
