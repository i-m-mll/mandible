import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeDiffStats } from '../../ui/src/components/message-blocks/FileEditBlock';
import { latestPlanIndex, parsePlanEntries } from '../../ui/src/components/message-blocks/PlanBlock';
import { getToolVisual, leftTruncateTarget, ToolUseBlock } from '../../ui/src/components/message-blocks/ToolUseBlock';
import { presentTool, summarizeToolRun } from '../../ui/src/components/message-blocks/toolPresentation';
import { PermissionApprovalCard, permissionActionsForRequest } from '../../ui/src/components/console/PermissionApprovalCard';
import { MessageGroup } from '../../ui/src/components/stream-renderer/MessageGroup';
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
      category: 'execute', icon: 'terminal', phrase: 'Ran a command', target: 'npm test',
    });
    expect(presentTool('exec', {})).toMatchObject({
      category: 'execute', icon: 'terminal', phrase: 'Ran a command', target: '',
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
    expect(result.container.querySelector('.tool-card--collapsed')).toBeTruthy();

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

  it('uses exact Codex tool tokens on one coherent box and prose summary contract', () => {
    const css = readFileSync('ui/src/styles/message-blocks.css', 'utf8');
    for (const token of ['#767778', '#F4F4F4', '#DADADB', '#88888A', '#A3A3A3', '#242424', '#464646', '#919191']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.tool-card\s*\{[^}]*width:\s*100%;/s);
    expect(css).toMatch(/\.tool-card__body\s*\{[^}]*width:\s*100%;/s);
    expect(css).toMatch(/\.tool-card__header\s*\{[^}]*padding:\s*1px 0;[^}]*color:\s*var\(--tool-activity-text\);[^}]*font-size:\s*var\(--text-lg\);[^}]*line-height:\s*1\.15;/s);
    expect(css).toMatch(/\.msg-text-block\s*\{[^}]*font-family:\s*var\(--font-sans\);[^}]*font-size:\s*var\(--text-lg\);/s);
    expect(css).toMatch(/\.tool-call-group__summary,\s*\.tool-call-group__summary-text\s*\{[^}]*font-family:\s*var\(--font-sans\);[^}]*font-size:\s*var\(--text-lg\);[^}]*line-height:\s*1\.15;/s);
    expect(css).toMatch(/\.tool-call-group__summary\s*\{[^}]*padding:\s*1px 0;[^}]*color:\s*var\(--tool-activity-text\);/s);
    expect(css).toMatch(/\.tool-card__input,[\s\S]*?border:\s*1px solid var\(--tool-activity-border\);[\s\S]*?background:\s*var\(--tool-activity-background\);/);
    expect(css).toMatch(/\.tool-card__input,[\s\S]*?color:\s*var\(--tool-activity-box-text\);/);
    expect(css).toMatch(/\.tool-card__input pre,[\s\S]*?color:\s*var\(--tool-activity-box-text\);/);
    expect(css).toMatch(/\.tool-card__input pre,[\s\S]*?font-size:\s*var\(--text-lg\);/);
    expect(css).toMatch(/\.tool-card__input pre,[\s\S]*?background:\s*transparent;/);
    expect(css).toMatch(/:root :is\(\.tool-card__input, \.tool-card__terminal, \.tool-card__result\) :is\(pre, code\)\s*\{[^}]*background:\s*transparent;/s);
    expect(css).not.toContain('background: var(--status-danger-bg-soft)');
    expect(css).toMatch(/\.overflow-fade::before,\s*\.overflow-fade::after\s*\{[^}]*height:\s*4em;/s);
    expect(css).toContain('var(--overflow-fade-color, var(--surface-app))');

    const group = render(<MessageGroup turn={{
      id: 'typography',
      assistantEvent: {
        type: 'assistant', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'one', name: 'Read', input: { path: 'one' } },
          { type: 'tool_use', id: 'two', name: 'Read', input: { path: 'two' } },
        ] },
      },
      toolResults: new Map(),
    }} isStreaming={false} />);
    expect(group.container.querySelector('.tool-call-group__summary > .tool-call-group__summary-text')).toBeTruthy();
  });

  it('wins the real light-theme pre fill without changing general code surfaces', () => {
    const imports = readFileSync('ui/src/style.css', 'utf8');
    const sharedCss = readFileSync('ui/src/styles/shared.css', 'utf8');
    const toolCss = readFileSync('ui/src/styles/message-blocks.css', 'utf8');
    const markdownCss = readFileSync('ui/src/styles/rendered-markdown.css', 'utf8');
    expect(imports.indexOf('./styles/shared.css')).toBeLessThan(imports.indexOf('./styles/message-blocks.css'));
    expect(imports.indexOf('./styles/message-blocks.css')).toBeLessThan(imports.indexOf('./styles/rendered-markdown.css'));
    expect(sharedCss).toMatch(/:root\[data-theme='light'\] pre\s*\{[^}]*background:\s*var\(--surface-code\);/s);
    expect(markdownCss).toMatch(/\.rendered-markdown pre\s*\{[^}]*background:\s*var\(--surface-code\);/s);
    const toolNoFillRule = toolCss.match(
      /:root :is\(\.tool-card__input, \.tool-card__terminal, \.tool-card__result\) :is\(pre, code\)\s*\{[^}]*\}/s,
    )?.[0];
    expect(toolNoFillRule).toBeTruthy();

    const style = document.createElement('style');
    style.dataset.toolSurfaceStyles = 'true';
    style.textContent = `
      :root[data-theme='light'] pre { background: rgba(15, 23, 42, 0.06); }
      ${toolNoFillRule}
      .rendered-markdown pre { background: rgba(15, 23, 42, 0.06); }
    `;
    document.head.append(style);
    document.documentElement.dataset.theme = 'light';

    const view = render(<>
      <ToolUseBlock
        toolName="Read"
        input={{ path: '/tmp/example' }}
        result={{ type: 'tool_result', tool_use_id: 'read', content: 'output' }}
        defaultExpanded
      />
      <ToolUseBlock toolName="Bash" input={{ command: 'npm test' }} defaultExpanded />
      <div className="rendered-markdown"><pre data-testid="general-code">general code</pre></div>
    </>);

    const toolPres = view.container.querySelectorAll<HTMLElement>(
      '.tool-card__input pre, .tool-card__terminal pre, .tool-card__result pre',
    );
    expect(toolPres).toHaveLength(3);
    const code = document.createElement('code');
    toolPres[0].append(code);
    for (const surface of [...toolPres, code]) {
      expect(getComputedStyle(surface).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }
    expect(getComputedStyle(screen.getByTestId('general-code')).backgroundColor).toBe('rgba(15, 23, 42, 0.06)');

    document.documentElement.dataset.theme = 'dark';
    for (const surface of [...toolPres, code]) {
      expect(getComputedStyle(surface).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }
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
    const leaves = view.container.querySelectorAll<HTMLButtonElement>('.tool-card__header');
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

    fireEvent.click(view.container.querySelector<HTMLButtonElement>('.tool-card__header')!);
    expect(view.container.querySelectorAll('.tool-card__body > .tool-card__input .overflow-fade, .tool-card__body > .tool-card__result-wrapper .overflow-fade')).toHaveLength(2);
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
