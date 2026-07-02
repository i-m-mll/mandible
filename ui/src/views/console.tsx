// Bug: b949700 — Console tab: top-level view component
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useState } from 'preact/hooks';
import type { ConsoleSession } from '../state';
import { ConsoleSubTabBar } from '../components/console/ConsoleSubTabBar';
import { TerminalPane } from '../components/console/TerminalPane';
import { NewSessionDialog } from '../components/console/NewSessionDialog';

type ViewMode = 'terminal' | 'rich' | 'events';

type ConsoleViewProps = {
  sessions: ConsoleSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onNewSession: (input: {
    label: string;
    backend: string;
    kind: string;
    backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
    channel_enabled?: boolean;
    presetIds?: string[];
  }) => void;
  isActive: boolean;
  initialSessionId: string | null;
  /** Pre-selected preset ID from navigation (e.g., "Start Chat" from Presets tab). */
  initialPresetId?: string | null;
};

export function ConsoleView({
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  isActive,
  initialSessionId,
  initialPresetId,
}: ConsoleViewProps): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(Boolean(initialPresetId));
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
  // rich-first by default. Operator sessions may still expose a debug terminal.
  const getViewMode = (sessionId: string): ViewMode => {
    if (sessionId in viewModes) return viewModes[sessionId];
    return 'rich';
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
                background: 'var(--bg-hover)',
                border: '1px solid var(--border-subtle)',
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
              backendType={session.backend_type}
              allowedTools={session.allowed_tools}
              command={session.command ?? session.agent_type}
              sessionArgs={session.args ?? []}
              isOperator={session.is_operator}
              interactionMode={session.interaction_mode}
              sessionStatus={session.status}
              providerSessionId={session.provider_session_id}
              isVisible={session.id === activeSessionId}
              viewMode={getViewMode(session.id)}
              onViewModeChange={(mode) => handleViewModeChange(session.id, mode)}
              resumeAtMessage={session.resume_at_message}
              channelEnabled={!!session.channel_enabled}
            />
          ))
        )}
      </div>

      <NewSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={onNewSession}
        initialPresetId={initialPresetId}
      />
    </div>
  );
}
