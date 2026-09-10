import type { ConversationSpawnFailure } from '../api.js';

export type NewChatProvider = 'codex' | 'claude_code';
export type NewChatPlacement = {
  kind: 'projectless' | 'project';
  projectId: string | null;
  checkoutId: string | null;
  projectLabel: string;
};

type DraftIdentity = { id: string; placement: NewChatPlacement };
export type NewChatDraft =
  | (DraftIdentity & { state: 'choosing' })
  | (DraftIdentity & { state: 'starting'; provider: NewChatProvider })
  | (DraftIdentity & { state: 'failed'; provider: NewChatProvider; failure: ConversationSpawnFailure })
  | (DraftIdentity & { state: 'ready'; provider: NewChatProvider; conversationId: string })
  | (DraftIdentity & { state: 'abandoned' });

export type NewChatDraftAction =
  | { type: 'choose'; provider: NewChatProvider }
  | { type: 'fail'; failure: ConversationSpawnFailure }
  | { type: 'retry' }
  | { type: 'ready'; conversationId: string }
  | { type: 'abandon' };

export function reduceNewChatDraft(draft: NewChatDraft, action: NewChatDraftAction): NewChatDraft {
  switch (action.type) {
    case 'choose':
      return draft.state === 'choosing' ? { ...draft, state: 'starting', provider: action.provider } : draft;
    case 'fail':
      return draft.state === 'starting' ? { ...draft, state: 'failed', failure: action.failure } : draft;
    case 'retry':
      return draft.state === 'failed' ? { ...draft, state: 'starting' } : draft;
    case 'ready':
      return draft.state === 'starting' ? { ...draft, state: 'ready', conversationId: action.conversationId } : draft;
    case 'abandon':
      return draft.state === 'ready' ? draft : { ...draft, state: 'abandoned' };
  }
}
