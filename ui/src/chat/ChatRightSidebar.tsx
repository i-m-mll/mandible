import { SessionOverviewView } from '../views/session-overview';
import { IssueReferenceDetail } from '../views/spaces/SpaceReferenceDetailPanel';
import type { ChatPreviewTarget } from './ChatEntityLinkBoundary';

export type ChatActivityItemStatus = 'active' | 'finished' | 'waiting' | 'error';

export type ChatActivityItem = {
  id: string;
  icon: string;
  label: string;
  status: ChatActivityItemStatus;
  meta: string[];
  onActivate(): void;
};

export function ChatSessionOverview({ providerSessionId, conversationId }: { providerSessionId: string | null; conversationId: string }): JSX.Element {
  return (
    <div className="chat-right-sidebar__content">
      {providerSessionId ? (
        <SessionOverviewView key={conversationId} initialSessionId={null} agentBinding={providerSessionId} embedded />
      ) : (
        <div className="chat-right-sidebar__empty">No Session Overview is available for this conversation.</div>
      )}
    </div>
  );
}

export function ChatPreview({ target }: { target: ChatPreviewTarget | null }): JSX.Element {
  return (
    <div className="chat-right-sidebar__content">
      {target ? (
        <div className="chat-right-sidebar__preview">
          <IssueReferenceDetail issueRef={target.ref} repoId={target.repoId} />
        </div>
      ) : (
        <div className="chat-right-sidebar__empty">Nothing selected for preview.</div>
      )}
    </div>
  );
}

export function ChatActivity({ items }: { items: ChatActivityItem[] }): JSX.Element {
  return (
    <div className="chat-right-sidebar__content chat-right-sidebar__activity">
      {items.length > 0 ? (
        <ul className="chat-activity" aria-label="Conversation activity">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`chat-activity__item chat-activity__item--${item.status}`}
                onClick={item.onActivate}
              >
                <span className="chat-activity__icon" aria-hidden="true">{item.icon}</span>
                <span className="chat-activity__main">
                  <span className="chat-activity__label">{item.label}</span>
                  {item.meta.length > 0 ? (
                    <span className="chat-activity__meta">
                      {item.meta.map((part, index) => <span key={`${item.id}:${index}`}>{part}</span>)}
                    </span>
                  ) : null}
                </span>
                <span className="chat-activity__status">{item.status}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="chat-right-sidebar__empty">No subagents or workflow runs.</div>
      )}
    </div>
  );
}
