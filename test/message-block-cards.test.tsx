
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestPlanIndex, parsePlanEntries } from '../ui/src/components/message-blocks/PlanBlock';
import { PermissionApprovalCard, permissionActionsForRequest } from '../ui/src/components/console/PermissionApprovalCard';
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

    render(<MessageGroup turn={turn} isStreaming={false} />);
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
      <MessageGroup turn={turn([block('one'), block('two')])} isStreaming getDisclosureExpanded={getDisclosureExpanded} />,
    );
    view.rerender(
      <MessageGroup turn={turn([block('one'), block('two'), block('three')])} isStreaming getDisclosureExpanded={getDisclosureExpanded} />,
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

  it('renders explicit four-way permission options when supplied by the backend', () => {
    const request: ConsolePermissionRequest = {
      id: 'p1',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      created_at: 0,
      expires_at: 1000,
      options: [
        { key: '1', label: 'Allow once', decision: 'allow' },
        { key: '2', label: 'Always allow', decision: 'allow_always' },
        { key: '3', label: 'Deny', decision: 'reject_once' },
        { key: '4', label: 'Always deny', decision: 'reject_always' },
      ],
    };
    render(<PermissionApprovalCard request={request} backendType="sdk" onRespond={() => undefined} />);
    expect(screen.getByText('Always deny')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('keeps only the latest plan snapshot visible in a turn', () => {
    const blocks = [
      { type: 'plan', text: '- [ ] Old item' },
      { type: 'text', text: 'Working' },
      { type: 'plan', text: '- [x] New item\n- [~] Active item' },
    ] as RenderedTurn['assistantEvent']['message']['content'];
    expect(latestPlanIndex(blocks)).toBe(2);
    expect(parsePlanEntries(blocks[2].text)).toEqual([
      { text: 'New item', status: 'completed' },
      { text: 'Active item', status: 'in_progress' },
    ]);

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

    render(<MessageGroup turn={turn} isStreaming={false} />);
    expect(screen.queryByText('Old item')).toBeNull();
    expect(screen.getByText('New item')).toBeTruthy();
    expect(screen.getByText('Active item')).toBeTruthy();
  });
});
