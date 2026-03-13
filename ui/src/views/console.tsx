// Bug: b949700 — Console tab: top-level view component
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import type { ConsoleSession } from '../state';
import { ConsoleSubTabBar } from '../components/console/ConsoleSubTabBar';
import { TerminalPane } from '../components/console/TerminalPane';
import { NewSessionDialog } from '../components/console/NewSessionDialog';

type ViewMode = 'terminal' | 'rich';

type ConsoleViewProps = {
  sessions: ConsoleSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onNewSession: (input: { label: string; backend: string; kind: string }) => void;
  isActive: boolean;
  initialSessionId: string | null;
};

export function ConsoleView({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  isActive,
  initialSessionId,
}: ConsoleViewProps): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Per-session view mode stored locally: Record<sessionId, ViewMode>
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>({});

  useEffect(() => {
    if (!initialSessionId) return;
    if (!sessions.some((session) => session.id === initialSessionId)) return;
    if (activeSessionId === initialSessionId) return;
    onSelectSession(initialSessionId);
  }, [activeSessionId, initialSessionId, onSelectSession, sessions]);

  // Auto-select the operator/pinned session on first open if nothing is active
  useEffect(() => {
    if (initialSessionId) return;
    if (activeSessionId === null && sessions.length > 0) {
      // Prefer operator session first, then first pinned, then first by created_at
      const operatorSession = sessions.find(
        (s) => s.agent_type === 'operator' && s.pinned,
      );
      const pinnedSession = sessions.find((s) => s.pinned);
      const firstSession = [...sessions].sort((a, b) => a.created_at - b.created_at)[0];
      const target = operatorSession ?? pinnedSession ?? firstSession;
      if (target) {
        onSelectSession(target.id);
      }
    }
  }, [activeSessionId, sessions, onSelectSession]);

  // Claude-backed chat sessions get the chat view by default. Other agents stay
  // terminal-first until they emit a reliable structured stream for the renderer.
  const getViewMode = (sessionId: string): ViewMode => {
    if (sessionId in viewModes) return viewModes[sessionId];
    const session = sessions.find((s) => s.id === sessionId);
    if (session && (session.agent_type === 'claude' || session.agent_type === 'operator')) {
      return 'rich';
    }
    return 'terminal';
  };

  const handleViewModeChange = (sessionId: string, mode: ViewMode) => {
    setViewModes((prev) => ({ ...prev, [sessionId]: mode }));
  };

  return (
    <div className="console-view">
      <ConsoleSubTabBar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={onSelectSession}
        onClose={onCloseSession}
        onNewSession={() => setDialogOpen(true)}
        isConsoleActive={isActive}
      />

      {/* Terminal panes: render all, show only the active one */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {sessions.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: '12px',
              color: 'var(--text-muted)',
              fontSize: '14px',
            }}
          >
            <div>No console sessions</div>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              style={{
                padding: '8px 20px',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: 'var(--font-sans)',
              }}
            >
              + New Session
            </button>
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalPane
              key={session.id}
              sessionId={session.id}
              agentType={session.agent_type}
              interactionMode={session.interaction_mode}
              sessionStatus={session.status}
              providerSessionId={session.provider_session_id}
              isVisible={session.id === activeSessionId}
              viewMode={getViewMode(session.id)}
              onViewModeChange={(mode) => handleViewModeChange(session.id, mode)}
            />
          ))
        )}
      </div>

      <NewSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={onNewSession}
      />
    </div>
  );
}
