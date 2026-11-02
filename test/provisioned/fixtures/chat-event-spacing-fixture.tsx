import { render } from 'preact';
import { TurnGroup } from '../../../ui/src/components/message-blocks/TurnGroup';
import { ToolUseBlock } from '../../../ui/src/components/message-blocks/ToolUseBlock';
import { TextBlock } from '../../../ui/src/components/message-blocks/TextBlock';
import { UserBubble } from '../../../ui/src/components/message-blocks/UserBubble';
import { MessageActions, MessageLinkContext, MessagePrimaryActionsContext } from '../../../ui/src/components/shared/MessageActions';
import { ReadingRowView, ReadingRowBody } from '../../../ui/src/chat/ReadingRowView';
import { ActivityGroup } from '../../../ui/src/components/message-blocks/ActivityBlock';
import { createReadingRowBatchRenderer } from '../../../ui/src/chat/renderReadingMeasurementBatch';
import { planReadingLayout } from '../../../src/presentation/reading-plan';
import { materializePreparedReadingRows, type PreparedReadingMember } from '../../../src/presentation/reading';
import { readingNodeDisclosures } from '../../../src/presentation/reading-disclosures';
import type { ReadingRow } from '../../../ui/src/chat/readingProjection';

const nestedRows: ReadingRow[] = [0, 1, 2, 3, 4, 5, 6].map(index => ({
  key: `nested:${index}`, kind: index === 4 || index === 5 ? 'activity-summary' : 'content', isFinalResponse: false, protectedPositions: [], items: [], sources: [], actionGroup: { key: `turn:${index}`, start: index, end: index },
  disclosureOwner: 'activity-group', activityMember: index < 3 || index === 6, activityEnd: index === 2 || index === 6, turnStart: index !== 1, turnEnd: index !== 1,
  ...(index === 4 || index === 5 ? { activityGroup: { expanded: index === 5, items: [], presentation: { summary: 'Parent tool activity', icon: 'terminal', hasDisclosure: true, defaultExpanded: false } } } : {}),
  totalTokens: index === 2 ? 1234 : undefined,
  nodes: [{ kind: 'activity', key: `nested:${index}`, entity: 'assistant', item: index === 1
    ? { type: 'thinking-block-activity', content: 'Consider the shared header contract\nReasoning detail remains disclosed separately', sessionId: 'fixture' }
    : { type: 'tool-call-activity', id: `tool:${index}`, name: 'Bash', input: { command: 'Inspect nested tool activity' }, result: null, sessionId: 'fixture' } }],
}));
const finalRow: ReadingRow = { key: 'final', kind: 'content', isFinalResponse: true, protectedPositions: [], items: [], sources: [],
  actionGroup: { key: 'final', start: 10, end: 10 }, disclosureOwner: null,
  nodes: [{ kind: 'assistant_turn', key: 'final', entity: 'assistant', turn: { id: 'final', toolResults: new Map(), assistantEvent: {
    type: 'assistant', session_id: 'fixture', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'An explicitly final assistant reply.' }] },
  } } }],
};

const calls: Record<string, number> = {};
const called = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
const prose = 'Natural wrapping must leave neighboring event separation unchanged. '.repeat(18);
const actions = <MessageActions blockId="source" onInfo={() => called('info')} />;
render(<MessageLinkContext.Provider value={() => called('link')}><MessagePrimaryActionsContext.Provider value={[
  { id: 'copy', title: 'Copy all', label: 'Copy all', icon: 'copyMessage', onAction: () => called('copy') },
  { id: 'open', title: 'Open turn', label: 'Open turn', icon: 'menu', onAction: () => called('open') },
]}>
  <section id="pane">
    <TurnGroup speaker="assistant">
      <div className="message-block-wrapper" data-case="tool"><ToolUseBlock toolName="Bash" toolUseId="call" input={{ command: 'Read a moderately long tool command without moving hidden controls beneath its header' }} />{actions}</div>
      <div className="message-block-wrapper" data-case="prose"><TextBlock content={prose} />{actions}</div>
      <div className="message-block-wrapper" data-case="local"><TextBlock content="Local actions" /><MessageActions blockId="local" onCopy={() => called('local-copy')} onSelect={shift => called(shift ? 'shift-select' : 'select')} selectMode /></div>
    </TurnGroup>
    <TurnGroup speaker="user"><div className="message-block-wrapper" data-case="user"><UserBubble text={prose} />{actions}</div></TurnGroup>
  </section>
  <section id="nested">{nestedRows.map(row => <ReadingRowView key={row.key} row={row} events={[]} streaming={false} expandedBlocks={{}}
    setBlockExpanded={() => {}} preparing={false} primaryActions={[]} onActivityGroupExpandedChange={() => {}} />)}</section>
  <section id="final"><ReadingRowView row={finalRow} events={[]} streaming={false} expandedBlocks={{}} setBlockExpanded={() => {}} preparing={false}
    onActivityGroupExpandedChange={() => {}} primaryActions={[
      { id: 'copy-final', title: 'Copy all', label: 'Copy all', icon: 'copyMessage', onAction: () => called('final-copy') },
      { id: 'open-final', title: 'Open turn', label: 'Open turn', icon: 'menu', onAction: () => called('final-open') },
    ]} /></section>
</MessagePrimaryActionsContext.Provider></MessageLinkContext.Provider>, document.getElementById('root')!);

const box = (element: Element) => {
  const { top, bottom, left, right, width, height } = element.getBoundingClientRect();
  return { top, bottom, left, right, width, height };
};
const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));
void (async () => {
  await task();
  const results = [];
  const pane = document.getElementById('pane')!;
  for (const width of [944.203125, 772.203125, 452.203125, 284.203125, 164, 114, 64, 944.203125]) {
    pane.style.width = `${width}px`;
    document.getElementById('nested')!.style.width = `${width}px`;
    const final = document.getElementById('final')!; final.style.width = `${width}px`;
    const entries = [...document.querySelectorAll<HTMLElement>('[data-case]')].map(wrapper => {
      const content = wrapper.querySelector(':scope > .msg-text-block, :scope > .user-bubble, .compact-activity__row')!;
      const rail = wrapper.querySelector(':scope > .message-actions')!;
      return { kind: wrapper.dataset.case, wrapper: box(wrapper), content: box(content), rail: box(rail), opacity: getComputedStyle(rail).opacity };
    });
    const header = pane.querySelector<HTMLButtonElement>('.compact-activity__row')!;
    const tool = pane.querySelector<HTMLElement>('[data-case="tool"]')!;
    const clickAction = async (wrapper: HTMLElement, name: string, shiftKey = false) => {
      const compact = !wrapper.querySelector('.message-actions > .message-actions__primary');
      if (compact || name === 'Copy link' || name === 'Info') {
        if (compact) { const rect = wrapper.getBoundingClientRect(); wrapper.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 })); }
        else wrapper.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click();
        await task();
        const menu = document.querySelector('[role="menu"]')!;
        const action = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name || button.textContent?.trim() === name || (name === 'Copy message' && button.textContent?.trim() === 'Copied'))!;
        if (!action) throw new Error(`Missing ${name} in compact=${compact}`);
        action.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey })); await task();
        if (document.querySelector('[role="menu"]')) throw new Error(`Menu stayed open after ${name}`);
      } else {
        const action = wrapper.querySelector<HTMLButtonElement>(`[aria-label="${name}"]${name === 'Copy message' ? ', [aria-label="Copied"]' : ''}`);
        if (!action) throw new Error(`Missing inline ${name} at ${width}`);
        action.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey })); await task();
      }
    };
    for (const name of ['Copy all', 'Open turn', 'Copy link', 'Info']) await clickAction(tool, name);
    const local = pane.querySelector<HTMLElement>('[data-case="local"]')!;
    await clickAction(local, 'Copy message'); await clickAction(local, 'Select message', true);
    header.click(); await task();
    const details = pane.querySelector('.compact-activity__details')!;
    const nested = [...document.querySelectorAll<HTMLElement>('#nested [data-reading-key]')].map(row => ({ frame: box(row), header: box(row.querySelector('.compact-activity__row')!), rail: box(row.querySelector('.message-actions')!) }));
    const footer = final.querySelector<HTMLElement>('.message-actions--reply-footer')!;
    footer.querySelector<HTMLButtonElement>('[aria-label="Copy all"]')!.click(); footer.querySelector<HTMLButtonElement>('[aria-label="Open turn"]')!.click();
    results.push({ width, spacing: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-2')), entries, details: box(details), expandedWrapper: box(tool), header: box(header), calls: { ...calls }, nested,
      final: { message: box(final.querySelector('.msg-text-block')!), footer: box(footer), opacity: getComputedStyle(footer).opacity, pointerEvents: getComputedStyle(footer).pointerEvents } });
    header.click(); await task();
  }
  results[0].childBoundaries = await measureChildBoundaries();
  document.title = btoa(JSON.stringify(results));
})().catch(error => { document.title = `fixture-error:${btoa(String(error.stack ?? error))}`; });

async function measureChildBoundaries() {
  const members: PreparedReadingMember[] = [0, 1, 2].map(index => {
    const key = `sibling:${index}`;
    const activity = { type: 'tool-call-activity' as const, id: key, name: 'Bash', input: { command: 'Inspect the child body\nThen inspect the next sibling' }, result: null, sessionId: 'fixture' };
    return { key, part: 'tool', kind: 'activity', speaker: 'assistant', actionGroup: { key: 'siblings', start: 0, end: 2 }, activity,
      dependencyRevision: '1', sourcePositions: [], handoffKeys: [], sources: [], node: { kind: 'activity', key, entity: 'assistant', item: activity } };
  });
  const planned = planReadingLayout({ members, conversationId: 'siblings', positionSpaceId: 'fixture', expanded: { 'group:live:sibling:0': true } });
  const rows = materializePreparedReadingRows(planned.rows, members);
  const results = [];
  for (const fontSize of [14, 20]) for (const expanded of [false, true]) {
    const expandedBlocks = { [readingNodeDisclosures(members[0].node).keys[0]]: expanded };
    const props = (row: ReadingRow) => ({ row, events: [], streaming: false, expandedBlocks, setBlockExpanded: () => {}, preparing: false, primaryActions: [], onActivityGroupExpandedChange: () => {} });
    const normal = document.createElement('section'); normal.style.width = '452.203125px'; normal.style.setProperty('--text-lg', `${fontSize}px`); document.body.append(normal);
    render(<>{rows.map(row => <ReadingRowView key={row.key} {...props(row)} />)}</>, normal);
    const internal = document.createElement('section'); internal.style.cssText = normal.style.cssText; document.body.append(internal);
    render(<ActivityGroup items={members.map(member => member.activity!)} expanded renderMember={(_, index) => <ReadingRowBody {...props(rows[index + 1])} />} />, internal);
    const offscreen = document.createElement('div'); offscreen.dataset.readingMeasurementHost = ''; offscreen.style.cssText = normal.style.cssText; Object.assign(offscreen.style, { position: 'fixed', visibility: 'hidden' }); document.body.append(offscreen);
    const batch = createReadingRowBatchRenderer(props)(offscreen, rows);
    const standalone = document.createElement('section'); standalone.style.cssText = normal.style.cssText; document.body.append(standalone);
    render(<ReadingRowView {...props({ ...rows[1], activityMember: false, activityEnd: false })} />, standalone);
    await task();
    const frames = [...normal.querySelectorAll<HTMLElement>('[data-reading-key]')];
    const headers = frames.map(frame => box(frame.querySelector('.compact-activity__row')!));
    const internalHeaders = [...internal.querySelectorAll('.compact-activity__row')].map(box);
    const firstBody = frames[1].querySelector('.compact-activity__details');
    const internalFirst = internal.querySelector('.activity-group__members')!.firstElementChild!;
    const contentInsets = (header: Element) => {
      const frame = box(header); const text = box(header.querySelector('.compact-activity__summary')!);
      return { above: text.top - frame.top, below: frame.bottom - text.bottom };
    };
    const bodyTypography = (details: Element | null) => details ? { height: box(details).height, font: getComputedStyle(details).font, lineHeight: getComputedStyle(details).lineHeight } : null;
    results.push({ fontSize, expanded, parentToFirst: headers[1].top - headers[0].bottom, firstToSecond: headers[2].top - headers[1].top,
      lastPitch: headers[3].top - headers[2].top, outerLeading: headers[0].top - box(frames[0]).top,
      outerTrailing: box(frames[3]).bottom - headers[3].bottom, bodyGap: firstBody ? headers[2].top - box(firstBody).bottom : null,
      headerHeights: headers.map(header => header.height), internalParentToFirst: internalHeaders[1].top - internalHeaders[0].bottom,
      internalFirstToSecond: internalHeaders[2].top - internalHeaders[1].top, internalLastPitch: internalHeaders[3].top - internalHeaders[2].top,
      internalBodyGap: expanded ? internalHeaders[2].top - box(internalFirst).bottom : null,
      standaloneHeight: box(standalone.querySelector('.compact-activity__row')!).height,
      standaloneInset: contentInsets(standalone.querySelector('.compact-activity__row')!),
      nestedInset: contentInsets(frames[1].querySelector('.compact-activity__row')!),
      nestedBody: bodyTypography(firstBody), standaloneBody: bodyTypography(standalone.querySelector('.compact-activity__details')),
      normalHeights: frames.map(frame => box(frame).height), measuredHeights: rows.map(row => box(batch.elements.get(row.key)!).height) });
    batch.dispose(); render(null, normal); render(null, internal); render(null, standalone); normal.remove(); internal.remove(); offscreen.remove(); standalone.remove();
  }
  return results;
}
