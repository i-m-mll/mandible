import { render } from 'preact';
import { ChatSurface } from '../../../ui/src/chat/ChatSurface';
import type { CanonicalChatItemEvent } from '../../../src/presentation/types';

function events(conversationId: string): CanonicalChatItemEvent[] {
  return Array.from({ length: 20 }, (_, position) => ({ type: 'chat:item', item: {
    type: 'message', role: 'user', parts: [{ type: 'text', text: `${conversationId}:${position} ${'Conversation source prose. '.repeat(20)}` }],
    identity: { provider: 'codex', session_id: conversationId, native_item_id: `${conversationId}:${position}`, source_record_ordinal: position, source_sub_block_ordinal: 0 },
    provenance: { provider: 'codex', source: 'verified-provider-transcript', source_event_type: 'test-message' }, content_completion: 'complete',
  } }));
}

declare global { interface Window { openChat: (conversationId: string) => void } }
window.openChat = conversationId => render(<ChatSurface events={events(conversationId)} streaming={false} sessionInfo={{ sessionId: conversationId }} />, document.getElementById('root')!);
window.openChat('A');
