import type { ComponentChildren } from 'preact';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { SessionOverviewView } from '../views/session-overview';
import { ReferenceDetailContent } from '../views/reference-detail';
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

function ChatSidebarDetail({ title, children }: { title: string; children: ComponentChildren }): JSX.Element {
  return (
    <DetailPaneShell
      as="section"
      variant="compact"
      presentation="sidebar"
      className="chat-right-sidebar__detail"
      bodyClassName="chat-right-sidebar__content"
      header={<DetailPaneHeader variant="compact" presentation="sidebar" title={title} />}
    >
      {children}
    </DetailPaneShell>
  );
}

export function ChatSessionOverview({ providerSessionId, conversationId }: { providerSessionId: string | null; conversationId: string }): JSX.Element {
  return (
    <ChatSidebarDetail title="Session Overview">
      {providerSessionId ? (
        <SessionOverviewView key={conversationId} initialSessionId={null} agentBinding={providerSessionId} embedded />
      ) : (
        <div className="chat-right-sidebar__empty">No Session Overview is available for this conversation.</div>
      )}
    </ChatSidebarDetail>
  );
}

export function ChatPreview({ target }: { target: ChatPreviewTarget | null }): JSX.Element {
  if (target) {
    return <ReferenceDetailContent target={target} presentation="sidebar" />;
  }
  return (
    <ChatSidebarDetail title="Preview">
        <div className="chat-right-sidebar__empty">Nothing selected for preview.</div>
    </ChatSidebarDetail>
  );
}

export function ChatActivity({ items }: { items: ChatActivityItem[] }): JSX.Element {
  return (
    <ChatSidebarDetail title="Activity">
      <div className="chat-right-sidebar__activity">
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
    </ChatSidebarDetail>
  );
}
