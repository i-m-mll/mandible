import { render } from 'preact';

import { ChatSurface } from '../../../ui/src/chat/ChatSurface';
import { DetailPaneShell } from '../../../ui/src/components/shared/DetailPaneShell';
import type { StreamEvent } from '../../../ui/src/components/stream-renderer/types';

const events: StreamEvent[] = Array.from({ length: 8 }, (_, index) => {
  const role = index % 2 === 0 ? 'user' : 'assistant';
  const text = `${role} message ${index} ${'measured transcript content '.repeat(index + 2)}`;
  if (role === 'user') {
    return {
      type: 'user',
      uuid: `user-${index}`,
      session_id: 'browser-mount',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
  }
  return {
    type: 'assistant',
    uuid: `assistant-${index}`,
    session_id: 'browser-mount',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
});

render(
  <DetailPaneShell
    className="chat-detail-frame"
    bodyClassName="conv-detail__body"
    header={<span>Transcript</span>}
    overlayControl={<div data-detail-pane-overlay-visual>Composer</div>}
  >
    <div className="conv-transcript">
      <ChatSurface events={events} streaming={false} sessionInfo={{ sessionId: 'browser-mount' }} />
    </div>
  </DetailPaneShell>,
  document.getElementById('root')!,
);

window.setTimeout(() => {
  const scroll = document.querySelector<HTMLElement>('.stream-renderer__scroll');
  const rows = document.querySelectorAll('.stream-renderer__virtual-row');
  document.body.dataset.mountStatus = scroll && rows.length > 0 ? 'settled' : 'incomplete';
  document.body.dataset.rowCount = String(rows.length);
  document.body.dataset.scrollTop = String(scroll?.scrollTop ?? -1);
}, 750);
