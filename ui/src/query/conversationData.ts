import type {
  Conversation,
  ConversationBlock,
  ConversationChild,
  ConversationPositionWindow,
  ConversationStructure,
  ConversationSidebarGroup,
  ConversationSidebarResponse,
} from '../api';
export { ReadingWindowRequests } from './readingWindowRequests';

export type ConversationWithDetails = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
  parent: ConversationPositionWindow['parent'];
  position_window: {
    revision: number;
    source_version_id: string | null;
    position_space_id: string | null;
    publication_revision: number;
    total: number;
    loaded_intervals: ConversationLoadedInterval[];
    has_before: boolean;
    has_after: boolean;
    after_count: number;
  };
};

export type ConversationLoadedInterval = {
  start: number;
  end: number;
};

function mergeActiveInterval(current: ConversationLoadedInterval | null, incoming?: ConversationLoadedInterval): ConversationLoadedInterval | null {
  if (!current) return incoming ?? null;
  if (!incoming || incoming.start > current.end + 1 || incoming.end < current.start - 1) return current;
  return { start: Math.min(current.start, incoming.start), end: Math.max(current.end, incoming.end) };
}

export type ConversationSourceCoordinate = {
  conversationId: string;
  positionSpaceId: string;
  position: number;
  subtarget?: string;
  offset?: number;
};

export type ReadingWindowOperation =
  | { kind: 'extend-start' | 'extend-end'; window: ConversationPositionWindow; protected: readonly ConversationLoadedInterval[] }
  | { kind: 'replace'; window: ConversationPositionWindow; command: { token: string; target: ConversationSourceCoordinate } }
  | { kind: 'trim-start' | 'trim-end'; position: number; protected: readonly ConversationLoadedInterval[] };

export type ReadingWindowResult =
  | { status: 'committed'; data: ConversationTranscriptData; command?: Extract<ReadingWindowOperation, { kind: 'replace' }>['command'] }
  | { status: 'position-space-changed' | 'obsolete' | 'noncontiguous' | 'protected' | 'capacity-exceeded' };

/** The active list is a contiguous span; the Query aggregate may also retain distant cached ranges. */
export function activeConversationBlocks(data: ConversationTranscriptData): ConversationBlock[] {
  const span = data.active_window;
  return span ? data.blocks.filter(block => block.position >= span.start && block.position <= span.end) : [];
}

function activeAvailability(data: ConversationTranscriptData): ConversationTranscriptData {
  const span = data.active_window;
  return { ...data,
    start_reached: data.total === 0 || span?.start === 0,
    end_reached: data.total === 0 || span?.end === data.total - 1,
    after_count: span ? Math.max(0, data.total - span.end - 1) : data.total };
}

export function applyReadingWindowOperation(current: ConversationTranscriptData, operation: ReadingWindowOperation): ReadingWindowResult {
  if (!('window' in operation)) {
    const active = current.active_window;
    if (!active) return { status: 'committed', data: current };
    const span = operation.kind === 'trim-start'
      ? { start: Math.max(active.start, operation.position), end: active.end }
      : { start: active.start, end: Math.min(active.end, operation.position) };
    if (span.start > span.end || operation.protected.some(region =>
      region.start < span.start || region.end > span.end)) return { status: 'protected' };
    return { status: 'committed', data: activeAvailability({ ...current, active_window: span }) };
  }
  const incoming = operation.window;
  if (current.conversation.id !== incoming.conversation.id) return { status: 'obsolete' };
  if (incoming.publication_revision < current.publication_revision) return { status: 'obsolete' };
  if (operation.kind === 'replace') {
    const target = operation.command.target;
    if (target.conversationId !== incoming.conversation.id || target.positionSpaceId !== incoming.position_space_id) {
      return { status: 'position-space-changed' };
    }
    if (!incoming.blocks.some(block => block.position === target.position)) return { status: 'noncontiguous' };
    const next = conversationTranscriptFromWindow(incoming);
    return { status: 'committed', data: next, command: operation.command };
  }
  if (current.position_space_id !== incoming.position_space_id) return { status: 'position-space-changed' };
  const span = intervalForWindow(incoming)[0];
  const active = current.active_window;
  if (active && span && (span.start > active.end + 1 || span.end < active.start - 1
      || (operation.kind === 'extend-start' ? span.start > active.start : span.end < active.end))) return { status: 'noncontiguous' };
  const merged = mergeBlocks(current.blocks, incoming.blocks, incoming.source_version_id, current.block_source_versions);
  const activeSpan = mergeActiveInterval(active, span);
  const retained = retainReadingWindow(merged, activeSpan, operation.protected);
  if (!retained) return { status: 'capacity-exceeded' };
  const data = reconcileConversationWindow({ ...current, blocks: retained.blocks }, { ...incoming,
    blocks: incoming.blocks.filter(block => retained.blocks.includes(block)) });
  return { status: 'committed', data: activeAvailability({ ...data, blocks: retained.blocks,
    loaded_intervals: intervalsForBlocks(retained.blocks), active_window: retained.span }) };
}

/** Edge-only retention keeps the visible/focused region intact and bounds both rows and fetched bytes. */
export function retainReadingWindow(
  blocks: ConversationBlock[], span: ConversationLoadedInterval | null,
  protectedRegions: readonly ConversationLoadedInterval[],
  limits = { bytes: 16 * 1024 * 1024, positions: 2000 },
): { blocks: ConversationBlock[]; span: ConversationLoadedInterval | null } | null {
  if (!span) return { blocks: [], span: null };
  if (protectedRegions.some(region => region.start < span.start || region.end > span.end)) return null;
  let start = span.start;
  let end = span.end;
  const protectedStart = Math.min(...protectedRegions.map(region => region.start), end);
  const protectedEnd = Math.max(...protectedRegions.map(region => region.end), start);
  const byPosition = new Map(blocks.map(block => [block.position, block]));
  let bytes = 0;
  for (let position = start; position <= end; position += 1) {
    const block = byPosition.get(position);
    if (!block) return null;
    bytes += measuredBlockBytes(block);
  }
  while (bytes > limits.bytes || end - start + 1 > limits.positions) {
    const canStart = start < protectedStart;
    const canEnd = end > protectedEnd;
    if (!canStart && !canEnd) return null;
    if (canStart && (!canEnd || protectedStart - start >= end - protectedEnd)) {
      bytes -= measuredBlockBytes(byPosition.get(start++)!);
    } else bytes -= measuredBlockBytes(byPosition.get(end--)!);
  }
  return { blocks: blocks.filter(block => block.position >= start && block.position <= end), span: { start, end } };
}

export type ConversationTranscriptData = {
  active_window: ConversationLoadedInterval | null;
  conversation: Conversation;
  body_source: ConversationPositionWindow['body_source'];
  source_version_id: string | null;
  position_space_id: string | null;
  publication_revision: number;
  children: ConversationChild[];
  parent: ConversationPositionWindow['parent'];
  revision: number;
  total: number;
  loaded_intervals: ConversationLoadedInterval[];
  start_reached: boolean;
  end_reached: boolean;
  after_count: number;
  blocks: ConversationBlock[];
  block_source_versions: ReadonlyMap<string, string | null>;
  structure: ConversationStructure | null;
};

export type ConversationTranscriptConsumer = {
  conversationId: string;
  sourceVersionId: string | null;
  historyLoading: boolean;
  total: number;
  structure: ConversationStructure | null;
  loadedIntervals: readonly ConversationLoadedInterval[];
  hasOlder: boolean;
  hasNewer: boolean;
  unmaterializedAfterCount: number;
  loadOlder: () => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>;
  loadNewer: () => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>;
  loadAround: (position: number, limit: number, signal?: AbortSignal) => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>;
};

export type ConversationHistoryLoadResult = 'loaded' | 'covered' | 'busy' | 'cancelled' | 'failed';

export type ConversationNavigationCommand = {
  key: string;
  kind: 'initial' | 'latest' | 'block' | 'turn' | 'position';
  turnId: string | null;
  blockId: string | null;
  smooth: boolean;
};

export type ConversationNavigationResult =
  | { key: string; status: 'revealed' }
  | { key: string; status: 'not-renderable' };

function intervalForWindow(payload: ConversationPositionWindow): ConversationLoadedInterval[] {
  const start = payload.window.start_position;
  const end = payload.window.end_position;
  return start === null || end === null ? [] : [{ start, end }];
}

export function mergeLoadedIntervals(
  intervals: readonly ConversationLoadedInterval[],
): ConversationLoadedInterval[] {
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ConversationLoadedInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end + 1) {
      merged.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }
  return merged;
}

export function conversationTranscriptFromWindow(payload: ConversationPositionWindow): ConversationTranscriptData {
  const blocks = boundedBlocks(payload.blocks,
    payload.target.position ?? payload.window.end_position ?? 0);
  const intervals = intervalsForBlocks(blocks);
  return {
    active_window: intervals.length === 1 ? intervals[0] : null,
    conversation: payload.conversation,
    body_source: payload.body_source,
    source_version_id: payload.source_version_id,
    position_space_id: payload.position_space_id,
    publication_revision: payload.publication_revision,
    children: payload.children,
    parent: payload.parent,
    revision: payload.revision,
    total: payload.total,
    loaded_intervals: intervals,
    start_reached: payload.total === 0 || (intervals[0]?.start === 0 && !payload.window.has_before),
    end_reached: payload.total === 0 || (intervals.at(-1)?.end === payload.total - 1 && !payload.window.has_after),
    after_count: payload.window.after_count,
    blocks,
    block_source_versions: new Map(blocks.map(block => [block.id, payload.source_version_id])),
    structure: null,
  };
}

export function flattenConversationTranscript(payload: ConversationTranscriptData): ConversationWithDetails {
  return {
    ...payload.conversation,
    blocks: payload.blocks,
    children: payload.children,
    parent: payload.parent,
    position_window: {
      revision: payload.revision,
      source_version_id: payload.source_version_id,
      position_space_id: payload.position_space_id,
      publication_revision: payload.publication_revision,
      total: payload.total,
      loaded_intervals: payload.loaded_intervals,
      has_before: !payload.start_reached,
      has_after: !payload.end_reached,
      after_count: payload.after_count,
    },
  };
}

function mergeBlocks(current: readonly ConversationBlock[], incoming: readonly ConversationBlock[],
  sourceVersionId: string | null, versions: ReadonlyMap<string, string | null>): ConversationBlock[] {
  const byId = new Map<string, ConversationBlock>();
  for (const block of current) byId.set(block.id, block);
  for (const block of incoming) {
    const existing = byId.get(block.id);
    // A same-version display refresh may be compact while the user has already
    // expanded this block. Keep the fetched payload until the source changes.
    if (block.details_loaded === false && existing && existing.details_loaded !== false
        && versions.get(block.id) === sourceVersionId) continue;
    byId.set(block.id, block);
  }
  return [...byId.values()].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export function conversationBlockDetailsCurrent(data: ConversationTranscriptData, block: ConversationBlock): boolean {
  return block.details_loaded !== false && data.block_source_versions.get(block.id) === data.source_version_id;
}

const MAX_TRANSCRIPT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_VISIBLE_DETAIL_BYTES = 64 * 1024 * 1024;
const PROTECTED_READING_RADIUS = 240;
const blockBytes = new WeakMap<ConversationBlock, number>();

function measuredBlockBytes(block: ConversationBlock): number {
  const cached = blockBytes.get(block);
  if (cached !== undefined) return cached;
  const size = JSON.stringify(block).length * 2;
  blockBytes.set(block, size);
  return size;
}

function boundedBlocks(blocks: ConversationBlock[], target: number): ConversationBlock[] {
  let bytes = 0;
  const sized = blocks.map((block) => {
    const size = measuredBlockBytes(block);
    bytes += size;
    return { block, size };
  });
  const protectedDetailBytes = sized.reduce((sum, candidate) =>
    sum + (candidate.block.details_loaded === true
      && Math.abs(candidate.block.position - target) <= PROTECTED_READING_RADIUS
      ? candidate.size : 0), 0);
  if (protectedDetailBytes > MAX_VISIBLE_DETAIL_BYTES) {
    throw new Error('Expanded detail exceeds the reading cache limit.');
  }
  const budget = MAX_TRANSCRIPT_CACHE_BYTES + protectedDetailBytes;
  if (bytes <= budget) return blocks;
  const byDistance = [...sized].sort((left, right) =>
    Number(right.block.details_loaded === true) - Number(left.block.details_loaded === true)
    || Math.abs(right.block.position - target) - Math.abs(left.block.position - target));
  const evicted = new Set<string>();
  for (const candidate of byDistance) {
    if (bytes <= budget) break;
    if (Math.abs(candidate.block.position - target) <= PROTECTED_READING_RADIUS) continue;
    evicted.add(candidate.block.id);
    bytes -= candidate.size;
  }
  if (bytes > budget) {
    throw new Error('Visible conversation content exceeds the reading cache limit.');
  }
  return blocks.filter((block) => !evicted.has(block.id));
}

function intervalsForBlocks(blocks: readonly ConversationBlock[]): ConversationLoadedInterval[] {
  const intervals: ConversationLoadedInterval[] = [];
  for (const block of blocks) {
    const last = intervals.at(-1);
    if (last && block.position <= last.end + 1) last.end = Math.max(last.end, block.position);
    else intervals.push({ start: block.position, end: block.position });
  }
  return intervals;
}

export function reconcileConversationWindow(
  current: ConversationTranscriptData | undefined,
  incoming: ConversationPositionWindow,
): ConversationTranscriptData {
  if (current?.conversation.id === incoming.conversation.id
      && incoming.publication_revision < current.publication_revision) return current;
  if (!current || current.conversation.id !== incoming.conversation.id
      || current.position_space_id !== incoming.position_space_id) {
    return conversationTranscriptFromWindow(incoming);
  }
  const blocks = boundedBlocks(
    mergeBlocks(current.blocks, incoming.blocks, incoming.source_version_id, current.block_source_versions),
    incoming.target.position ?? incoming.window.end_position ?? 0,
  );
  const total = Math.max(current.total, incoming.total);
  const incomingIntervals = intervalForWindow(incoming);
  const incomingIds = new Set(incoming.blocks.map(block => block.id));
  const loadedIntervals = intervalsForBlocks(blocks);
  return activeAvailability({
    ...current,
    source_version_id: incoming.source_version_id,
    position_space_id: incoming.position_space_id,
    publication_revision: incoming.publication_revision,
    active_window: mergeActiveInterval(current.active_window, incomingIntervals[0]),
    conversation: { ...current.conversation, ...incoming.conversation },
    children: incoming.revision >= current.revision ? incoming.children : current.children,
    parent: incoming.revision >= current.revision ? incoming.parent : current.parent,
    body_source: incoming.body_source,
    revision: Math.max(current.revision, incoming.revision),
    total,
    blocks,
    block_source_versions: new Map(blocks.map(block => [block.id,
      incomingIds.has(block.id) ? incoming.source_version_id
        : current.block_source_versions.get(block.id) ?? null])),
    structure: current.structure,
    loaded_intervals: loadedIntervals,
  });
}

function mergeGroup(current: ConversationSidebarGroup, incoming: ConversationSidebarGroup): ConversationSidebarGroup {
  const seen = new Set(current.conversations.map((conversation) => conversation.id));
  return {
    ...incoming,
    conversations: [
      ...current.conversations,
      ...incoming.conversations.filter((conversation) => !seen.has(conversation.id)),
    ],
  };
}

export function mergeSidebarPages(
  initial: ConversationSidebarResponse | undefined,
  pages: ConversationSidebarResponse[],
): ConversationSidebarGroup[] {
  if (!initial) return [];
  const groups = new Map(initial.groups.map((group) => [group.key, group]));
  for (const page of pages) {
    for (const group of page.groups) {
      const current = groups.get(group.key);
      groups.set(group.key, current ? mergeGroup(current, group) : group);
    }
  }
  return [...groups.values()];
}

export type ConversationAppendPayload = Partial<Conversation> & {
  id?: string;
  append?: {
    from_position?: number;
    blocks?: ConversationBlock[];
  };
};

type ConversationWithBlocks = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
};

export function applyConversationAppendPayload<T extends ConversationWithBlocks>(
  conversation: T,
  data: ConversationAppendPayload,
): T | null {
  const { append, ...conversationData } = data;
  const appendBlocks = append?.blocks ?? [];
  if (appendBlocks.length === 0) {
    return { ...conversation, ...conversationData, blocks: conversation.blocks, children: conversation.children };
  }

  const existingIds = new Set(conversation.blocks.map((block) => block.id));
  if (appendBlocks.every((block) => existingIds.has(block.id))) {
    return { ...conversation, ...conversationData, blocks: conversation.blocks, children: conversation.children };
  }

  const expectedPosition = conversation.blocks.length > 0
    ? Math.max(...conversation.blocks.map((block) => block.position)) + 1
    : 0;
  const fromPosition = append?.from_position ?? appendBlocks[0]?.position;
  if (fromPosition !== expectedPosition || appendBlocks[0]?.position !== expectedPosition) return null;

  return {
    ...conversation,
    ...conversationData,
    blocks: [...conversation.blocks, ...appendBlocks],
    children: conversation.children,
    block_count: conversationData.block_count ?? conversation.block_count + appendBlocks.length,
  };
}

export type ConversationSummaryMergeResult = {
  conversations: Conversation[];
  applied: boolean;
  refetch: boolean;
};

export function mergeConversationSummaryIntoList(
  conversations: Conversation[],
  data: Partial<Conversation> & { id?: string },
): ConversationSummaryMergeResult {
  if (!data.id) return { conversations, applied: false, refetch: false };
  const index = conversations.findIndex((conversation) => conversation.id === data.id);
  if (index === -1) return { conversations, applied: false, refetch: true };
  if (typeof data.block_count !== 'number') return { conversations, applied: false, refetch: true };
  const existing = conversations[index];
  if (data.block_count < existing.block_count) return { conversations, applied: false, refetch: false };
  const next = conversations.slice();
  next[index] = {
    ...existing,
    block_count: data.block_count,
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
  };
  return { conversations: next, applied: true, refetch: false };
}
