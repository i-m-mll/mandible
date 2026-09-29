import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContext } from 'preact/hooks';

import {
  boundToolResultBlock,
  buildStreamState,
  conversationBlocksToStreamEvents,
  groupActivityItemsForDisplay,
  groupMessagesForDisplay,
  isRoutineActivityStatus,
  serializeConversationToMarkdown,
} from '../../ui/src/chat';
import { ChatSurface, shouldShowJumpToLatest } from '../../ui/src/chat/ChatSurface';
import type { ConversationTranscriptConsumer } from '../../ui/src/query/conversationData';
import { plainActivityHeader, presentActivityItems } from '../../ui/src/components/message-blocks/ActivityBlock';
import { MessageActions } from '../../ui/src/components/shared/MessageActions';
import { DetailPaneOverlayContext, DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell';
import type { StreamEvent, ToolResultContentBlock } from '../../ui/src/components/stream-renderer/types';
import type { ActivityItem, ChatItem } from '../../src/parsers/types';

function installBrowserStubs(): void {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
}

function user(text: string, id: string): StreamEvent {
  return {
    type: 'user',
    uuid: id,
    session_id: 's1',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantText(text: string, id: string): StreamEvent {
  return {
    type: 'assistant',
    uuid: id,
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  };
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function result(): StreamEvent {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 's1',
    duration_ms: 0,
    num_turns: 1,
    result: '',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    is_error: false,
  };
}

function canonicalItem<T extends ChatItem>(item: Omit<T, 'identity' | 'provenance' | 'content_completion'> & {
  ordinal: number;
  turn?: string;
}): T {
  const { ordinal, turn, ...rest } = item;
  return {
    ...rest,
    identity: {
      provider: 'codex', session_id: 'canonical-session', native_turn_id: turn,
      source_record_ordinal: ordinal, source_sub_block_ordinal: 0,
    },
    provenance: { source: 'verified-provider-transcript', provider: 'codex', source_event_type: 'test' },
    content_completion: 'complete',
  } as T;
}

function canonicalEvent(item: ChatItem, blockId: string): StreamEvent {
  return { type: 'chat:item', item, source: { blockId } };
}

function persistedBlock(id: string, item: ChatItem, timestamp?: string) {
  return {
    id,
    type: 'event' as const,
    content: 'provider-shaped content must not render',
    timestamp,
    metadata_json: JSON.stringify({ chat_item: item }),
  };
}

function ScrollOwnerProbe() {
  const context = useContext(DetailPaneOverlayContext);
  return <output data-testid="scroll-owner">{context?.scrollOwner?.className ?? ''}</output>;
}

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

describe('chat message stream render model', () => {
  it('lifts mixed provider directives into ordered activity groups with their source identity', () => {
    const directiveText = `Before.\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:10-12|note=[prior decision]\n</citation_entries>\n<rollout_ids>\n01a01212-fbc2-7480-a434-5f2ff69aca7b\n</rollout_ids>\n</oai-mem-citation>\n\nMiddle.\n\n::created-thread{threadId="thread-identity"}\n\n::created-thread{clientThreadId="client-identity"}\n\nAfter.\n\nLiteral ::created-thread{threadId="prose-example"} and \`::created-thread{threadId="inline-example"}\`.\n\n\`\`\`\n::created-thread{threadId="fenced-example"}\n\`\`\``;
    const event = assistantText(directiveText, 'directive-turn') as Extract<StreamEvent, { type: 'assistant' }>;
    event.message.content[0] = { type: 'text', text: directiveText, source: { blockId: 'answer-block' } };
    const state = buildStreamState([event]);
    const group = groupMessagesForDisplay(state.nodes)[0];
    const entries = groupActivityItemsForDisplay(group.nodes);
    const entryLabels = entries.map((entry) => {
      if (entry.kind === 'activity-group') return entry.nodes.map((node) => node.item.type === 'provider-directive' ? node.item.directive.kind : node.item.activity_kind);
      if (entry.node.kind === 'activity') return entry.node.item.type === 'provider-directive' ? entry.node.item.directive.kind : entry.node.item.activity_kind;
      if (entry.node.kind === 'assistant_turn') return entry.node.turn.assistantEvent.message.content.map((block) => block.type === 'text' ? block.text : block.type).join('');
      return entry.node.kind;
    });
    expect(entryLabels.slice(0, 4)).toEqual([
      'Before.\n\n',
      'memory-citation',
      '\n\nMiddle.\n\n',
      ['created-thread', 'created-thread'],
    ]);
    expect(entryLabels[4]).toContain('\n\nAfter.');

    const activityItems = entries.flatMap((entry) => entry.kind === 'activity-group'
      ? entry.nodes.map((node) => node.item)
      : entry.kind === 'node' && entry.node.kind === 'activity' ? [entry.node.item] : []);
    expect(activityItems).toMatchObject([
      { type: 'provider-directive', directive: { kind: 'memory-citation', citations: [{ ref: 'MEMORY.md:10-12', note: 'prior decision' }] }, blockId: 'answer-block' },
      { type: 'provider-directive', directive: { kind: 'created-thread', identity: 'threadId', providerSessionId: 'thread-identity' }, blockId: 'answer-block' },
      { type: 'provider-directive', directive: { kind: 'created-thread', identity: 'clientThreadId', providerSessionId: 'client-identity' }, blockId: 'answer-block' },
    ]);
    const retainedProse = entries.flatMap((entry) => entry.kind === 'node' && entry.node.kind === 'assistant_turn'
      ? entry.node.turn.assistantEvent.message.content.filter((block) => block.type === 'text').map((block) => block.text)
      : []).join('');
    expect(retainedProse).toContain('Literal ::created-thread{threadId="prose-example"}');
    expect(retainedProse).toContain('`::created-thread{threadId="inline-example"}`');
    expect(retainedProse).toContain('::created-thread{threadId="fenced-example"}');

    const navigate = vi.fn();
    const view = render(
      <ChatSurface
        events={[event]}
        streaming={false}
        sessionInfo={{ sessionId: 'provider-directives' }}
        onCreatedTaskNavigate={navigate}
      />,
    );
    const renderedFlow = view.container.querySelector('.turn-group__body')!.textContent ?? '';
    const flowOrder = ['Before.', 'Used memory', 'Middle.', 'Created task', 'After.'];
    const flowPositions = flowOrder.map((text) => renderedFlow.indexOf(text));
    expect(flowPositions.every((position) => position >= 0)).toBe(true);
    expect(flowPositions).toEqual([...flowPositions].sort((left, right) => left - right));
    fireEvent.click(screen.getByRole('button', { name: /Created task/i }));
    const details = view.container.querySelector('.activity-group__members')!;
    within(details).getAllByRole('button', { name: /Created task/i }).forEach((row) => fireEvent.click(row));
    const links = within(details).getAllByRole('button', { name: /Open created task/ });
    expect(links.map((link) => link.getAttribute('data-provider-session-id'))).toEqual(['thread-identity', 'client-identity']);
    expect(links.map((link) => link.getAttribute('data-provider-session-identity'))).toEqual(['threadId', 'clientThreadId']);
    fireEvent.click(links[0]);
    fireEvent.click(links[1]);
    expect(navigate.mock.calls).toEqual([['thread-identity'], ['client-identity']]);
  });

  it('preserves the stable logical turn id when a bounded window starts mid-turn', () => {
    const events = conversationBlocksToStreamEvents('session', [persistedBlock(
      'visible-middle-block',
      canonicalItem({ type: 'message', role: 'assistant', parts: [{ type: 'text', text: 'middle' }], ordinal: 0, turn: 'stable-turn-start' }),
    )]);
    const state = buildStreamState(events);
    expect(state.nodes[0]).toMatchObject({ kind: 'assistant_turn', key: 'stable-turn-start' });
  });

  it('keeps distant loaded ranges in separate turn fragments', () => {
    const item = (ordinal: number) => canonicalItem({
      type: 'message', role: 'assistant', parts: [{ type: 'text', text: `part ${ordinal}` }],
      ordinal, turn: 'same-provider-turn',
    });
    const events = conversationBlocksToStreamEvents('session', [
      { ...persistedBlock('first', item(1)), position: 1 },
      { ...persistedBlock('distant', item(10)), position: 10 },
    ]);
    const nodes = buildStreamState(events).nodes;
    expect(nodes.map((node) => node.kind)).toEqual(['assistant_turn', 'assistant_turn']);
    expect(nodes[0].key).not.toBe(nodes[1].key);
  });

  it('groups consecutive same-speaker nodes before rendering and serializes markdown', () => {
    const state = buildStreamState([
      user('first', 'u1'),
      user('second', 'u2'),
      assistantText('answer one', 'a1'),
      assistantText('answer two', 'a2'),
    ]);

    const groups = groupMessagesForDisplay(state.nodes);
    expect(groups.map((group) => ({ speaker: group.speaker, count: group.nodes.length }))).toEqual([
      { speaker: 'user', count: 2 },
      { speaker: 'assistant', count: 2 },
    ]);
    expect(groups[1].meta.totalTokens).toBe(6);

    expect(serializeConversationToMarkdown(state.nodes)).toContain('## User\n\nfirst');
    expect(serializeConversationToMarkdown(state.nodes)).toContain('## Assistant\n\nanswer two');
  });

  it('keeps downstream same-speaker row keys stable across prepends and bounds each row', () => {
    const events = Array.from({ length: 25 }, (_, index) => user(`prompt ${index}`, `u${index}`));
    const before = groupMessagesForDisplay(buildStreamState(events).nodes);
    const after = groupMessagesForDisplay(buildStreamState([
      user('older 0', 'older-0'),
      user('older 1', 'older-1'),
      user('older 2', 'older-2'),
      ...events,
    ]).nodes);

    expect(before.every((group) => group.nodes.length <= 12)).toBe(true);
    expect(after.every((group) => group.nodes.length <= 12)).toBe(true);
    expect(after.slice(-2).map((group) => group.id)).toEqual(before.slice(-2).map((group) => group.id));
  });

  it('bounds large tool result text before DOM delivery', () => {
    const fullText = `${'x'.repeat(13000)}TAIL-MARKER`;
    const bounded = boundToolResultBlock({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: fullText,
    });

    expect(bounded.truncated).toBe(true);
    expect(String(bounded.content)).not.toContain('TAIL-MARKER');
    expect(bounded.fullText).toContain('TAIL-MARKER');
  });

  it('uses canonical ChatItem metadata for all four variants', () => {
    const items: ChatItem[] = [
      canonicalItem({ type: 'message', role: 'user', parts: [{ type: 'text', text: 'canonical prompt' }], ordinal: 0 }),
      canonicalItem({ type: 'plan', role: 'assistant', parts: [{ type: 'text', text: 'canonical plan' }], ordinal: 1, turn: 't1' }),
      canonicalItem({ type: 'tool-call', role: 'assistant', phase: 'call', tool_id: 'tool-1', tool_name: 'Read', input: { path: 'a.ts' }, parts: [], ordinal: 2, turn: 't1' }),
      canonicalItem({ type: 'tool-call', role: 'tool', phase: 'result', tool_id: 'tool-1', output: 'file body', parts: [], ordinal: 3, turn: 't1' }),
      canonicalItem({ type: 'activity', role: 'assistant', activity_kind: 'status', parts: [{ type: 'text', text: 'canonical status' }], ordinal: 4, turn: 't1' }),
    ];
    const blocks = items.map((item, index) => ({
      id: `b${index}`,
      type: 'event' as const,
      content: 'legacy content must not render',
      metadata_json: JSON.stringify({ chat_item: item }),
    }));
    const state = buildStreamState(conversationBlocksToStreamEvents('ignored-provider-session', blocks));

    expect(state.nodes.map((node) => node.kind)).toEqual(['user_message', 'assistant_turn', 'activity']);
    expect(state.nodes[0]).toMatchObject({ kind: 'user_message', text: 'canonical prompt' });
    const turn = state.nodes[1].kind === 'assistant_turn' ? state.nodes[1].turn : null;
    expect(turn?.assistantEvent.message.content.map((block) => block.type)).toEqual(['plan', 'tool_use']);
    expect(turn?.toolResults.get('tool-1')).toMatchObject({ content: 'file body' });
    expect(state.nodes[2]).toMatchObject({ kind: 'activity', item: { activity_kind: 'status' } });
  });

  it('groups only consecutive same-kind activities inside known turn boundaries', () => {
    const activities = [
      canonicalItem<ActivityItem>({ type: 'activity', role: 'assistant', activity_kind: 'thinking', parts: [], ordinal: 0, turn: 't1' }),
      canonicalItem<ActivityItem>({ type: 'activity', role: 'assistant', activity_kind: 'thinking', parts: [], ordinal: 1, turn: 't1' }),
      canonicalItem<ActivityItem>({ type: 'activity', role: 'assistant', activity_kind: 'status', parts: [], ordinal: 2, turn: 't1' }),
      canonicalItem<ActivityItem>({ type: 'activity', role: 'assistant', activity_kind: 'status', parts: [], ordinal: 3, turn: 't2' }),
    ];
    const nodes = buildStreamState(activities.map((item, index) => canonicalEvent(item, `a${index}`))).nodes;
    expect(groupActivityItemsForDisplay(nodes).map((entry) => entry.kind)).toEqual([
      'activity-group', 'node', 'node',
    ]);
  });

  it('groups reasoning summaries and thinking under Thought while preserving the short label', () => {
    const thought = (ordinal: number, text: string, kind: 'thinking' | 'reasoning-summary'): ActivityItem => canonicalItem<ActivityItem>({
      type: 'activity', role: 'assistant', activity_kind: kind,
      parts: [{ type: 'text', text }], ordinal, turn: 'thought-turn',
    });
    const events = [
      canonicalEvent(thought(0, 'Reviewing history limits', 'reasoning-summary'), 'thought-one'),
      canonicalEvent(thought(1, 'private thought two', 'thinking'), 'thought-two'),
    ];
    const nodes = buildStreamState(events).nodes;
    expect(groupActivityItemsForDisplay(nodes).map((entry) => entry.kind)).toEqual(['activity-group']);

    const view = render(<ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'thought-activity' }} />);
    const summary = screen.getByRole('button', { name: 'Thought' });
    expect(summary.textContent).toBe('Thought');
    expect(summary.querySelector('.compact-activity__icon svg path[fill="#FFD76A"]')).toBeTruthy();
    expect(view.container.textContent).not.toContain('private thought');
    fireEvent.click(summary);
    expect(screen.getByText('Reviewing history limits')).toBeTruthy();
    expect(screen.getByText('private thought two')).toBeTruthy();
  });

  it('preserves distinct reasoning identities while folding exact-adjacent visible duplicates', () => {
    const reasoning = (ordinal: number, nativeId: string): ActivityItem => {
      const item = canonicalItem<ActivityItem>({
        type: 'activity', role: 'assistant', activity_kind: 'reasoning-summary', ordinal, turn: 't1',
        parts: [
          { type: 'text', text: 'Reviewing item identity handling', native_index: 0 },
          { type: 'text', text: 'Refining missing identity error handling', native_index: 1 },
        ],
      });
      item.identity.native_item_id = nativeId;
      return item;
    };
    const items = [reasoning(644, 'reasoning-one'), reasoning(646, 'reasoning-two')];
    const nodes = buildStreamState(items.map((item, index) => canonicalEvent(item, `reasoning-${index}`))).nodes;
    expect(nodes.map((node) => node.key)).toEqual([
      'codex:canonical-session:reasoning-one:item',
      'codex:canonical-session:reasoning-two:item',
    ]);
    const entry = groupActivityItemsForDisplay(nodes)[0];
    expect(entry).toMatchObject({ kind: 'activity-group', key: 'activity:codex:canonical-session:reasoning-one:item' });
    const presentations = presentActivityItems(items);
    expect(presentations).toHaveLength(1);
    expect(presentations[0]).toMatchObject({
      summary: 'Reviewing item identity handling',
      details: ['Refining missing identity error handling'],
    });
    expect(presentations[0].members.map((item) => item.identity.native_item_id)).toEqual(['reasoning-one', 'reasoning-two']);

    const changed = reasoning(647, 'reasoning-three');
    changed.parts[1].text = 'Different detail';
    expect(presentActivityItems([items[0], changed])).toHaveLength(2);
    changed.parts[1].text = items[0].parts[1].text;
    changed.severity = 'warning';
    expect(presentActivityItems([items[0], changed])).toHaveLength(2);
    changed.severity = undefined;
    changed.identity.session_id = 'different-session';
    expect(presentActivityItems([items[0], changed])).toHaveLength(2);
  });

  it('hides only empty routine Codex start and completion status', () => {
    const status = (
      ordinal: number,
      sourceEventType: string,
      value: string,
      text = '',
      fields: Partial<Pick<ActivityItem, 'severity' | 'execution_outcome'>> = {},
    ): ActivityItem => {
      const item = canonicalItem<ActivityItem>({
        type: 'activity', role: 'system', activity_kind: 'status', status: value,
        parts: text ? [{ type: 'text', text }] : [], ordinal, turn: `t${ordinal}`, ...fields,
      });
      item.provenance.source_event_type = sourceEventType;
      return item;
    };
    const routineStart = status(0, 'task_started', 'started');
    const routineComplete = status(1, 'task_complete', 'complete');
    const authoredStart = status(2, 'task_started', 'started', 'Preparing the workspace');
    const warningComplete = status(3, 'task_complete', 'complete', '', { severity: 'warning' });
    const failedComplete = status(4, 'task_complete', 'complete', '', { execution_outcome: 'failed' });
    const compacted = status(5, 'context_compacted', 'compacted');
    const claudeStatus = status(6, 'status', 'complete');
    claudeStatus.provenance.provider = 'claude_code';
    claudeStatus.identity.provider = 'claude_code';

    expect(isRoutineActivityStatus(routineStart)).toBe(true);
    expect(isRoutineActivityStatus(routineComplete)).toBe(true);
    expect([authoredStart, warningComplete, failedComplete, compacted, claudeStatus]
      .every((item) => !isRoutineActivityStatus(item))).toBe(true);
    expect(buildStreamState([
      routineStart, routineComplete, authoredStart, warningComplete, failedComplete, compacted, claudeStatus,
    ].map((item, index) => canonicalEvent(item, `status-${index}`))).nodes).toHaveLength(5);
  });
});

describe('ChatSurface stream behavior', () => {
  it('keeps a long structured transcript virtualized at the loaded tail', async () => {
    const total = 12_060;
    const firstLoaded = total - 160;
    const loadAround = vi.fn(() => Promise.resolve('covered' as const));
    const transcript: ConversationTranscriptConsumer = {
      conversationId: 'long-structure', sourceVersionId: 'version-1', historyLoading: false,
      total, loadedIntervals: [{ start: firstLoaded, end: total - 1 }],
      structure: {
        conversation_id: 'long-structure', source_version_id: 'version-1', total,
        rows: Array.from({ length: total }, (_, position) => ({
          id: `b${position}`, position, type: 'user_message', role: 'user',
          parent_position: null, record_offset: position * 1000, record_length: 1000,
        })),
      },
      hasOlder: true, hasNewer: false, unmaterializedAfterCount: 0,
      loadOlder: vi.fn(), loadNewer: vi.fn(), loadAround,
    };
    const events = Array.from({ length: 160 }, (_, index) => ({
      ...canonicalEvent(canonicalItem({
        type: 'message', role: 'user', parts: [{ type: 'text', text: `message ${index}` }],
        ordinal: firstLoaded + index,
      }), `b${firstLoaded + index}`),
      source: { blockId: `b${firstLoaded + index}`, position: firstLoaded + index },
    }));
    const view = render(<ChatSurface events={events} streaming={false} transcript={transcript} />);
    expect(view.container.querySelectorAll('[data-virtual-kind="group"]').length).toBeLessThan(30);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadAround).not.toHaveBeenCalled();
  });

  it('loads a visible missing range without presenting it as an empty conversation', async () => {
    const transcript: ConversationTranscriptConsumer = {
      conversationId: 'gap-conversation',
      sourceVersionId: 'version-1',
      historyLoading: false,
      total: 10,
      structure: null,
      loadedIntervals: [{ start: 0, end: 2 }, { start: 7, end: 9 }],
      hasOlder: false,
      hasNewer: false,
      unmaterializedAfterCount: 0,
      loadOlder: vi.fn(),
      loadNewer: vi.fn(),
      loadAround: vi.fn(),
    };
    render(<ChatSurface events={[user('prompt', 'u1')]} streaming={false} transcript={transcript} />);

    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(document.querySelector('[data-virtual-kind="history"]')).toBeTruthy();
    await waitFor(() => expect(transcript.loadAround).toHaveBeenCalled());
    const requested = vi.mocked(transcript.loadAround).mock.calls[0][0];
    expect(requested).toBeGreaterThanOrEqual(3);
    expect(requested).toBeLessThanOrEqual(6);
  });

  it('rechecks the remaining gap when coverage advances without readable rows', async () => {
    const loadAround = vi.fn(() => Promise.resolve('loaded' as const));
    const consumer = (start: number): ConversationTranscriptConsumer => ({
      conversationId: 'moving-gap',
      sourceVersionId: 'version-1',
      historyLoading: false,
      total: 10,
      structure: null,
      loadedIntervals: [{ start, end: 9 }],
      hasOlder: true,
      hasNewer: false,
      unmaterializedAfterCount: 0,
      loadOlder: vi.fn(),
      loadNewer: vi.fn(),
      loadAround,
    });
    const view = render(
      <ChatSurface events={[user('only readable row', 'u1')]} streaming={false} transcript={consumer(8)} />,
    );
    await waitFor(() => expect(loadAround).toHaveBeenCalled());
    const callsBefore = loadAround.mock.calls.length;

    view.rerender(
      <ChatSurface events={[user('only readable row', 'u1')]} streaming={false} transcript={consumer(4)} />,
    );
    await waitFor(() => expect(loadAround.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(loadAround.mock.calls.at(-1)?.[0]).toBeLessThanOrEqual(3);
  });

  it('persists a canonical reading anchor instead of a raw scroll offset', () => {
    const view = render(
      <ChatSurface events={[canonicalEvent(canonicalItem({
        type: 'message', role: 'user', parts: [{ type: 'text', text: 'anchored' }], ordinal: 4,
      }), 'persisted-anchor')]} streaming={false} sessionInfo={{ sessionId: 'reading-anchor' }} />,
    );
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    fireEvent.wheel(scroll);
    fireEvent.scroll(scroll);
    const stored = JSON.parse(localStorage.getItem('mandible:chat-scroll:reading-anchor')!);

    expect(stored).toMatchObject({ version: 1, blockId: 'persisted-anchor' });
    expect(stored).toHaveProperty('itemId');
    expect(stored).toHaveProperty('viewportOffset');
  });

  it('renders mixed prose and activity without event-specific spacing state', () => {
    const mixedTurn: StreamEvent = {
      type: 'assistant',
      uuid: 'mixed-turn',
      session_id: 's1',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Prose before activity' },
          { type: 'thinking', thinking: 'Reasoning activity' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a' } },
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: { path: '/tmp/b' } },
          { type: 'text', text: 'Prose after activity' },
        ],
      },
    };
    const activity = (ordinal: number, text: string): ActivityItem => canonicalItem<ActivityItem>({
      type: 'activity', role: 'assistant', activity_kind: 'reasoning-summary',
      parts: [{ type: 'text', text }], ordinal, turn: `activity-${ordinal}`,
    });
    const view = render(<ChatSurface events={[
      mixedTurn,
      canonicalEvent(activity(0, 'Outer activity before prose'), 'outer-activity-1'),
      assistantText('Outer prose', 'outer-prose'),
      canonicalEvent(activity(1, 'Outer activity after prose'), 'outer-activity-2'),
    ]} streaming={false} sessionInfo={{ sessionId: 'mixed-boundaries' }} />);

    expect(screen.getByRole('button', { name: 'Read some files, thought' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read some files, thought' }));
    const mixedDetails = view.container.querySelector('.activity-group__members')!;
    expect(mixedDetails.querySelectorAll('.tool-card')).toHaveLength(2);
    expect(mixedDetails.querySelectorAll('.thinking-block')).toHaveLength(1);
    const renderedText = view.container.querySelector('.turn-group__body')!.textContent ?? '';
    const orderedLabels = ['Prose before activity', 'Read some files, thought', 'Prose after activity', 'Outer activity before prose', 'Outer prose', 'Outer activity after prose'];
    const positions = orderedLabels.map((label) => renderedText.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(view.container.querySelector('[class*="chat-boundary--"]')).toBeNull();
  });

  it('renders one compact activity row and an accessible stable disclosure for a run', () => {
    const activity = (ordinal: number, text: string, severity?: ActivityItem['severity']): ActivityItem => canonicalItem<ActivityItem>({
      type: 'activity', role: 'assistant', activity_kind: 'diagnostic', severity,
      execution_outcome: severity === 'error' ? 'failed' : undefined,
      status: severity === 'warning' ? 'action required' : undefined,
      parts: [{ type: 'text', text }], ordinal, turn: 't1',
    });
    const single = render(<ChatSurface events={[canonicalEvent(activity(0, '<img src=x onerror=alert(1)>'), 'a0')]} streaming={false} sessionInfo={{ sessionId: 'single-activity' }} />);
    expect(screen.queryByRole('button', { name: /Diagnostic/ })).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(single.container.querySelector('img')).toBeNull();
    single.unmount();

    const { rerender } = render(<ChatSurface events={[
      canonicalEvent(activity(1, 'check one', 'warning'), 'a1'),
      canonicalEvent(activity(2, 'check two', 'error'), 'a2'),
    ]} streaming={false} sessionInfo={{ sessionId: 'activity-run' }} />);
    const summary = screen.getByRole('button', { name: /check one.*warning.*action required.*error.*failed/i });
    expect(summary.textContent).not.toContain('Diagnostic');
    expect(summary.querySelector('.compact-activity__icon svg')).toBeTruthy();
    expect(summary.lastElementChild?.classList.contains('compact-activity__chevron')).toBe(true);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    const controlledRegion = summary.getAttribute('aria-controls');
    expect(controlledRegion).toBeTruthy();
    expect(screen.queryByText('check two')).toBeNull();
    fireEvent.click(summary);
    expect(document.getElementById(controlledRegion!)?.getAttribute('role')).toBe('region');
    expect(screen.getByText(/check two/)).toBeTruthy();
    expect(document.querySelector('[data-member-refs="a1 a2"]')).toBeTruthy();

    rerender(<ChatSurface events={[
      canonicalEvent(activity(1, 'check one', 'warning'), 'a1'),
      canonicalEvent(activity(2, 'check two', 'error'), 'a2'),
      canonicalEvent(activity(3, 'check three'), 'a3'),
    ]} streaming={false} sessionInfo={{ sessionId: 'activity-run' }} />);
    expect(screen.getByRole('button', { name: /check one.*failed/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/check three/)).toBeTruthy();
  });

  it('renders provider formatting as inert flush-left reasoning text without a provider mark', () => {
    const item = canonicalItem<ActivityItem>({
      type: 'activity', role: 'assistant', activity_kind: 'reasoning-summary',
      parts: [{ type: 'text', text: '**Checked** the __typed__ status payload' }], ordinal: 0,
    });
    const view = render(<ChatSurface events={[canonicalEvent(item, 'plain-activity')]} streaming={false} sessionInfo={{ sessionId: 'plain-activity' }} />);
    expect(screen.getByText('Checked the typed status payload')).toBeTruthy();
    expect(view.container.textContent).not.toContain('**');
    expect(view.container.textContent).not.toContain('__');
    expect(view.container.querySelector('.compact-activity__icon svg path[fill="#FFD76A"]')).toBeTruthy();
    expect(view.container.querySelector('.compact-activity__row--no-icon')).toBeNull();
    expect(view.container.querySelector('strong')).toBeNull();
    expect(plainActivityHeader('**Header**\nMore **provider-authored words**')).toBe('Header\nMore provider-authored words');
    expect(plainActivityHeader('value__name__suffix and 2 ** 3')).toBe('value__name__suffix and 2 ** 3');
  });

  it('keeps activity expansion stable from a live singleton into a durable folded group', () => {
    const reasoning = (ordinal: number, nativeId: string): ActivityItem => {
      const item = canonicalItem<ActivityItem>({
        type: 'activity', role: 'assistant', activity_kind: 'reasoning-summary', ordinal, turn: 'turn-reasoning',
        parts: [
          { type: 'text', text: 'Reviewing item identity handling' },
          { type: 'text', text: 'Refining missing identity error handling' },
        ],
      });
      item.identity.native_item_id = nativeId;
      return item;
    };
    const first = reasoning(0, 'reasoning-one');
    const view = render(<ChatSurface
      events={[canonicalEvent(first, 'live-one')]}
      streaming
      sessionInfo={{ sessionId: 'reasoning-growth' }}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewing item identity handling' }));
    expect(screen.getByText('Refining missing identity error handling')).toBeTruthy();

    view.rerender(<ChatSurface
      events={[canonicalEvent(first, 'durable-one'), canonicalEvent(reasoning(1, 'reasoning-two'), 'durable-two')]}
      streaming={false}
      sessionInfo={{ sessionId: 'reasoning-growth' }}
    />);
    expect(screen.getByRole('button', { name: 'Thought' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText('Refining missing identity error handling')).toHaveLength(1);
    expect(view.container.querySelector('[data-member-refs="durable-one durable-two"]')).toBeTruthy();
  });

  it('uses a distance-plus-viewport threshold distinct from the follow threshold', () => {
    expect(shouldShowJumpToLatest(79, 800)).toBe(false);
    expect(shouldShowJumpToLatest(800, 800)).toBe(false);
    expect(shouldShowJumpToLatest(1200, 800)).toBe(false);
    expect(shouldShowJumpToLatest(1201, 800)).toBe(true);
    expect(shouldShowJumpToLatest(1501, 1200)).toBe(true);
  });

  it('windows large conversations to a bounded DOM row count', () => {
    const events: StreamEvent[] = [];
    for (let i = 0; i < 520; i += 1) {
      events.push(user(`prompt ${i}`, `u${i}`));
      events.push(assistantText(`answer ${i}`, `a${i}`));
    }

    const { container } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'large' }} />,
    );

    expect(groupMessagesForDisplay(buildStreamState(events).nodes).length).toBe(1040);
    expect(container.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('registers the bounded transcript as the shell scroll and overlay measurement owner', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    render(
      <DetailPaneShell header={<span>Conversation</span>} overlayControl={<div>Composer</div>}>
        <ChatSurface events={[user('prompt', 'u1')]} streaming={false} sessionInfo={{ sessionId: 'owner' }} />
        <ScrollOwnerProbe />
      </DetailPaneShell>,
    );

    await waitFor(() => expect(screen.getByTestId('scroll-owner').textContent).toContain('stream-renderer__scroll'));
  });

  it('preserves a visible stable-key anchor when an older page is prepended', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
      return this.classList.contains('stream-renderer__scroll') ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
      if (!this.classList.contains('stream-renderer__scroll')) return 0;
      return Number.parseFloat(this.querySelector<HTMLElement>('.stream-renderer__virtual-canvas')?.style.height ?? '0');
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
        this.dispatchEvent(new Event('scroll'));
      },
    });
    const events = Array.from({ length: 40 }, (_, index) => [
      user(`prompt ${index}`, `u${index}`),
      assistantText(`answer ${index}`, `a${index}`),
    ]).flat();
    const { container, rerender } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'stable-anchor' }} />,
    );
    const scroll = container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    scroll.scrollTop = 2000;
    fireEvent.scroll(scroll);
    const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-virtual-key]'))
      .filter((row) => Number.parseFloat(row.style.transform.replace(/[^\d.-]/g, '')) <= scroll.scrollTop)
      .at(-1)!;
    const anchorKey = anchor.dataset.virtualKey!;
    const anchorStart = Number.parseFloat(anchor.style.transform.replace(/[^\d.-]/g, ''));
    const anchorInset = scroll.scrollTop - anchorStart;

    rerender(
      <ChatSurface
        events={[user('older prompt', 'older-u'), assistantText('older answer', 'older-a'), ...events]}
        streaming={false}
        sessionInfo={{ sessionId: 'stable-anchor' }}
      />,
    );

    await waitFor(() => {
      const preserved = Array.from(container.querySelectorAll<HTMLElement>('[data-virtual-key]'))
        .find((row) => row.dataset.virtualKey === anchorKey)!;
      const preservedStart = Number.parseFloat(preserved.style.transform.replace(/[^\d.-]/g, ''));
      expect(scroll.scrollTop - preservedStart).toBe(anchorInset);
    });
  });

  it('does not restore a stale anchor while the user is scrolling upward', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
      return this.classList.contains('stream-renderer__scroll') ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
      if (!this.classList.contains('stream-renderer__scroll')) return 0;
      return Number.parseFloat(this.querySelector<HTMLElement>('.stream-renderer__virtual-canvas')?.style.height ?? '0');
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const events = Array.from({ length: 40 }, (_, index) => [
      user(`prompt ${index}`, `u${index}`),
      assistantText(`answer ${index}`, `a${index}`),
    ]).flat();
    const { container, rerender } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'scrolling-anchor' }} />,
    );
    const scroll = container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    scroll.scrollTop = 2000;
    fireEvent.wheel(scroll, { deltaY: -100 });
    fireEvent.scroll(scroll);
    fireEvent.wheel(scroll, { deltaY: -100 });
    scroll.scrollTop = 1700;
    const previousScrollCalls = scrollTo.mock.calls.length;

    rerender(
      <ChatSurface
        events={[...events, user('new prompt', 'new-u')]}
        streaming={false}
        sessionInfo={{ sessionId: 'scrolling-anchor' }}
      />,
    );

    expect(scroll.scrollTop).toBe(1700);
    expect(scrollTo.mock.calls.length).toBe(previousScrollCalls);
  });

  it('does not jump down when a newly loaded group spanning the viewport is measured', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
      return this.classList.contains('stream-renderer__scroll') ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
      if (!this.classList.contains('stream-renderer__scroll')) return 0;
      return Number.parseFloat(this.querySelector<HTMLElement>('.stream-renderer__virtual-canvas')?.style.height ?? '0');
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
      if (this.classList.contains('stream-renderer__virtual-row')) {
        return domRect(0, 0, 600, /:(18|19):0/.test(this.dataset.virtualKey ?? '') ? 600 : 150);
      }
      return domRect(0, 0, 600, this.classList.contains('stream-renderer__scroll') ? 500 : 0);
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const structure = {
      conversation_id: 'measured-range', source_version_id: 'version-1', total: 30,
      rows: Array.from({ length: 30 }, (_, position) => ({
        id: `b${position}`, position, type: position % 2 ? 'assistant_message' : 'user_message',
        role: position % 2 ? 'assistant' : 'user',
        parent_position: null, record_offset: position * 1000, record_length: 1000,
      })),
    } as const;
    const transcript = (start: number): ConversationTranscriptConsumer => ({
      conversationId: 'measured-range', sourceVersionId: 'version-1', historyLoading: false,
      total: 30, structure, loadedIntervals: [{ start, end: 29 }],
      hasOlder: true, hasNewer: false, unmaterializedAfterCount: 0,
      loadOlder: vi.fn(), loadNewer: vi.fn(), loadAround: vi.fn(),
    });
    const events = (start: number) => Array.from({ length: 30 - start }, (_, index) => {
      const position = start + index;
      return {
        ...canonicalEvent(canonicalItem({
          type: 'message', role: position % 2 ? 'assistant' : 'user',
          parts: [{ type: 'text', text: `message ${position}` }],
          ordinal: position,
        }), `b${position}`),
        source: { blockId: `b${position}`, position },
      };
    });
    const view = render(<ChatSurface events={events(20)} streaming={false} transcript={transcript(20)} />);
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    scroll.scrollTop = 3600;
    fireEvent.wheel(scroll, { deltaY: -300 });
    scroll.scrollTop = 3300;
    fireEvent.scroll(scroll);
    expect(scroll.scrollTop).toBe(3300);
    const previousScrollCalls = scrollTo.mock.calls.length;

    view.rerender(<ChatSurface events={events(19)} streaming={false} transcript={transcript(19)} />);

    const loadedRow = Array.from(view.container.querySelectorAll<HTMLElement>('[data-virtual-kind="group"]'))
      .find((row) => row.dataset.virtualKey?.includes(':19:0'))!;
    expect(loadedRow).toBeTruthy();
    expect(Number.parseFloat(loadedRow.style.transform.replace(/[^\d.-]/g, ''))).toBeLessThan(3300);
    expect(scroll.scrollTop).toBe(3300);
    expect(scrollTo.mock.calls.length).toBe(previousScrollCalls);

    const rowStart = Number.parseFloat(loadedRow.style.transform.replace(/[^\d.-]/g, ''));
    const readingInset = scroll.scrollTop - rowStart;
    view.rerender(<ChatSurface events={events(18)} streaming={false} transcript={transcript(18)} />);
    const preservedRow = Array.from(view.container.querySelectorAll<HTMLElement>('[data-virtual-kind="group"]'))
      .find((row) => row.dataset.virtualKey?.includes(':19:0'))!;
    const preservedStart = Number.parseFloat(preservedRow.style.transform.replace(/[^\d.-]/g, ''));
    expect(scroll.scrollTop).toBeGreaterThan(3300);
    expect(scroll.scrollTop - preservedStart).toBeCloseTo(readingInset);
  });

  it('keeps a reading position when an unloaded gap resolves into messages', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function clientHeight() {
      return this.classList.contains('stream-renderer__scroll') ? 500 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function scrollHeight() {
      if (!this.classList.contains('stream-renderer__scroll')) return 0;
      return Number.parseFloat(this.querySelector<HTMLElement>('.stream-renderer__virtual-canvas')?.style.height ?? '0');
    });
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const total = 1_000;
    const structure = {
      conversation_id: 'gap-anchor', source_version_id: 'version-1', total,
      rows: Array.from({ length: total }, (_, position) => ({
        id: `b${position}`, position, type: 'user_message', role: 'user',
        parent_position: null, record_offset: position * 1000, record_length: 1000,
      })),
    } as const;
    const transcript = (withPage: boolean, withAdjacent = false): ConversationTranscriptConsumer => ({
      conversationId: 'gap-anchor', sourceVersionId: 'version-1', historyLoading: false,
      total, structure,
      loadedIntervals: [
        ...(withAdjacent ? [{ start: 400, end: 409 }] : []),
        ...(withPage ? [{ start: 500, end: 509 }] : []),
        { start: 900, end: 999 },
      ],
      hasOlder: true, hasNewer: false, unmaterializedAfterCount: 0,
      loadOlder: vi.fn(), loadNewer: vi.fn(), loadAround: vi.fn(),
    });
    const events = (withPage: boolean, withAdjacent = false) => [
      ...(withAdjacent ? Array.from({ length: 10 }, (_, index) => 400 + index) : []),
      ...(withPage ? Array.from({ length: 10 }, (_, index) => 500 + index) : []),
      ...Array.from({ length: 100 }, (_, index) => 900 + index),
    ].map((position) => {
      return {
        ...canonicalEvent(canonicalItem({
          type: 'message', role: 'user', parts: [{ type: 'text', text: `message ${position}` }],
          ordinal: position,
        }), `b${position}`),
        source: { blockId: `b${position}`, position },
      };
    });
    const view = render(<ChatSurface events={events(false)} streaming={false} transcript={transcript(false)} />);
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    scroll.scrollTop = 75_000;
    fireEvent.wheel(scroll, { deltaY: -100 });
    fireEvent.scroll(scroll);
    fireEvent(scroll, new Event('scrollend'));
    const saved = JSON.parse(localStorage.getItem('mandible:chat-scroll:default')!);
    expect(saved.position).toBeGreaterThanOrEqual(500);
    expect(saved.position).toBeLessThanOrEqual(509);
    expect(saved.followingTail).toBe(false);
    expect(saved.viewportOffset).toBeGreaterThan(-200);
    expect(saved.viewportOffset).toBeLessThanOrEqual(0);
    const previousScrollCalls = scrollTo.mock.calls.length;

    view.rerender(<ChatSurface events={events(false, true)} streaming={false} transcript={transcript(false, true)} />);
    expect(scroll.scrollTop).toBeGreaterThan(70_000);
    expect(scroll.scrollTop).toBeLessThan(80_000);
    expect(scrollTo.mock.calls.slice(previousScrollCalls).map(([options]) => options.top)
      .filter((top) => Number(top) > 80_000)).toEqual([]);
    const adjacentScrollCalls = scrollTo.mock.calls.length;

    view.rerender(<ChatSurface events={events(true, true)} streaming={false} transcript={transcript(true, true)} />);

    expect(view.container.querySelector(`[data-block-id="b${saved.position}"]`)).toBeTruthy();
    expect(scrollTo.mock.calls.slice(adjacentScrollCalls).map(([options]) => options.top)
      .filter((top) => Number(top) > 80_000)).toEqual([]);
    expect(scroll.scrollTop).toBeGreaterThan(70_000);
    expect(scroll.scrollTop).toBeLessThan(80_000);
  });

  it('anchors Chat-only message actions and restores focus on Escape', async () => {
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBounds() {
      if (this.classList.contains('message-actions__overflow')) return domRect(784, 566, 20, 24);
      if (this.classList.contains('message-actions__overflow-menu')) return domRect(0, 0, 180, 150);
      return domRect(0, 0, 0, 0);
    });
    render(
      <div>
        <button type="button">Outside target</button>
        <MessageActions onFork={vi.fn()} onResume={vi.fn()} onInfo={vi.fn()} dagUuid="dag-1" />
      </div>,
    );

    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    await waitFor(() => {
      expect(menu.style.position).toBe('fixed');
      expect(menu.style.left).toBe('612px');
      expect(menu.style.top).toBe('410px');
      expect(menu.style.visibility).toBe('visible');
    });
    expect(menu.classList.contains('app-anchored-menu')).toBe(true);
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);

    const outside = screen.getByRole('button', { name: 'Outside target' });
    outside.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('keeps action metadata supported without rendering it on hover surfaces', () => {
    render(
      <MessageActions
        onCopy={vi.fn()}
        metadata={{ tokenCount: 1234, elapsedMs: 5000, model: 'test-model', timestamp: '2026-01-02T03:04:05Z' }}
      />,
    );

    expect(screen.queryByText(/1,234 tokens/)).toBeNull();
    expect(screen.queryByText('5s')).toBeNull();
    expect(screen.queryByText('test-model')).toBeNull();
    expect(screen.queryByText(/2026/)).toBeNull();
    expect(document.querySelector('.message-actions__meta')).toBeNull();
    expect(readFileSync('ui/src/styles/console.css', 'utf8')).not.toContain('.message-actions__meta');
  });

  it('does not copy turn tokens or persisted timestamps onto ordinary row actions', () => {
    const events = conversationBlocksToStreamEvents('row-metadata', [
      persistedBlock('u1', canonicalItem({ type: 'message', role: 'user', parts: [{ type: 'text', text: 'Prompt' }], ordinal: 0 }), '2026-01-02T03:04:05Z'),
      persistedBlock('a1', canonicalItem({ type: 'message', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }], ordinal: 1, turn: 'a1' }), '2026-01-02T03:04:06Z'),
    ]);
    const view = render(<ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'row-metadata' }} />);

    const actionText = Array.from(view.container.querySelectorAll('.message-actions'))
      .map((actions) => actions.textContent)
      .join(' ');
    expect(actionText).not.toContain('tokens');
    expect(actionText).not.toContain('2026');
  });

  it('disengages scroll-follow while scrolled up and re-arms at bottom', () => {
    const events = [user('prompt', 'u1'), assistantText('answer', 'a1')];
    const { container, rerender } = render(
      <ChatSurface events={events} streaming sessionInfo={{ sessionId: 'scroll' }} />,
    );
    const scroll = container.querySelector('.stream-renderer__scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 9000, configurable: true });

    scroll.scrollTop = 1000;
    fireEvent.scroll(scroll);
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy();

    rerender(
      <ChatSurface
        events={[...events, assistantText('new answer', 'a2')]}
        streaming
        sessionInfo={{ sessionId: 'scroll' }}
      />,
    );
    expect(scroll.scrollTop).toBe(1000);

    scroll.scrollTop = 8500;
    fireEvent.scroll(scroll);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    scroll.scrollTop = 8480;
    fireEvent.scroll(scroll);
    rerender(
      <ChatSurface
        events={[...events, assistantText('new answer', 'a2'), assistantText('latest answer', 'a3')]}
        streaming
        sessionInfo={{ sessionId: 'scroll' }}
      />,
    );
    expect(scroll.scrollTop).toBe(8480);
  });

  it('does not re-arm tail follow from a correction during an upward wheel gesture', () => {
    const view = render(
      <ChatSurface events={[user('prompt', 'u1')]} streaming sessionInfo={{ sessionId: 'upward-correction' }} />,
    );
    const scroll = view.container.querySelector<HTMLElement>('.stream-renderer__scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 9000, configurable: true });
    scroll.scrollTop = 8500;
    fireEvent.wheel(scroll, { deltaY: -300 });
    scroll.scrollTop = 8200;
    fireEvent.scroll(scroll);
    fireEvent.wheel(scroll, { deltaY: -300 });
    scroll.scrollTop = 8490;
    fireEvent.scroll(scroll);

    const anchor = JSON.parse(localStorage.getItem('mandible:chat-scroll:upward-correction')!);
    expect(anchor.followingTail).toBe(false);
  });

  it('suppresses one-page local and unmaterialized displacement but exposes a distant tail', () => {
    const events = [user('prompt', 'u1'), assistantText('answer', 'a1')];
    const { container, rerender } = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'threshold' }} />,
    );
    const scroll = container.querySelector('.stream-renderer__scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(scroll, 'scrollHeight', { value: 1800, configurable: true });
    scroll.scrollTop = 200;
    fireEvent.scroll(scroll);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    rerender(
      <ChatSurface
        events={events}
        streaming={false}
        unmaterializedAfterCount={4}
        sessionInfo={{ sessionId: 'threshold' }}
      />,
    );
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();

    rerender(
      <ChatSurface
        events={events}
        streaming={false}
        unmaterializedAfterCount={10}
        sessionInfo={{ sessionId: 'threshold' }}
      />,
    );
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy();
  });

  it('materializes an exact turn before scrolling and honors reduced motion', () => {
    const events: StreamEvent[] = [];
    for (let i = 0; i < 80; i += 1) {
      events.push(user(`prompt ${i}`, `u${i}`));
      events.push(assistantText(`answer ${i}`, `a${i}`));
    }
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(30000);
    const scrollTo = vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Number(options.top ?? 0);
      this.dispatchEvent(new Event('scroll'));
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    render(
      <ChatSurface
        events={events}
        streaming={false}
        sessionInfo={{ sessionId: 'anchor' }}
        navigationTarget={{ key: 'anchor-a50', kind: 'turn', turnId: 'a50', smooth: true }}
      />,
    );

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    expect(scrollTo.mock.calls.at(-1)?.[0].top).toBeGreaterThan(0);
    expect(document.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('materializes and centers an exact persisted block anchor', async () => {
    const blocks = Array.from({ length: 80 }, (_, index) => ({
      id: `block-${index}`,
      type: 'event' as const,
      content: 'provider-shaped content must not render',
      timestamp: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00Z`,
      metadata_json: JSON.stringify({
        chat_item: canonicalItem({
          type: 'message',
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [{ type: 'text', text: `message ${index}` }],
          ordinal: index,
          ...(index % 2 === 1 ? { turn: `turn-${index}` } : {}),
        }),
      }),
    }));
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(30000);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
        this.dispatchEvent(new Event('scroll'));
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ChatSurface
        events={conversationBlocksToStreamEvents('history-anchor', blocks)}
        streaming={false}
        sessionInfo={{ sessionId: 'block-anchor' }}
        navigationTarget={{ key: 'block-anchor-51', kind: 'block', turnId: null, blockId: 'block-51', smooth: false }}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' }));
    const exactBlock = document.querySelector('[data-block-id="block-51"]');
    expect(exactBlock).toBeTruthy();
    expect(document.activeElement).toBe(exactBlock);
    expect(document.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('materializes and centers a far-off matched tool-result anchor', async () => {
    const blocks = Array.from({ length: 80 }, (_, index) => ([
      persistedBlock(`prompt-${index}`, canonicalItem({
        type: 'message', role: 'user', parts: [{ type: 'text', text: `prompt ${index}` }], ordinal: index * 3,
      }), `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00Z`),
      persistedBlock(`tool-${index}`, canonicalItem({
        type: 'tool-call', role: 'assistant', phase: 'call', tool_id: `call-${index}`, tool_name: 'Read', input: { path: `${index}.ts` }, parts: [], ordinal: index * 3 + 1, turn: `turn-${index}`,
      }), `2026-01-01T01:${String(index % 60).padStart(2, '0')}:00Z`),
      persistedBlock(`result-${index}`, canonicalItem({
        type: 'tool-call', role: 'tool', phase: 'result', tool_id: `call-${index}`, output: `result ${index}`, parts: [], ordinal: index * 3 + 2, turn: `turn-${index}`,
      }), `2026-01-01T02:${String(index % 60).padStart(2, '0')}:00Z`),
    ])).flat();
    const scrollIntoView = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(50000);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = Number(options.top ?? 0);
        this.dispatchEvent(new Event('scroll'));
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ChatSurface
        events={conversationBlocksToStreamEvents('matched-result-anchor', blocks)}
        streaming={false}
        sessionInfo={{ sessionId: 'matched-result-anchor' }}
        navigationTarget={{ key: 'matched-result-60', kind: 'block', turnId: null, blockId: 'result-60', smooth: false }}
      />,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' }));
    expect(document.querySelector('[data-block-id="result-60"]')).toBeTruthy();
    expect(document.querySelectorAll('.turn-group').length).toBeLessThan(40);
  });

  it('keeps the icon-only Jump control accessible and delegates true-end loading', () => {
    const jump = vi.fn();
    const { rerender } = render(
      <ChatSurface
        events={[user('prompt', 'u1')]}
        streaming={false}
        unmaterializedAfterCount={10}
        onJumpToLatest={jump}
        sessionInfo={{ sessionId: 'jump-keyboard' }}
      />,
    );
    const button = screen.getByRole('button', { name: /jump to latest/i });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Jump to latest');
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.getAttribute('title')).toBe('Jump to latest');
    expect(button.classList.contains('chat-circle-action')).toBe(true);
    const icon = button.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('focusable')).toBe('false');
    expect(button.textContent).toBe('');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(jump).toHaveBeenCalledTimes(1);

    rerender(
      <ChatSurface
        events={[user('prompt', 'u1')]}
        streaming={false}
        unmaterializedAfterCount={10}
        onJumpToLatest={jump}
        jumpingToLatest
        sessionInfo={{ sessionId: 'jump-keyboard' }}
      />,
    );
    const loadingButton = screen.getByRole('button', { name: 'Jump to latest' });
    expect(loadingButton.getAttribute('aria-busy')).toBe('true');
    expect(loadingButton).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('Loading latest…');
  });

  it('expands thinking while streaming and collapses it after resolution by default', () => {
    const thinking: StreamEvent = {
      type: 'assistant',
      uuid: 'a1',
      session_id: 's1',
      parent_tool_use_id: null,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Need to inspect state' }],
      },
    };

    const { rerender } = render(
      <ChatSurface events={[thinking]} streaming sessionInfo={{ sessionId: 'thinking' }} />,
    );
    expect(screen.getByText('Need to inspect state')).toBeTruthy();

    rerender(
      <ChatSurface events={[thinking, result()]} streaming={false} sessionInfo={{ sessionId: 'thinking' }} />,
    );
    expect(screen.getByText('Need to inspect state')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Need to inspect state' })).toBeNull();
  });

  it('keeps oversized tool output inside the expanded tool card scroll region', () => {
    const fullText = `${'line\n'.repeat(2600)}TAIL-MARKER`;
    const toolResult: ToolResultContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: fullText,
    };
    const events: StreamEvent[] = [
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      {
        type: 'user',
        uuid: 'tr1',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { role: 'user', content: [toolResult] },
      },
      result(),
    ];

    render(<ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'tool' }} />);

    expect(screen.queryByText(/TAIL-MARKER/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ran a command/ }));
    expect(document.querySelector('.tool-card__body .overflow-fade__scroll')).toBeTruthy();
    expect(screen.getByText(/TAIL-MARKER/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /open full/i })).toBeNull();
  });

  it('hydrates only the individually expanded tool nested inside a compact activity group', async () => {
    const onExpandDetails = vi.fn();
    const events: StreamEvent[] = [
      {
        type: 'assistant',
        uuid: 'tool-turn',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          id: 'tool-turn',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: '', source: { blockId: 'call-1', position: 0, detailsLoaded: false } },
            { type: 'tool_use', id: 'tool-2', name: 'Read', input: '', source: { blockId: 'call-2', position: 1, detailsLoaded: false } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'tool-results',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: '', source: { blockId: 'result-1', position: 2, detailsLoaded: false } },
            { type: 'tool_result', tool_use_id: 'tool-2', content: '', source: { blockId: 'result-2', position: 3, detailsLoaded: false } },
          ],
        },
      },
      result(),
    ];
    const view = render(
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'nested-tool-expansion' }} onExpandDetails={onExpandDetails} />,
    );

    const activityGroup = screen.getByRole('button', { name: 'Read some files' });
    expect(activityGroup.textContent).not.toContain('Running');
    fireEvent.click(activityGroup);
    expect(onExpandDetails).not.toHaveBeenCalled();

    const childRows = view.container.querySelectorAll('.activity-group__members .tool-card .compact-activity__row');
    expect(childRows).toHaveLength(2);
    expect(childRows[0].textContent).not.toContain('Running');
    fireEvent.click(childRows[0]);
    await waitFor(() => expect(onExpandDetails).toHaveBeenCalledTimes(1));
    expect(onExpandDetails.mock.calls[0][0].map((source: { blockId: string }) => source.blockId)).toEqual(['call-1', 'result-1']);
  });

  it('ignores legacy persisted chat disclosure state and starts tools folded', () => {
    localStorage.setItem('mandible:chat-expanded:tool-defaults', JSON.stringify({ 'a1:tool:tool-1': true }));
    const events: StreamEvent[] = [{
      type: 'assistant',
      uuid: 'a1',
      session_id: 's1',
      parent_tool_use_id: null,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
      },
    }, result()];

    render(<ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'tool-defaults' }} />);

    expect(screen.getByRole('button', { name: /Ran a command/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('renders persisted events and unmatched results through canonical selectable nodes', () => {
    const onToggle = vi.fn();
    const events = conversationBlocksToStreamEvents('codex-history', [
      persistedBlock('s1', canonicalItem({ type: 'message', role: 'system', parts: [{ type: 'text', text: 'System notice' }], ordinal: 0 }), '2026-01-02T03:04:05Z'),
      persistedBlock('e1', canonicalItem({ type: 'activity', role: 'system', activity_kind: 'diagnostic', severity: 'error', execution_outcome: 'failed', parts: [{ type: 'text', text: 'Stream failed' }], ordinal: 1 }), '2026-01-02T03:04:06Z'),
      persistedBlock('tu1', canonicalItem({ type: 'tool-call', role: 'assistant', phase: 'call', tool_id: 'paired', tool_name: 'Read', input: { path: 'a.ts' }, parts: [], ordinal: 2, turn: 'turn-1' }), '2026-01-02T03:04:06Z'),
      persistedBlock('tr-paired', canonicalItem({ type: 'tool-call', role: 'tool', phase: 'result', tool_id: 'paired', output: 'paired output', parts: [], ordinal: 3, turn: 'turn-1' }), '2026-01-02T03:04:06Z'),
      persistedBlock('tr1', canonicalItem({ type: 'tool-call', role: 'tool', phase: 'result', tool_id: 'missing', output: 'No matching request', execution_outcome: 'failed', parts: [], ordinal: 4 }), '2026-01-02T03:04:07Z'),
    ]);

    render(
      <ChatSurface
        events={events}
        streaming={false}
        sessionInfo={{ sessionId: 'persisted-semantics' }}
        selectMode
        selectedBlockIds={new Set(['e1', 'tr-paired'])}
        onToggleBlockSelect={onToggle}
      />,
    );

    expect(screen.getByText('System notice')).toBeTruthy();
    expect(screen.getByText(/Stream failed · error · failed/)).toBeTruthy();
    expect(screen.getByText('Unmatched tool error')).toBeTruthy();
    expect(screen.queryByText('Diagnostic')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Read a file/ }));
    expect(document.querySelector('[data-block-id="tr-paired"]')).toBeTruthy();
    expect(screen.queryByText(/2026/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Deselect message' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deselect message' })[1]);
    expect(onToggle).toHaveBeenCalledWith('tr-paired', false);
  });
});
