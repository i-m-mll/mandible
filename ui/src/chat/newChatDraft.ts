import type { ConversationSpawnFailure, ConversationSpawnReceipt } from '../api.js';

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
  | (DraftIdentity & { state: 'accepted'; provider: NewChatProvider; conversationId: string; spawn: ConversationSpawnReceipt })
  | (DraftIdentity & { state: 'abandoned' });

export type NewChatDraftAction =
  | { type: 'choose'; provider: NewChatProvider }
  | { type: 'fail'; failure: ConversationSpawnFailure }
  | { type: 'retry' }
  | { type: 'accepted'; conversationId: string; spawn: ConversationSpawnReceipt }
  | { type: 'observe'; spawn: ConversationSpawnReceipt }
  | { type: 'abandon' };

export function reduceNewChatDraft(draft: NewChatDraft, action: NewChatDraftAction): NewChatDraft {
  switch (action.type) {
    case 'choose':
      return draft.state === 'choosing' ? { ...draft, state: 'starting', provider: action.provider } : draft;
    case 'fail':
      return draft.state === 'starting' ? { ...draft, state: 'failed', failure: action.failure } : draft;
    case 'retry':
      return draft.state === 'failed' ? { ...draft, state: 'starting' } : draft;
    case 'accepted':
      return draft.state === 'starting'
        ? { ...draft, state: 'accepted', conversationId: action.conversationId, spawn: action.spawn }
        : draft;
    case 'observe':
      if (draft.state !== 'accepted' || action.spawn.reservation_id !== draft.conversationId) return draft;
      if (action.spawn.attempt_count < draft.spawn.attempt_count) return draft;
      if (action.spawn.attempt_count === draft.spawn.attempt_count
          && action.spawn.updated_at < draft.spawn.updated_at) return draft;
      return { ...draft, spawn: action.spawn };
    case 'abandon':
      return draft.state === 'accepted' ? draft : { ...draft, state: 'abandoned' };
  }
}
