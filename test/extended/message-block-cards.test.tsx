import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { computeDiffStats } from '../../ui/src/components/message-blocks/FileEditBlock';
import { latestPlanIndex, parsePlanEntries } from '../../ui/src/components/message-blocks/PlanBlock';
import { getToolVisual, leftTruncateTarget, ToolUseBlock } from '../../ui/src/components/message-blocks/ToolUseBlock';
import { presentTool, summarizeToolRun } from '../../ui/src/components/message-blocks/toolPresentation';
import { PermissionApprovalCard, permissionActionsForRequest } from '../../ui/src/components/console/PermissionApprovalCard';
import { MessageGroup } from '../../ui/src/components/stream-renderer/MessageGroup';
import type { ConsolePermissionRequest } from '../../ui/src/api';
import type { RenderedTurn } from '../../ui/src/components/stream-renderer/types';

afterEach(() => cleanup());

describe('message action cards', () => {
  it('keeps assistant selection bare and gives both speakers one Markdown rhythm contract', () => {
    const consoleCss = readFileSync('ui/src/styles/console.css', 'utf8');
    const markdownCss = readFileSync('ui/src/styles/rendered-markdown.css', 'utf8');
    const messageCss = readFileSync('ui/src/styles/message-blocks.css', 'utf8');
    expect(consoleCss).toMatch(/\.stream-turn--selected\s*\{[^}]*border-left:\s*0;[^}]*background:\s*transparent;/s);
    expect(markdownCss).toContain('.rendered-markdown blockquote');
    expect(markdownCss).toContain('.rendered-markdown table');
    expect(markdownCss).toContain('.rendered-markdown li + li');
    expect(messageCss).toMatch(/\.user-bubble__text\s*\{[^}]*border-radius:[^}]*padding:/s);
    expect(messageCss).not.toContain('.msg-text-block blockquote');
    expect(messageCss).not.toContain('.user-bubble__text p');
  });

  it('maps provider and ACP tool names onto one visual vocabulary', () => {
    expect(getToolVisual('Read').kind).toBe('read');
    expect(getToolVisual('Edit').kind).toBe('edit');
    expect(getToolVisual('Bash').kind).toBe('execute');
    expect(getToolVisual('WebFetch').kind).toBe('fetch');
    expect(getToolVisual('mcp__github__search').kind).toBe('mcp');
    expect(getToolVisual('mcp__browser__navigate').kind).toBe('browser');
    expect(getToolVisual('web__run').kind).toBe('browser');
    expect(getToolVisual('switch_mode').kind).toBe('switch_mode');
  });

  it('left-truncates long targets while preserving the filename', () => {
    const target = '/Users/mll/Main/10 Projects/05 Utils/mandible/ui/src/components/message-blocks/ToolUseBlock.tsx';
    const truncated = leftTruncateTarget(target, 48);
    expect(truncated.startsWith('...')).toBe(true);
    expect(truncated.endsWith('/ToolUseBlock.tsx')).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(48);
  });

  it('classifies commands and browser calls into deterministic phrases and targets', () => {
    expect(presentTool('exec_command', { cmd: 'npm test' })).toMatchObject({
      category: 'execute', icon: '$', phrase: 'Ran a command', target: 'npm test',
    });
    expect(presentTool('exec', {})).toMatchObject({
      category: 'execute', icon: '$', phrase: 'Ran a command', target: '',
    });
    expect(presentTool('web__run', { search_query: [{ q: 'Mandible docs' }] })).toMatchObject({
      category: 'browser', phrase: 'Used the browser', target: 'Mandible docs',
    });
    expect(summarizeToolRun([
      { name: 'Read', input: { path: '/a' } },
      { name: 'Read', input: { path: '/b' } },
      { name: 'exec_command', input: { cmd: 'npm test' } },
    ])).toBe('Read some files, ran a command');
    expect(summarizeToolRun([
      { name: 'exec', input: {} },
      { name: 'exec', input: {} },
    ])).toBe('Ran some commands');
  });

  it('renders the live Codex exec payload as a human command description', () => {
    render(<ToolUseBlock toolName="exec" input={{}} defaultExpanded={false} />);
    expect(screen.getByRole('button', { name: /Ran a command/ })).toBeTruthy();
    expect(screen.queryByText('exec')).toBeNull();
  });

  it('computes line-based diff stats without fabricating a full diff string', () => {
    expect(computeDiffStats('one\ntwo\nthree', 'one\nTWO\nthree\nfour')).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it('auto-collapses long live tool cards when the result arrives', () => {
    const input = {
      file_path: '/tmp/example.txt',
      alpha: 'one',
      beta: 'two',
      gamma: 'three',
      delta: 'four',
    };
    const result = render(<ToolUseBlock toolName="Read" input={input} />);
    expect(result.container.querySelector('.tool-card--expanded')).toBeTruthy();

    result.rerender(
      <ToolUseBlock
        toolName="Read"
        input={input}
        result={{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'complete',
        }}
      />,
    );

    expect(result.container.querySelector('.tool-card--collapsed')).toBeTruthy();
    expect(screen.queryByText('complete')).toBeNull();
  });

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
        message: { role: 'assistant', content: blocks },
      },
      toolResults: new Map([
        ['tool-1', { type: 'tool_result', tool_use_id: 'tool-1', content: 'one' }],
        ['tool-2', { type: 'tool_result', tool_use_id: 'tool-2', content: 'two' }],
        ['tool-3', { type: 'tool_result', tool_use_id: 'tool-3', content: 'three' }],
        ['tool-4', { type: 'tool_result', tool_use_id: 'tool-4', content: 'four' }],
      ]),
    };

    const view = render(<MessageGroup turn={turn} isStreaming={false} />);
    const group = screen.getByRole('button', { name: /Read some files, ran a command/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelectorAll('.tool-card')).toHaveLength(1);
    fireEvent.click(group);
    expect(view.container.querySelectorAll('.tool-card')).toHaveLength(4);
    const leaves = view.container.querySelectorAll<HTMLButtonElement>('.tool-card__header');
    fireEvent.click(leaves[0]);
    expect(leaves[0].getAttribute('aria-expanded')).toBe('true');
    expect(leaves[1].getAttribute('aria-expanded')).toBe('false');
    expect(view.container.textContent).not.toContain('Success');
    expect(view.container.textContent).not.toContain('exit ok');
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
    const getBlockExpanded = (contentBlock: RenderedTurn['assistantEvent']['message']['content'][number]) => {
      if (contentBlock.type === 'tool_use' && contentBlock.id.startsWith('group:')) seen.push(contentBlock.id);
      return false;
    };
    const view = render(
      <MessageGroup turn={turn([block('one'), block('two')])} isStreaming getBlockExpanded={getBlockExpanded} />,
    );
    view.rerender(
      <MessageGroup turn={turn([block('one'), block('two'), block('three')])} isStreaming getBlockExpanded={getBlockExpanded} />,
    );
    expect(seen).toEqual(['group:one', 'group:one']);
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
