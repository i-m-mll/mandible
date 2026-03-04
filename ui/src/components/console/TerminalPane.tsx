// Bug: b949700 — Console tab: xterm.js terminal pane with WebSocket PTY and SSE stream events
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ConsoleSession } from '../../state';
import { StreamRenderer } from '../stream-renderer/StreamRenderer';
import type { StreamEvent } from '../stream-renderer/types';
import { ViewToggle } from './ViewToggle';

type ViewMode = 'terminal' | 'rich';

type TerminalPaneProps = {
  sessionId: string;
  interactionMode: ConsoleSession['interaction_mode'];
  isVisible: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
};

export function TerminalPane({
  sessionId,
  interactionMode,
  isVisible,
  viewMode,
  onViewModeChange,
}: TerminalPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Pre-ready write queue: holds binary frames that arrived before xterm had non-zero cols
  const pendingWritesRef = useRef<Uint8Array[]>([]);
  // Refs to track current prop values inside effects/callbacks that capture stale closures
  const isVisibleRef = useRef(isVisible);
  const viewModeRef = useRef(viewMode);

  // WebSocket connection state
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');

  // SSE stream events for rich view (accumulated)
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [streaming, setStreaming] = useState(false);

  // Keep visibility/viewMode refs current so ResizeObserver callback doesn't see stale values
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  // Initialize xterm.js terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      theme: {
        background: '#0b0f14',
        foreground: '#e6edf3',
        cursor: '#4da3ff',
      },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // ResizeObserver: refit when container dimensions change.
    // Use isVisibleRef/viewModeRef instead of the captured isVisible/viewMode props
    // to avoid stale closure values (effect deps are [sessionId] only).
    const observer = new ResizeObserver(() => {
      // Skip fit when not visible — xterm would use wrong dimensions (0×0)
      if (!isVisibleRef.current || viewModeRef.current !== 'terminal') return;
      try {
        fitAddon.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {
        // ignore fit errors on hidden containers
      }
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Open WebSocket for PTY
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/terminal/${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('open');
      // Fit and send initial resize so server knows the viewport.
      // Guard: skip fit if the container has zero dimensions (pane is hidden behind
      // another tab). The ResizeObserver + isVisible effect will fit correctly once
      // the pane becomes visible. Sending a 0-column resize crashes the PTY output.
      const fitAddon = fitAddonRef.current;
      const term = termRef.current;
      const container = containerRef.current;
      if (fitAddon && term && container && container.offsetWidth > 0) {
        try {
          fitAddon.fit();
        } catch {
          // ignore
        }
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        // Flush any writes that queued before onopen
        if (pendingWritesRef.current.length > 0) {
          for (const bytes of pendingWritesRef.current) {
            term.write(bytes);
          }
          pendingWritesRef.current = [];
        }
      }
    };

    ws.onmessage = (event) => {
      const term = termRef.current;
      if (!term) return;
      if (event.data instanceof ArrayBuffer) {
        // Binary: raw PTY output.
        // Queue writes if xterm hasn't been sized yet (cols=0 silently discards bytes).
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (term.cols > 0) {
          term.write(bytes);
        } else {
          pendingWritesRef.current.push(bytes);
        }
      } else if (typeof event.data === 'string') {
        // JSON control messages (e.g. session metadata, error signals)
        try {
          JSON.parse(event.data);
          // No special handling needed for control messages at this time
        } catch {
          // Plain text fallback — write directly
          term.write(event.data);
        }
      }
    };

    ws.onclose = () => {
      setWsStatus('closed');
    };

    ws.onerror = () => {
      setWsStatus('error');
    };

    return () => {
      ws.close();
    };
  }, [sessionId]);

  // Forward keyboard input to WebSocket.
  // Input is sent as binary (Uint8Array) so the server's isBinary check routes
  // it to the PTY. Text frames are reserved for JSON control messages (resize).
  // Bug: 6a47cec — text frames were silently dropped by the backend JSON parser
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onData((data) => {
      if (interactionMode === 'inbox_only') return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    return () => {
      disposable.dispose();
    };
  }, [sessionId, interactionMode]);

  // When view mode switches back to terminal and pane becomes visible, refit.
  // Use requestAnimationFrame so CSS display:flex has taken effect before we
  // measure — otherwise offsetWidth is still 0 and xterm measures 0 columns.
  useEffect(() => {
    if (isVisible && viewMode === 'terminal') {
      const rafId = requestAnimationFrame(() => {
        const fitAddon = fitAddonRef.current;
        const term = termRef.current;
        if (fitAddon && term) {
          try {
            fitAddon.fit();
            term.focus();
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
          } catch {
            // ignore
          }
          // Flush pending writes that arrived before xterm was sized
          if (pendingWritesRef.current.length > 0) {
            for (const bytes of pendingWritesRef.current) {
              term.write(bytes);
            }
            pendingWritesRef.current = [];
          } else {
            // Queue was already empty — the content may have been lost (e.g. ring buffer
            // replay arrived at 0 cols and was discarded). Fetch the buffer via HTTP as a
            // backstop so the pane shows content even after page-load or WS reconnect.
            const sessionId_ = sessionId; // capture for async
            fetch(`/api/console/sessions/${sessionId_}/buffer`)
              .then(r => r.ok ? r.json() as Promise<{ buffer?: string }> : null)
              .then((data) => {
                if (data?.buffer && termRef.current) {
                  const bytes = Uint8Array.from(atob(data.buffer), c => c.charCodeAt(0));
                  termRef.current.write(bytes);
                }
              })
              .catch(() => {}); // non-fatal backstop
          }
        }
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [isVisible, viewMode, sessionId]);

  // SSE: subscribe to console:stream_event for the rich view.
  // The server broadcasts: { console_session_id, event: StreamEvent }
  // app.tsx spreads payload.data into the CustomEvent detail, so:
  //   detail = { console_session_id, event: { type, ... } }
  // We extract detail.event to get the raw StreamEvent.
  useEffect(() => {
    const handleStreamEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ console_session_id: string; event: StreamEvent }>).detail;
      if (!detail || detail.console_session_id !== sessionId) return;
      const streamEvent = detail.event;
      if (!streamEvent) return;
      setStreamEvents((prev) => [...prev, streamEvent]);
      // Mark streaming active when first event arrives; clear on result/stop
      if (streamEvent.type === 'result') {
        setStreaming(false);
      } else {
        setStreaming(true);
      }
    };

    window.addEventListener('console:stream_event', handleStreamEvent);
    return () => {
      window.removeEventListener('console:stream_event', handleStreamEvent);
      setStreamEvents([]);
      setStreaming(false);
    };
  }, [sessionId]);

  const handleReconnect = () => {
    // Close existing WS and reopen by re-mounting the effect
    // This is handled by triggering a state change that causes the WS effect to re-run.
    // We do this by closing and letting the effect cleanup handle it; user must navigate away and back.
    // For now, close the current WS — the effect will NOT auto-reconnect (manual reconnect UX).
    if (wsRef.current) {
      wsRef.current.close();
    }
    // Re-trigger WS connection: navigate to same session hash to force re-mount
    // This is a deliberate limitation per the plan: manual reconnect, no auto-loop
    const ws_protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${ws_protocol}//${window.location.host}/terminal/${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('open');
      const fitAddon = fitAddonRef.current;
      const term = termRef.current;
      if (fitAddon && term) {
        try { fitAddon.fit(); } catch { /* ignore */ }
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    ws.onmessage = (event) => {
      const term = termRef.current;
      if (!term) return;
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else if (typeof event.data === 'string') {
        try { JSON.parse(event.data); } catch { term.write(event.data); }
      }
    };
    ws.onclose = () => setWsStatus('closed');
    ws.onerror = () => setWsStatus('error');
  };

  const showReconnectOverlay = wsStatus === 'closed' || wsStatus === 'error';

  return (
    <div
      className="terminal-pane"
      style={{ display: isVisible ? 'flex' : 'none' }}
    >
      {/* Pane header: view toggle only — session label is shown in sub-tab bar above */}
      <div className="terminal-pane__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {interactionMode === 'both' && (
            <span
              style={{
                background: 'rgba(77,163,255,0.12)',
                color: 'var(--accent-blue)',
                padding: '2px 8px',
                borderRadius: '999px',
                fontSize: '11px',
                cursor: 'pointer',
              }}
              onClick={() => { window.location.hash = '#/inbox'; }}
              title="View inbox"
            >
              Inbox
            </span>
          )}
          <ViewToggle current={viewMode} onChange={onViewModeChange} />
        </div>
      </div>

      {/* inbox_only mode: yellow banner */}
      {interactionMode === 'inbox_only' && (
        <div className="terminal-pane__inbox-banner">
          Operator receives inbox items. Direct input is disabled.
        </div>
      )}

      {/* Terminal container — always mounted, hidden when rich view is active */}
      <div
        className="terminal-pane__container"
        ref={containerRef}
        style={{ display: viewMode === 'terminal' ? 'flex' : 'none', flex: 1 }}
      />

      {/* Reconnect overlay */}
      {showReconnectOverlay && viewMode === 'terminal' && (
        <div className="terminal-pane__reconnect-overlay">
          <span>
            {wsStatus === 'error' ? 'Connection error' : 'Disconnected'}
          </span>
          <button
            type="button"
            onClick={handleReconnect}
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              background: 'var(--accent-blue)',
              border: 'none',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '14px',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Rich view: StreamRenderer */}
      {viewMode === 'rich' && (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <StreamRenderer
            events={streamEvents}
            streaming={streaming}
            sessionInfo={{ sessionId }}
          />
        </div>
      )}
    </div>
  );
}
