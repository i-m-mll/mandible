// Bug: b949700 — Console tab: sub-tab bar for PTY session tabs
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useMemo } from 'preact/hooks';
import type { ConsoleSession } from '../../state';

type ConsoleSubTabBarProps = {
  sessions: ConsoleSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNewSession: () => void;
  isConsoleActive: boolean;
};

// Two-letter abbreviations for agent types
const AGENT_ABBREV: Record<string, string> = {
  operator: 'OP',
  claude: 'CL',
  codex: 'CX',
  gemini: 'GM',
  shell: 'SH',
};

// Colors for agent type indicators
const AGENT_COLOR: Record<string, string> = {
  operator: 'var(--accent-yellow)',
  claude: 'var(--accent-yellow)',
  codex: 'var(--accent-green)',
  gemini: 'var(--accent-blue)',
  shell: 'var(--text-muted)',
};

function getAgentAbbrev(agentType: string): string {
  return AGENT_ABBREV[agentType] ?? agentType.slice(0, 2).toUpperCase();
}

function getAgentColor(agentType: string): string {
  return AGENT_COLOR[agentType] ?? 'var(--text-muted)';
}

export function ConsoleSubTabBar({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
  onNewSession,
  isConsoleActive,
}: ConsoleSubTabBarProps): JSX.Element {
  // Pinned sessions first, then by created_at
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return a.created_at - b.created_at;
    });
  }, [sessions]);

  // Keyboard shortcuts for sub-tab navigation
  useEffect(() => {
    if (!isConsoleActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const currentIndex = sortedSessions.findIndex((s) => s.id === activeSessionId);
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        if (sortedSessions.length === 0) return;
        const nextIndex = (currentIndex + 1) % sortedSessions.length;
        onSelect(sortedSessions[nextIndex].id);
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        if (sortedSessions.length === 0) return;
        const prevIndex = (currentIndex - 1 + sortedSessions.length) % sortedSessions.length;
        onSelect(sortedSessions[prevIndex].id);
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        const active = sortedSessions.find((s) => s.id === activeSessionId);
        if (active && !active.pinned) {
          onClose(active.id);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isConsoleActive, sortedSessions, activeSessionId, onSelect, onClose]);

  return (
    <div className="console-sub-tab-bar">
      {sortedSessions.map((session) => {
        const isActive = session.id === activeSessionId;
        let tabClass = 'console-tab';
        if (isActive) tabClass += ' console-tab--active';
        if (session.pinned) tabClass += ' console-tab--pinned';

        return (
          <button
            key={session.id}
            type="button"
            className={tabClass}
            onClick={() => onSelect(session.id)}
            title={session.label}
          >
            {/* Agent type indicator */}
            <span
              style={{
                fontSize: '10px',
                fontWeight: 600,
                color: getAgentColor(session.agent_type),
                fontFamily: 'var(--font-mono)',
                flexShrink: 0,
              }}
            >
              {getAgentAbbrev(session.agent_type)}
            </span>

            {/* Session name */}
            <span className="console-tab__name">{session.label}</span>

            <span
              className="console-tab__lane"
              title={session.transport_badge?.title}
            >
              {session.transport_badge?.label ?? session.transport_lane ?? session.backend_type}
            </span>

            {/* Status indicator: red dot for crashed, muted dot for stopped.
                Bug: 1d286c1 — requires Bug 3 (SSE events) to propagate status correctly */}
            {(session.status === 'crashed' || session.status === 'stopped') && (
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: session.status === 'crashed' ? 'var(--accent-red, #f85149)' : 'var(--text-muted)',
                  flexShrink: 0,
                  display: 'inline-block',
                }}
                title={`Session ${session.status}`}
              />
            )}

            {/* Unread badge */}
            {session.unread_count > 0 && (
              <span
                style={{
                  background: 'rgba(77,163,255,0.2)',
                  color: 'var(--accent-blue)',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {session.unread_count}
              </span>
            )}

            {/* Lock or close */}
            {session.pinned ? (
              <span
                style={{
                  fontSize: '12px',
                  flexShrink: 0,
                  color: 'var(--accent-yellow)',
                  opacity: 0.7,
                }}
                title="Pinned — cannot be closed"
              >
                &#x1F512;
              </span>
            ) : (
              <button
                type="button"
                className="console-tab__close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session.id);
                }}
                title="Close session"
              >
                &times;
              </button>
            )}
          </button>
        );
      })}

      {/* New session button */}
      <button
        type="button"
        className="console-tab__new-btn"
        onClick={onNewSession}
        title="New session"
      >
        +
      </button>
    </div>
  );
}
