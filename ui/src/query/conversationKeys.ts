import type { ConversationSidebarResponse, ConversationWindowRequest } from '../api';

type SidebarRequest = Parameters<typeof import('../api').getConversationSidebar>[0];

export type ConversationSidebarFilters = Omit<SidebarRequest, 'cursor' | 'group_key' | 'signal' | 'onPending' | 'snapshot'>;

function sorted(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function ordered(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

export function normalizeSidebarFilters(filters: ConversationSidebarFilters): ConversationSidebarFilters {
  return {
    lifecycle: filters.lifecycle,
    source: filters.source,
    starred: filters.starred,
    search: filters.search,
    full_text: filters.full_text,
    sort: filters.sort,
    min_blocks: filters.min_blocks,
    exclude_subagents: filters.exclude_subagents,
    project_ids: sorted(filters.project_ids),
    pinned_ids: filters.pinned_ids === undefined ? undefined : ordered(filters.pinned_ids),
    limit: filters.limit,
  };
}

export type ConversationWindowTarget =
  | { kind: 'initial' | 'latest'; value: null; limit: number | null; view?: 'display' }
  | { kind: 'block' | 'turn'; value: string; limit: number | null; view?: 'display' }
  | { kind: 'position'; value: number; limit: number | null; view?: 'display' };

export function normalizeWindowTarget(request: ConversationWindowRequest = {}): ConversationWindowTarget {
  const limit = request.limit ?? null;
  const view = request.view;
  if ('block' in request) return { kind: 'block', value: request.block, limit, view };
  if ('turn' in request) return { kind: 'turn', value: request.turn, limit, view };
  if ('position' in request) return { kind: 'position', value: request.position, limit, view };
  return { kind: request.target ?? 'initial', value: null, limit, view };
}

export function windowRequest(target: ConversationWindowTarget, signal?: AbortSignal): ConversationWindowRequest {
  const limit = target.limit ?? undefined;
  if (target.kind === 'block') return { block: target.value, limit, view: target.view, signal };
  if (target.kind === 'turn') return { turn: target.value, limit, view: target.view, signal };
  if (target.kind === 'position') return { position: target.value, limit, view: target.view, signal };
  return { target: target.kind, limit, view: target.view, signal };
}

export const conversationKeys = {
  all: ['chat'] as const,
  sidebars: () => ['chat', 'sidebar'] as const,
  sidebarInitial: (filters: ConversationSidebarFilters) => (
    ['chat', 'sidebar', 'initial', normalizeSidebarFilters(filters)] as const
  ),
  sidebarPage: (filters: ConversationSidebarFilters, group: string, cursor: string) => (
    ['chat', 'sidebar', 'page', normalizeSidebarFilters(filters), { group, cursor }] as const
  ),
  conversations: () => ['chat', 'conversation'] as const,
  routeTargets: () => ['chat', 'route-target'] as const,
  routeTarget: (target: { type: 'conversation' | 'session'; id: string } | null) => ['chat', 'route-target', target] as const,
  bySession: (sessionId: string) => ['chat', 'conversation', 'session', sessionId] as const,
  conversation: (id: string) => ['chat', 'conversation', id] as const,
  aggregate: (id: string) => ['chat', 'conversation', id, 'aggregate'] as const,
  windows: (id: string) => ['chat', 'conversation', id, 'window'] as const,
  window: (id: string, target: ConversationWindowTarget) => (
    ['chat', 'conversation', id, 'window', target] as const
  ),
};

export type ConversationSidebarQueryData = ConversationSidebarResponse;
