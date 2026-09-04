import { SessionOverviewView } from '../views/session-overview';
import { IssueReferenceDetail } from '../views/spaces/SpaceReferenceDetailPanel';
import type { ChatPreviewTarget } from './ChatEntityLinkBoundary';

export function ChatSessionOverview({ providerSessionId, conversationId }: { providerSessionId: string | null; conversationId: string }): JSX.Element {
  return providerSessionId ? (
    <SessionOverviewView key={conversationId} initialSessionId={null} agentBinding={providerSessionId} embedded />
  ) : (
    <div className="chat-right-sidebar__empty">No Session Overview is available for this conversation.</div>
  );
}

export function ChatPreview({ target, onClear }: { target: ChatPreviewTarget | null; onClear(): void }): JSX.Element {
  return target ? (
    <div className="chat-right-sidebar__preview">
      <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>Clear preview</button>
      <IssueReferenceDetail issueRef={target.ref} repoId={target.repoId} />
    </div>
  ) : (
    <div className="chat-right-sidebar__empty">Nothing selected for preview.</div>
  );
}
