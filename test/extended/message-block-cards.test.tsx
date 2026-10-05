import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeDiffStats } from '../../ui/src/components/message-blocks/FileEditBlock';
import { latestPlanIndex, parsePlanEntries } from '../../ui/src/components/message-blocks/PlanBlock';
import { ThinkingBlock } from '../../ui/src/components/message-blocks/ThinkingBlock';
import { getToolVisual, leftTruncateTarget, ToolUseBlock } from '../../ui/src/components/message-blocks/ToolUseBlock';
import { presentTool, summarizeToolRun, toolRunIcon } from '../../ui/src/components/message-blocks/toolPresentation';
import { PermissionApprovalCard, permissionActionsForRequest } from '../../ui/src/components/console/PermissionApprovalCard';
import { MessageGroup } from '../../ui/src/components/stream-renderer/MessageGroup';
import { CompactActivityRow } from '../../ui/src/components/shared/ChatDisclosure';
import type { ConsolePermissionRequest } from '../../ui/src/api';
import type { RenderedTurn } from '../../ui/src/components/stream-renderer/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  document.head.querySelector('[data-tool-surface-styles]')?.remove();
});

function setScrollMetrics(element: HTMLElement, clientHeight: number, scrollHeight: number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
}

describe('message action cards', () => {
  it('keeps assistant selection bare and gives both speakers one Markdown rhythm contract', () => {
  });

  it('maps provider and ACP tool names onto one visual vocabulary', () => {
    expect(getToolVisual('Read').kind).toBe('read');
    expect(getToolVisual('Edit').kind).toBe('edit');
    expect(getToolVisual('Bash').kind).toBe('execute');
    expect(getToolVisual('WebFetch').kind).toBe('fetch');
    expect(getToolVisual('mcp__github__search').kind).toBe('search');
    expect(getToolVisual('mcp__browser__navigate').kind).toBe('browser');
    expect(getToolVisual('web__run').kind).toBe('browser');
    expect(getToolVisual('switch_mode').kind).toBe('switch_mode');
    expect(getToolVisual('exec').verb).toBe('Used exec');
    expect(getToolVisual('wait').verb).toBe('Waited');
    expect(getToolVisual('js').verb).toBe('Ran JavaScript');
  });

  it('left-truncates long targets while preserving the filename', () => {
    const target = '/Users/fixture/Projects/sample repo';
    const truncated = leftTruncateTarget(target, 48);
    expect(truncated.startsWith('...')).toBe(true);
    expect(truncated.endsWith('/ToolUseBlock.tsx')).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(48);
  });

  it('uses exact tool names for classification and only shows targets with a known meaning', () => {
    expect(presentTool('exec_command', { cmd: 'npm test' })).toMatchObject({
      category: 'execute', icon: 'terminal', phrase: 'Ran a command', target: 'npm test',
    });
    expect(presentTool('exec', {})).toMatchObject({
      category: 'other', icon: 'tool', phrase: 'Used exec', target: '',
    });
    expect(presentTool('web__run', { search_query: [{ q: 'Mandible docs' }] })).toMatchObject({
      category: 'browser', phrase: 'Used the browser', target: 'Mandible docs',
    });
    expect(summarizeToolRun([
      { name: 'Read' },
      { name: 'Read' },
      { name: 'exec_command' },
    ])).toBe('Read some files, ran a command');
    expect(summarizeToolRun([
      { name: 'exec' },
      { name: 'exec' },
    ])).toBe('Used exec several times');
    expect(presentTool('unknown_tool', { command: 'opaque payload' })).toMatchObject({
      category: 'other', phrase: 'Used unknown_tool', target: '',
    });
  });

  it('renders the live Codex exec tool by its explicit name without reading its payload', () => {
    render(<ToolUseBlock toolName="exec" input={{}} defaultExpanded={false} />);
    expect(screen.getByRole('button', { name: /Used exec/ })).toBeTruthy();
  });

  it('preserves a non-empty opaque Codex custom-tool payload', () => {
    const source = 'const r = await tools.exec_command({ cmd: "npm test" });';
    render(<ToolUseBlock toolName="exec" input={source} defaultExpanded />);
    expect(screen.getByText(source)).toBeTruthy();
    expect(screen.queryByText('{}')).toBeNull();
  });

  it('computes line-based diff stats without fabricating a full diff string', () => {
    expect(computeDiffStats('one\ntwo\nthree', 'one\nTWO\nthree\nfour')).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it('default-folds tool leaves before and after a result arrives', () => {
    const input = {
      file_path: '/tmp/example.txt',
      alpha: 'one',
      beta: 'two',
      gamma: 'three',
      delta: 'four',
    };
    const result = render(<ToolUseBlock toolName="Read" input={input} />);
    expect(screen.getByRole('button', { name: /Read a file/ }).getAttribute('aria-expanded')).toBe('false');

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

    expect(screen.getByRole('button', { name: /Read a file/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('complete')).toBeNull();
  });

  it('does not render an empty result surface', () => {
    const view = render(
      <ToolUseBlock
        toolName="Bash"
        input={{ command: 'true' }}
        result={{ type: 'tool_result', tool_use_id: 'bash', content: '' }}
        defaultExpanded
      />,
    );

    expect(view.container.querySelector('.tool-card__result-wrapper')).toBeNull();
  });


  it('renders expanded tool input and output as distinct boxes without boxing grouped rows', () => {
    const css = readFileSync('ui/src/styles/message-blocks.css', 'utf8');

    const tool = render(<ToolUseBlock
      toolName="Read"
      input={{ path: '/tmp/example' }}
      result={{ type: 'tool_result', tool_use_id: 'tool-1', content: 'payload' }}
      defaultExpanded
    />);
    const payload = tool.container.querySelector('.tool-card > .compact-activity > .compact-activity__details > .tool-card__body')!;
    expect(payload.querySelector(':scope > .tool-card__input-wrapper.tool-card__payload-box')).toBeTruthy();
    expect(payload.querySelector(':scope > .tool-card__result-wrapper.tool-card__payload-box')).toBeTruthy();
    expect(payload.querySelectorAll(':scope > .tool-card__payload-box')).toHaveLength(2);
    tool.unmount();

    const group = render(<MessageGroup turn={{
      id: 'group-payload-contract',
      assistantEvent: {
        type: 'assistant', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'one', name: 'Read', input: { path: 'one' } },
          { type: 'tool_use', id: 'two', name: 'Read', input: { path: 'two' } },
        ] },
      },
      toolResults: new Map(),
    }} isStreaming={false} getDisclosureExpanded={() => true} />);
    expect(group.container.querySelector('.tool-call-group > .compact-activity__details > .tool-call-group__body')).toBeTruthy();
    expect(group.container.querySelector('.tool-call-group__body.tool-card__body')).toBeNull();
  });

  it('gives grouped tool runs exactly one representative icon', () => {
    expect(toolRunIcon([
      { name: 'Read' },
      { name: 'Read' },
      { name: 'Bash' },
    ])).toBe('↗');
  });

  it('keeps shared disclosure semantics and restores focus when controlled content closes', () => {
    const disclosure = (expanded: boolean) => ({
      content: <button type="button">Detail action</button>,
      regionLabel: 'Shared details',
      expanded,
    });
    const view = render(<CompactActivityRow icon={<span>·</span>} summary="Shared summary" disclosure={disclosure(true)} />);
    const detailAction = screen.getByRole('button', { name: 'Detail action' });
    detailAction.focus();
    view.rerender(<CompactActivityRow icon={<span>·</span>} summary="Shared summary" disclosure={disclosure(false)} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Shared summary' }));
  });

  it('keeps compact thinking expandable while its full detail payload is unloaded', () => {
    const onExpandedChange = vi.fn();
    render(<ThinkingBlock content="Visible thought summary" detailsAvailable onExpandedChange={onExpandedChange} />);
    const row = screen.getByRole('button', { name: 'Visible thought summary' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('does not reserve an icon column when a compact activity has no icon', () => {
    const view = render(<CompactActivityRow summary="Flush-left reasoning" disclosure={{
      content: <span>Detail</span>,
      regionLabel: 'Reasoning details',
      expanded: false,
    }} />);
    const row = screen.getByRole('button', { name: 'Flush-left reasoning' });
    expect(row.classList.contains('compact-activity__row--no-icon')).toBe(true);
    expect(view.container.querySelector('.compact-activity__icon')).toBeNull();
    expect(row.lastElementChild?.classList.contains('compact-activity__chevron')).toBe(true);
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
        message: { role: 'assistant', content: blocks, usage: { input_tokens: 10, output_tokens: 5 } },
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
    expect(group.getAttribute('aria-controls')).toBeTruthy();
    expect(view.container.querySelectorAll('.tool-card')).toHaveLength(1);
    fireEvent.click(group);
    expect(screen.getByRole('region', { name: /Read some files, ran a command details/ })).toBeTruthy();
    expect(view.container.querySelectorAll('.tool-card')).toHaveLength(4);
    const leaves = view.container.querySelectorAll<HTMLButtonElement>('.tool-card > .compact-activity > .compact-activity__row');
    expect(leaves[0].getAttribute('aria-controls')).toBeTruthy();
    fireEvent.click(leaves[0]);
    expect(leaves[0].getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Read a file details' })).toBeTruthy();
    expect(leaves[1].getAttribute('aria-expanded')).toBe('false');
    expect(view.container.textContent).not.toContain('Success');
    expect(view.container.textContent).not.toContain('exit ok');
    expect(view.container.textContent).not.toContain('tokens');
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

  it('shows every grouped tool row while retaining independent fades inside expanded leaves', () => {
    const blocks = [
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a' } },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { path: '/tmp/b' } },
    ] as RenderedTurn['assistantEvent']['message']['content'];
    const turn: RenderedTurn = {
      id: 'turn-scroll-owners',
      assistantEvent: {
        type: 'assistant', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content: blocks },
      },
      toolResults: new Map([
        ['tool-1', { type: 'tool_result', tool_use_id: 'tool-1', content: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven' }],
        ['tool-2', { type: 'tool_result', tool_use_id: 'tool-2', content: 'done' }],
      ]),
    };

    const view = render(<MessageGroup turn={turn} isStreaming={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Read some files/ }));
    const groupBody = view.container.querySelector<HTMLElement>('.tool-call-group__body')!;
    expect(groupBody.classList.contains('overflow-fade')).toBe(false);
    expect(groupBody.querySelector(':scope > .overflow-fade__scroll')).toBeNull();
    expect(groupBody.querySelectorAll('.tool-card')).toHaveLength(2);

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('.tool-card > .compact-activity > .compact-activity__row')!);
    expect(view.container.querySelectorAll('.tool-card__input-wrapper .tool-card__input .overflow-fade, .tool-card__body > .tool-card__result-wrapper .overflow-fade')).toHaveLength(2);
    const inputFade = view.container.querySelector<HTMLElement>('.tool-card__input .overflow-fade')!;
    const inputScroll = inputFade.querySelector<HTMLElement>('.overflow-fade__scroll')!;
    setScrollMetrics(inputScroll, 40, 100);
    inputScroll.scrollTop = 20;
    fireEvent.scroll(inputScroll);
    expect(inputFade.classList.contains('overflow-fade--above')).toBe(true);
    expect(inputFade.classList.contains('overflow-fade--below')).toBe(true);
    const leafFade = view.container.querySelector<HTMLElement>('.tool-card__result .overflow-fade')!;
    const leafScroll = leafFade.querySelector<HTMLElement>('.overflow-fade__scroll')!;
    setScrollMetrics(leafScroll, 80, 180);
    leafScroll.scrollTop = 0;
    fireEvent.scroll(leafScroll);
    expect(leafFade.classList.contains('overflow-fade--above')).toBe(false);
    expect(leafFade.classList.contains('overflow-fade--below')).toBe(true);
    expect(inputScroll.scrollTop).toBe(20);

    leafScroll.scrollTop = 100;
    fireEvent.scroll(leafScroll);
    expect(leafFade.classList.contains('overflow-fade--above')).toBe(true);
    expect(leafFade.classList.contains('overflow-fade--below')).toBe(false);
    expect(leafScroll.scrollTop).toBe(100);
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
