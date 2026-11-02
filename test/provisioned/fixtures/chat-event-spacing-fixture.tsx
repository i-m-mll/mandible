import { render } from 'preact';
import { TurnGroup } from '../../../ui/src/components/message-blocks/TurnGroup';
import { ToolUseBlock } from '../../../ui/src/components/message-blocks/ToolUseBlock';
import { TextBlock } from '../../../ui/src/components/message-blocks/TextBlock';
import { UserBubble } from '../../../ui/src/components/message-blocks/UserBubble';
import { MessageActions, MessageLinkContext, MessagePrimaryActionsContext } from '../../../ui/src/components/shared/MessageActions';

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
    const entries = [...document.querySelectorAll<HTMLElement>('[data-case]')].map(wrapper => {
      const content = wrapper.querySelector(':scope > .msg-text-block, :scope > .user-bubble, .compact-activity__row')!;
      const rail = wrapper.querySelector(':scope > .message-actions')!;
      return { kind: wrapper.dataset.case, wrapper: box(wrapper), content: box(content), rail: box(rail), opacity: getComputedStyle(rail).opacity };
    });
    const header = pane.querySelector<HTMLButtonElement>('.compact-activity__row')!;
    const tool = pane.querySelector<HTMLElement>('[data-case="tool"]')!;
    const clickAction = async (wrapper: HTMLElement, name: string, shiftKey = false) => {
      const compact = getComputedStyle(wrapper.querySelector('.message-actions')!).getPropertyValue('--message-actions-compact').trim() === '1';
      if (compact || name === 'Copy link' || name === 'Info') {
        wrapper.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click(); await task();
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
    results.push({ width, entries, details: box(details), expandedWrapper: box(tool), header: box(header), calls: { ...calls } });
    header.click(); await task();
  }
  document.title = btoa(JSON.stringify(results));
})().catch(error => { document.title = `fixture-error:${btoa(String(error.stack ?? error))}`; });
