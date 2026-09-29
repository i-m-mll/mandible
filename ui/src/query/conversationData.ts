import type {
  Conversation,
  ConversationBlock,
  ConversationChild,
  ConversationPositionWindow,
  ConversationSidebarGroup,
  ConversationSidebarResponse,
} from '../api';

export type ConversationWithDetails = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
  parent: ConversationPositionWindow['parent'];
  position_window: {
    revision: number;
    source_version_id: string | null;
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

export type ConversationTranscriptData = {
  conversation: Conversation;
  body_source: ConversationPositionWindow['body_source'];
  source_version_id: string | null;
  children: ConversationChild[];
  parent: ConversationPositionWindow['parent'];
  revision: number;
  total: number;
  loaded_intervals: ConversationLoadedInterval[];
  start_reached: boolean;
  end_reached: boolean;
  after_count: number;
  blocks: ConversationBlock[];
};

export type ConversationTranscriptConsumer = {
  conversationId: string;
  sourceVersionId: string | null;
  historyLoading: boolean;
  total: number;
  loadedIntervals: readonly ConversationLoadedInterval[];
  hasOlder: boolean;
  hasNewer: boolean;
  unmaterializedAfterCount: number;
  loadOlder: () => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>;
  loadNewer: () => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>;
  loadAround: (position: number) => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>;
};

export type ConversationHistoryLoadResult = 'loaded' | 'covered' | 'busy' | 'failed';

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
  return {
    conversation: payload.conversation,
    body_source: payload.body_source,
    source_version_id: payload.source_version_id,
    children: payload.children,
    parent: payload.parent,
    revision: payload.revision,
    total: payload.total,
    loaded_intervals: intervalForWindow(payload),
    start_reached: !payload.window.has_before,
    end_reached: !payload.window.has_after,
    after_count: payload.window.after_count,
    blocks: payload.blocks,
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
      total: payload.total,
      loaded_intervals: payload.loaded_intervals,
      has_before: !payload.start_reached,
      has_after: !payload.end_reached,
      after_count: payload.after_count,
    },
  };
}

function mergeBlocks(current: readonly ConversationBlock[], incoming: readonly ConversationBlock[]): ConversationBlock[] {
  const byId = new Map<string, ConversationBlock>();
  for (const block of current) byId.set(block.id, block);
  for (const block of incoming) {
    const existing = byId.get(block.id);
    // A same-version display refresh may be compact while the user has already
    // expanded this block. Keep the fetched payload until the source changes.
    if (block.details_loaded === false && existing && existing.details_loaded !== false) continue;
    byId.set(block.id, block);
  }
  return [...byId.values()].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export function reconcileConversationWindow(
  current: ConversationTranscriptData | undefined,
  incoming: ConversationPositionWindow,
): ConversationTranscriptData {
  if (!current || current.conversation.id !== incoming.conversation.id
      || current.source_version_id !== incoming.source_version_id) {
    return conversationTranscriptFromWindow(incoming);
  }
  const blocks = mergeBlocks(current.blocks, incoming.blocks);
  const total = Math.max(current.total, incoming.total);
  const incomingIntervals = intervalForWindow(incoming);
  const loadedIntervals = mergeLoadedIntervals([...current.loaded_intervals, ...incomingIntervals]);
  const first = loadedIntervals[0];
  const last = loadedIntervals.at(-1);
  const currentFirst = current.loaded_intervals[0];
  const currentLast = current.loaded_intervals.at(-1);
  const incomingFirst = incomingIntervals[0];
  const incomingLast = incomingIntervals.at(-1);
  const startReached = Boolean(first) && (
    (current.start_reached && currentFirst?.start === first.start)
    || (!incoming.window.has_before && incomingFirst?.start === first.start)
  );
  const incomingReachesCurrentEnd = incomingLast?.end === last?.end;
  const currentReachesMergedEnd = currentLast?.end === last?.end;
  const endReached = Boolean(last) && (
    (current.end_reached && currentReachesMergedEnd)
    || (!incoming.window.has_after && incomingReachesCurrentEnd)
  );
  return {
    ...current,
    conversation: { ...current.conversation, ...incoming.conversation },
    children: incoming.revision >= current.revision ? incoming.children : current.children,
    parent: incoming.revision >= current.revision ? incoming.parent : current.parent,
    body_source: incoming.body_source,
    revision: Math.max(current.revision, incoming.revision),
    total,
    blocks,
    loaded_intervals: loadedIntervals,
    start_reached: startReached,
    end_reached: endReached,
    after_count: incomingReachesCurrentEnd
      ? incoming.window.after_count
      : current.after_count,
  };
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
