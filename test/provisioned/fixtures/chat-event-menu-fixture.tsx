import { render } from 'preact';
import { MessageActions, MessagePrimaryActionsContext } from '../../../ui/src/components/shared/MessageActions';
import { CompactActivityRow } from '../../../ui/src/components/shared/ChatDisclosure';
const call = (name: string) => { document.body.dataset.called = name; };
window.addEventListener('contextmenu', event => {
  document.body.dataset.contextCount = String(Number(document.body.dataset.contextCount ?? 0) + 1);
  document.body.dataset.contextSelection = document.getSelection()?.toString();
  queueMicrotask(() => { document.body.dataset.prevented = String(event.defaultPrevented); });
}, true);
render(<MessagePrimaryActionsContext.Provider value={[{ id: 'copy', title: 'Copy all', label: 'Copy all', icon: 'copyMessage', onAction: () => call('copy') }]}>
  <div className="message-block-wrapper" id="parent">
    <div className="msg-text-block"><p id="plain">Plain event source text with a native selection.</p></div>
    <span id="prevented" onContextMenu={event => event.preventDefault()}>Specific prevented menu</span>
    <span id="stopped" onContextMenu={event => event.stopPropagation()}>Specific stopped menu</span>
    <a href="#native" id="link">Native link</a><input id="input" value="native input selection" /><textarea id="textarea">native textarea selection</textarea>
    <div id="editable" contentEditable>Native editing</div><button id="specific">Specific control</button>
    <img id="media" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E" />
    <div className="message-block-wrapper" id="child"><div className="user-bubble"><p id="child-plain">Nested child event</p></div><MessageActions onInfo={() => call('child')} /></div>
    <MessageActions onInfo={() => call('parent')} />
  </div>
  <div className="message-block-wrapper" id="tool"><CompactActivityRow summary="Shared disclosure header" disclosure={{ content: 'Expanded details', regionLabel: 'Tool details' }} /><MessageActions onInfo={() => call('tool')} /></div>
  <div className="message-block-wrapper" id="footer"><div className="msg-text-block"><p>Final reply</p></div><MessageActions variant="reply-footer" onInfo={() => call('footer')} /></div>
<section id="paint-cases">
    <div className="message-block-wrapper" id="short-message"><div className="msg-text-block"><div className="msg-text-block__prose"><p>Short reply.</p></div></div><MessageActions onInfo={() => call('short')} /></div>
    <div className="message-block-wrapper" id="paragraph-message"><div className="msg-text-block"><div className="msg-text-block__prose"><p>{'Multiple paragraphs keep their existing line wrapping and content width. '.repeat(8)}</p><p>A shorter second paragraph.</p></div></div><MessageActions onInfo={() => call('paragraph')} /></div>
    <div id="paint-neighbor">Following event stays in place.</div>
  </section>
</MessagePrimaryActionsContext.Provider>, document.getElementById('root')!);
