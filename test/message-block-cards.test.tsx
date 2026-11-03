// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from './helpers/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionActionsForRequest } from '../ui/src/components/console/PermissionApprovalCard';
import { ActivityGroup, ActivityRow } from '../ui/src/components/message-blocks/ActivityBlock';
import { chatRouteHref } from '../ui/src/chat/messageLinks';
import type { DisplayActivityItem } from '../src/presentation/types';
import { MessageGroup } from '../ui/src/components/stream-renderer/MessageGroup';
import type { ConsolePermissionRequest } from '../ui/src/api';
import type { RenderedTurn } from '../ui/src/components/stream-renderer/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('message action cards', () => {
  it('groups only maximal consecutive tool runs and keeps leaves independently foldable', () => {
    const blocks = [
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a' } },
      { type: 'tool_use', id: 'tool-2', name: 'exec_command', input: { cmd: 'npm test' } },
      { type: 'tool_use', id: 'tool-3', name: 'Read', input: { path: '/tmp/b' } },
      { type: 'text', text: 'Between runs' },
      { type: 'tool_use', id: 'tool-4', name: 'Read', input: { path: '/tmp/c' } },
    ] as RenderedTurn['assistantEvent']['message']['content'];
    const turn: RenderedTurn = {
      id: 'turn-tools',
      assistantEvent: {
        type: 'assistant', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content: blocks, usage: { input_tokens: 10, output_tokens: 5 } },
      },
      toolResults: new Map([
        ['tool-1', { type: 'tool_result', tool_use_id: 'tool-1', content: 'one' }],
        ['tool-2', { type: 'tool_result', tool_use_id: 'tool-2', content: 'two' }],
        ['tool-3', { type: 'tool_result', tool_use_id: 'tool-3', content: 'three' }],
        ['tool-4', { type: 'tool_result', tool_use_id: 'tool-4', content: 'four' }],
      ]),
    };

    render(<MessageGroup turn={turn} defaultThinkingExpanded={false} />);
    const disclosures = () => screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-expanded'));
    expect(disclosures()).toHaveLength(2);
    const [group, standalone] = disclosures();
    expect(group.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(group);
    const region = document.getElementById(group.getAttribute('aria-controls')!)!;
    const leaves = within(region).getAllByRole('button').filter((button) => button.hasAttribute('aria-expanded'));
    expect(leaves).toHaveLength(3);
    fireEvent.click(leaves[0]);
    expect(leaves[0].getAttribute('aria-expanded')).toBe('true');
    expect(leaves[1].getAttribute('aria-expanded')).toBe('false');
    expect(standalone.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a growing live tool run on the same persisted disclosure key', () => {
    const seen: string[] = [];
    const block = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: { path: `/tmp/${id}` } }) as const;
    const turn = (content: RenderedTurn['assistantEvent']['message']['content']): RenderedTurn => ({
      id: 'turn-growing',
      assistantEvent: {
        type: 'assistant', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content },
      },
      toolResults: new Map(),
    });
    const getDisclosureExpanded = (id: string) => {
      seen.push(id);
      return false;
    };
    const view = render(
      <MessageGroup turn={turn([block('one'), block('two')])} defaultThinkingExpanded={false} getDisclosureExpanded={getDisclosureExpanded} />,
    );
    view.rerender(
      <MessageGroup turn={turn([block('one'), block('two'), block('three')])} defaultThinkingExpanded={false} getDisclosureExpanded={getDisclosureExpanded} />,
    );
    expect(seen).toEqual(['tool-group:one', 'tool-group:one']);
  });

  it('gates permission decisions by backend capability when options are implicit', () => {
    const request: ConsolePermissionRequest = {
      id: 'p1',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      created_at: 0,
      expires_at: 1000,
    };
    expect(permissionActionsForRequest(request, 'sdk').map((action) => action.decision)).toEqual([
      'allow',
      'allow_always',
      'deny',
    ]);
    expect(permissionActionsForRequest(request, 'acp').map((action) => action.decision)).toEqual([
      'allow',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
  });

  it('keeps only the latest plan snapshot visible in a turn', () => {
    const blocks = [
      { type: 'plan', text: '- [ ] Old item' },
      { type: 'text', text: 'Working' },
      { type: 'plan', text: '- [x] New item\n- [~] Active item' },
    ] as RenderedTurn['assistantEvent']['message']['content'];
    const turn: RenderedTurn = {
      id: 'turn-1',
      assistantEvent: {
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: blocks,
        },
      },
      toolResults: new Map(),
    };

    render(<MessageGroup turn={turn} defaultThinkingExpanded={false} />);
    expect(screen.queryByText('Old item')).toBeNull();
    expect(screen.getByText('New item')).toBeTruthy();
    expect(screen.getByText('Active item')).toBeTruthy();
  });
});


it('opens explicit chat references directly and retains group disclosure and native link actions', () => {
  window.history.replaceState(null, '', '#/console?conversation=old&block=old-block&turn=old-turn&position=9&position_space=old-space&sidebar=hidden&agent_session=reader&preview=copy');
  const directive = (identity: 'threadId' | 'clientThreadId', id: string): DisplayActivityItem => ({
    type: 'provider-directive', directive: { kind: 'created-thread', identity, providerSessionId: id }, sessionId: 'source',
  });
  const items = [directive('threadId', 'server-child'), directive('clientThreadId', 'queued-child')];
  const toggle = vi.fn();
  render(<ActivityGroup items={items} onExpandedChange={toggle} renderMember={item => <ActivityRow item={item} onExpandedChange={toggle} />} />);
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Created chats', expanded: false }));
  expect(toggle).toHaveBeenCalledTimes(1);
  const links = screen.getAllByRole('link', { name: 'Created chat' });
  expect(links).toHaveLength(2);
  for (const [index, link] of links.entries()) {
    const route = new URL(link.getAttribute('href')!, 'https://example.test/');
    const params = new URLSearchParams(route.hash.split('?')[1]);
    expect(params.get('session')).toBe(index === 0 ? 'server-child' : 'queued-child');
    for (const stale of ['conversation', 'block', 'turn', 'position', 'position_space']) expect(params.has(stale)).toBe(false);
    expect(params.get('sidebar')).toBe('hidden');
    expect(params.get('agent_session')).toBe('reader');
    expect(params.get('preview')).toBe('copy');
    for (const event of [new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })]) {
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(link.hasAttribute('aria-expanded')).toBe(false);
  }
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(chatRouteHref({ type: 'conversation', id: 'other' }, window.location.hash)).toContain('conversation=other');
});


it('retains memory citation content while opening exact rollout references as chat links', () => {
  const item: DisplayActivityItem = { type: 'provider-directive', sessionId: 'source', directive: {
    kind: 'memory-citation', citations: [{ ref: 'MEMORY.md:10-12', note: 'Original citation' }], rolloutIds: ['first-rollout', 'second-rollout'],
  } };
  render(<ActivityRow item={item} />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  expect(screen.getByText('MEMORY.md:10-12')).toBeTruthy();
  expect(screen.getAllByRole('link', { name: 'Chat' }).map(link => new URLSearchParams(link.getAttribute('href')!.split('?')[1]).get('session')))
    .toEqual(['first-rollout', 'second-rollout']);
});
