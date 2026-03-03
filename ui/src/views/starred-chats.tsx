export type StarredChat = {
  id: string;
  session_id?: string | null;
  label: string;
  notes?: string | null;
  transcript_path?: string | null;
  cwd?: string | null;
  branch?: string | null;
  created_at?: string | number | null;
};

export type StarredChatsViewProps = {
  chats: StarredChat[];
  onUpdate: (chatId: string, updates: { label?: string; notes?: string }) => void | Promise<void>;
  onDelete: (chatId: string) => void | Promise<void>;
};

function getTimestampMs(value: string | number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatRelativeTime(timestampMs: number | null): string {
  if (timestampMs == null) {
    return '\u2014';
  }
  const diffMs = Date.now() - timestampMs;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatAbsoluteTime(timestampMs: number | null): string {
  if (timestampMs == null) {
    return '';
  }
  return new Date(timestampMs).toLocaleString();
}

function formatValue(value: string | null | undefined): string {
  if (!value) {
    return '\u2014';
  }
  return value;
}

function openTranscript(path: string): void {
  if (!path) {
    return;
  }
  const url = path.startsWith('file://') ? path : `file://${path}`;
  window.open(encodeURI(url), '_blank', 'noopener');
}

export function StarredChatsView(props: StarredChatsViewProps): JSX.Element {
  const { chats, onUpdate, onDelete } = props;

  const handleEditLabel = (chat: StarredChat) => {
    const next = window.prompt('Update label', chat.label);
    if (next == null) {
      return;
    }
    const trimmed = next.trim();
    if (!trimmed || trimmed === chat.label) {
      return;
    }
    void onUpdate(chat.id, { label: trimmed });
  };

  const handleDelete = (chat: StarredChat) => {
    const confirmed = window.confirm(`Delete starred chat "${chat.label}"?`);
    if (!confirmed) {
      return;
    }
    void onDelete(chat.id);
  };

  return (
    <div className="starred-chats-view">
      <div className="view-header">
        <div>
          <h2>Starred Chats</h2>
          <div className="text-muted">Bookmarks from /starchat in Claude.</div>
        </div>
      </div>
      {chats.length === 0 ? (
        <div className="empty-state">
          No starred chats yet. Use /starchat in Claude to bookmark a conversation.
        </div>
      ) : (
        <div className="starred-chat-grid">
          {chats.map((chat) => {
            const createdAtMs = getTimestampMs(chat.created_at);
            const relativeTime = formatRelativeTime(createdAtMs);
            const absoluteTime = formatAbsoluteTime(createdAtMs);
            return (
              <div className="starred-chat-card" key={chat.id}>
                <div className="starred-chat-card__header">
                  <div>
                    <div className="starred-chat-card__title">{chat.label}</div>
                    <div className="starred-chat-card__meta">
                      <span title={absoluteTime}>{relativeTime}</span>
                      <span className="starred-chat-card__divider">•</span>
                      <span>{formatValue(chat.branch)}</span>
                    </div>
                  </div>
                  <div className="starred-chat-card__actions">
                    {chat.transcript_path && (
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => openTranscript(chat.transcript_path || '')}
                      >
                        View transcript
                      </button>
                    )}
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => handleEditLabel(chat)}
                    >
                      Edit label
                    </button>
                    <button
                      className="btn btn--danger btn--sm"
                      onClick={() => handleDelete(chat)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="starred-chat-card__details">
                  <div className="starred-chat-card__detail">
                    <span className="starred-chat-card__detail-label">Branch</span>
                    <span className="starred-chat-card__detail-value">
                      {formatValue(chat.branch)}
                    </span>
                  </div>
                  <div className="starred-chat-card__detail">
                    <span className="starred-chat-card__detail-label">CWD</span>
                    <span className="starred-chat-card__detail-value starred-chat-card__path">
                      {formatValue(chat.cwd)}
                    </span>
                  </div>
                </div>
                {chat.notes ? (
                  <div className="starred-chat-card__notes">{chat.notes}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
