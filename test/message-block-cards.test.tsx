import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { computeDiffStats } from '../ui/src/components/message-blocks/FileEditBlock';
import { latestPlanIndex, parsePlanEntries } from '../ui/src/components/message-blocks/PlanBlock';
import { getToolVisual, leftTruncateTarget, ToolUseBlock } from '../ui/src/components/message-blocks/ToolUseBlock';
import { PermissionApprovalCard, permissionActionsForRequest } from '../ui/src/components/console/PermissionApprovalCard';
import { MessageGroup } from '../ui/src/components/stream-renderer/MessageGroup';
import type { ConsolePermissionRequest } from '../ui/src/api';
import type { RenderedTurn } from '../ui/src/components/stream-renderer/types';

afterEach(() => cleanup());

describe('message action cards', () => {
  it('maps provider and ACP tool names onto one visual vocabulary', () => {
    expect(getToolVisual('Read').kind).toBe('read');
    expect(getToolVisual('Edit').kind).toBe('edit');
    expect(getToolVisual('Bash').kind).toBe('execute');
    expect(getToolVisual('WebFetch').kind).toBe('fetch');
    expect(getToolVisual('mcp__github__search').kind).toBe('mcp');
    expect(getToolVisual('switch_mode').kind).toBe('switch_mode');
  });

  it('left-truncates long targets while preserving the filename', () => {
    const target = '/Users/mll/Main/10 Projects/05 Utils/mandible/ui/src/components/message-blocks/ToolUseBlock.tsx';
    const truncated = leftTruncateTarget(target, 48);
    expect(truncated.startsWith('...')).toBe(true);
    expect(truncated.endsWith('/ToolUseBlock.tsx')).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(48);
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
    expect(screen.getByText('complete')).toBeTruthy();
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
