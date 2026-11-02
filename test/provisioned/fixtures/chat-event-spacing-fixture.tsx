import { render } from 'preact';
import { TurnGroup } from '../../../ui/src/components/message-blocks/TurnGroup';
import { ToolUseBlock } from '../../../ui/src/components/message-blocks/ToolUseBlock';
import { TextBlock } from '../../../ui/src/components/message-blocks/TextBlock';
import { UserBubble } from '../../../ui/src/components/message-blocks/UserBubble';
import { MessageActions, MessageLinkContext, MessagePrimaryActionsContext } from '../../../ui/src/components/shared/MessageActions';

const noop = () => {};
const prose = 'Natural wrapping must leave neighboring event separation unchanged. '.repeat(18);
const actions = <MessageActions blockId="source" onInfo={noop} />;
render(<MessageLinkContext.Provider value={noop}><MessagePrimaryActionsContext.Provider value={[
  { id: 'copy', title: 'Copy all', label: 'Copy all', icon: 'copyMessage', onAction: noop },
  { id: 'open', title: 'Open turn', label: 'Open turn', icon: 'menu', onAction: noop },
]}>
  <section id="pane">
    <TurnGroup speaker="assistant">
      <div className="message-block-wrapper" data-case="tool"><ToolUseBlock toolName="Bash" toolUseId="call" input={{ command: 'Read a moderately long tool command without moving hidden controls beneath its header' }} />{actions}</div>
      <div className="message-block-wrapper" data-case="prose"><TextBlock content={prose} />{actions}</div>
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
  for (const width of [944.203125, 772.203125, 452.203125, 284.203125, 944.203125]) {
    pane.style.width = `${width}px`;
    const entries = [...document.querySelectorAll<HTMLElement>('[data-case]')].map(wrapper => {
      const content = wrapper.querySelector(':scope > .msg-text-block, :scope > .user-bubble, .compact-activity__row')!;
      const rail = wrapper.querySelector(':scope > .message-actions')!;
      return { kind: wrapper.dataset.case, wrapper: box(wrapper), content: box(content), rail: box(rail), opacity: getComputedStyle(rail).opacity };
    });
    const header = pane.querySelector<HTMLButtonElement>('.compact-activity__row')!;
    header.click(); await task();
    const details = pane.querySelector('.compact-activity__details')!;
    results.push({ width, entries, details: box(details), expandedWrapper: box(pane.querySelector('[data-case="tool"]')!), header: box(header) });
    header.click(); await task();
  }
  document.title = btoa(JSON.stringify(results));
})().catch(error => { document.title = `fixture-error:${btoa(String(error.stack ?? error))}`; });
