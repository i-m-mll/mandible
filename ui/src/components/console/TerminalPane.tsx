import { useState } from 'preact/hooks';
import type { ConsoleSession } from '../../state';
import { useTerminalView } from './useTerminalView';
import { DetailPaneNotice } from '../shared/DetailPaneNotice';

export type ViewMode = 'terminal' | 'rich' | 'events';

/** Real terminals carry raw PTY bytes. Managed conversations render in Chats. */
export function TerminalPane({ sessionId, sessionStatus, isVisible }: {
  sessionId: string; sessionStatus: ConsoleSession['status']; isVisible: boolean;
}) {
  const terminal = useTerminalView({ sessionId, backendType:'pty', interactionMode:'direct', isVisible, viewMode:'terminal' });
  const [error, setError] = useState<string | null>(null);
  const action = async (run: () => Promise<void>) => {
    setError(null);
    try { await run(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="terminal-pane">
    {error && <DetailPaneNotice severity="error" density="compact" title="Terminal action failed">{error}</DetailPaneNotice>}
    <div className="terminal-pane__body">
      <div className="terminal-container" ref={terminal.containerRef} />
    </div>
    {sessionStatus !== 'running' ? <button type="button" onClick={() => void action(terminal.handleStartDebugTerminal)}>Start terminal</button>
      : terminal.wsStatus === 'closed' || terminal.wsStatus === 'error' ? <button type="button" onClick={() => void action(terminal.handleReconnect)}>Reconnect terminal</button> : null}
  </div>;
}
