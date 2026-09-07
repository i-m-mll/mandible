import type { ConversationSpawnFailure } from '../api.js';

export type NewChatProvider = 'codex' | 'claude_code';
export type NewChatPlacement = {
  projectId: string;
  checkoutId: string;
  projectLabel: string;
};

type DraftIdentity = { id: string; placement: NewChatPlacement };
export type NewChatDraft =
  | (DraftIdentity & { state: 'choosing' })
  | (DraftIdentity & { state: 'starting'; provider: NewChatProvider })
  | (DraftIdentity & { state: 'failed'; provider: NewChatProvider; failure: ConversationSpawnFailure })
  | (DraftIdentity & { state: 'ready'; provider: NewChatProvider; sessionId: string })
  | (DraftIdentity & { state: 'abandoned' });

export type NewChatDraftAction =
  | { type: 'choose'; provider: NewChatProvider }
  | { type: 'fail'; failure: ConversationSpawnFailure }
  | { type: 'retry' }
  | { type: 'ready'; sessionId: string }
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
      return draft.state === 'starting' ? { ...draft, state: 'ready', sessionId: action.sessionId } : draft;
    case 'abandon':
      return draft.state === 'choosing' || draft.state === 'failed' ? { ...draft, state: 'abandoned' } : draft;
  }
}
