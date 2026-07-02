import type { JSX } from 'preact/jsx-runtime';
import type { ViewMode } from './TerminalPane';
import { ViewToggle } from './ViewToggle';

export function TerminalPaneHeader({
  viewMode,
  onViewModeChange,
  showDebugTerminal,
  channelEnabled,
  unseenEventCount,
  workspaceMode,
  providerSessionId,
  onSidebarToggle,
}: {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  showDebugTerminal: boolean;
  channelEnabled: boolean;
  unseenEventCount: number;
  workspaceMode: boolean;
  providerSessionId: string | null;
  onSidebarToggle: () => void;
}): JSX.Element {
  return (
    <div className="terminal-pane__header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <ViewToggle
          current={viewMode}
          onChange={onViewModeChange}
          showTerminal={showDebugTerminal}
          channelEnabled={channelEnabled}
          unseenEventCount={unseenEventCount}
        />
      </div>
      {!workspaceMode && (
        <div className="terminal-pane__header-actions">
          <button type="button" className="terminal-pane__link-btn" onClick={() => { window.location.hash = '#/inbox'; }}>
            View inbox
          </button>
          {providerSessionId && (
            <button
              type="button"
              className="terminal-pane__link-btn"
              onClick={() => { window.location.hash = `#/console?session=${encodeURIComponent(providerSessionId)}`; }}
            >
              View history
            </button>
          )}
          <button
            type="button"
            className="terminal-pane__link-btn"
            onClick={onSidebarToggle}
            title="Session settings"
          >
            ⋮
          </button>
        </div>
      )}
    </div>
  );
}
