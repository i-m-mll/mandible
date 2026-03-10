// Bug: b949700 — Console tab: xterm.js terminal pane with WebSocket PTY and SSE stream events
// Bug: 1d286c1 — console tab overhaul: reconnect, overlay, SSE events, xterm rendering
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ConsoleSession } from '../../state';
import { StreamRenderer } from '../stream-renderer/StreamRenderer';
import type { StreamEvent, SyntheticPromptEvent } from '../stream-renderer/types';
import { ViewToggle } from './ViewToggle';
import { getConsoleStreamEvents, restartConsoleSession } from '../../api';

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

  // Nonce to re-trigger the WS effect on manual reconnect
  const [reconnectNonce, setReconnectNonce] = useState(0);

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
      lineHeight: 1.2,
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

  // Open WebSocket for PTY — re-runs on sessionId change or manual reconnect (reconnectNonce)
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
      // Stop cursor from appearing active when disconnected
      termRef.current?.blur();
    };

    ws.onerror = () => {
      setWsStatus('error');
    };

    return () => {
      ws.close();
    };
    // reconnectNonce is intentional: incrementing it re-runs this effect to reconnect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reconnectNonce]);

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
            // Bug: 1d286c1 — fixed key: backend returns { data: base64 }, not { buffer: base64 }
            const sessionId_ = sessionId; // capture for async
            fetch(`/api/console/sessions/${sessionId_}/buffer`)
              .then(r => r.ok ? r.json() as Promise<{ data?: string }> : null)
              .then((resp) => {
                if (resp?.data && termRef.current) {
                  const bytes = Uint8Array.from(atob(resp.data), c => c.charCodeAt(0));
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

  // Hydrate rich view with recent stream-json history on mount/session change.
  useEffect(() => {
    let cancelled = false;
    getConsoleStreamEvents<StreamEvent>(sessionId, 500)
      .then((events) => {
        if (cancelled) return;
        setStreamEvents(events);
        const last = events[events.length - 1];
        setStreaming(Boolean(last && last.type !== 'result'));
      })
      .catch(() => {
        if (cancelled) return;
        setStreamEvents([]);
        setStreaming(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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
      setStreamEvents((prev) => {
        const last = prev[prev.length - 1];
        if (last && JSON.stringify(last) === JSON.stringify(streamEvent)) {
          return prev;
        }
        return [...prev, streamEvent];
      });
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

  // Bug: 1d286c1 — handleReconnect now calls backend restart API before opening WS.
  // The previous version only opened a new WS but never restarted the PTY process,
  // so reconnect always got immediately rejected by the backend.
  const handleReconnect = async () => {
    setWsStatus('connecting');
    try {
      await restartConsoleSession(sessionId);
      // Incrementing the nonce re-triggers the WS useEffect to open a fresh connection
      setReconnectNonce((n) => n + 1);
    } catch {
      setWsStatus('error');
    }
  };

  const [prompt, setPrompt] = useState('');

  const handlePromptSubmit = (e: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    // Rich view: write directly to PTY WebSocket (same as terminal view).
    // The PTY runs claude --output-format stream-json; its stream-json events
    // flow through handleData → feedLineParser → broadcast("console:stream_event")
    // → SSE → handleStreamEvent → streamEvents → StreamRenderer.
    // Bug: 48cf5c8 — previous approach called sendConsolePrompt which spawned
    // a separate subprocess that raced with the PTY for conversation state.
    if (viewMode === 'rich') {
      const submittedPrompt = prompt.trim();
      setPrompt('');
      // Optimistic display: append synthetic event immediately before SSE events arrive
      const syntheticEvent: SyntheticPromptEvent = {
        type: 'synthetic_prompt',
        text: submittedPrompt,
        localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
      setStreamEvents((prev) => [...prev, syntheticEvent]);
      setStreaming(true);
      // Write to PTY WebSocket; stream-json events arrive asynchronously via SSE
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(submittedPrompt + '\r'));
      }
      return;
    }

    // Terminal view: send directly to PTY via WebSocket (unchanged path)
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send as binary (Uint8Array) so the server's isBinary check routes it to the PTY.
      // Bug: db5e986 — PTY expects \r (carriage return) for Enter, not \n.
      ws.send(new TextEncoder().encode(prompt + '\r'));
      setPrompt('');
    }
  };

  const showReconnectOverlay = wsStatus === 'closed' || wsStatus === 'error';

  return (
    <div
      className="terminal-pane"
      style={{ display: isVisible ? 'flex' : 'none' }}
    >
      {/* Pane header: view toggle only — session label is shown in sub-tab bar above.
          Bug: 1d286c1 — header is outside .terminal-pane__body so the reconnect overlay
          cannot cover it; users can switch to rich view even when disconnected. */}
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

      {/* Body: everything below the header. Reconnect overlay is scoped here,
          so it cannot cover the header/ViewToggle. */}
      <div className="terminal-pane__body">
        {/* Terminal container — always mounted, hidden when rich view is active */}
        <div
          className="terminal-pane__container"
          ref={containerRef}
          style={{ display: viewMode === 'terminal' ? 'flex' : 'none', flex: 1 }}
        />

        {/* Reconnect overlay — only covers the body area, not the header */}
        {showReconnectOverlay && viewMode === 'terminal' && (
          <div className="terminal-pane__reconnect-overlay">
            <span>
              {wsStatus === 'error' ? 'Connection error' : 'Disconnected'}
            </span>
            <button
              type="button"
              onClick={() => { void handleReconnect(); }}
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
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            {/* Bug: db5e986 — min-height:0 is required on flex column children so the
                scrollable region doesn't overflow its container and push the input bar
                below the visible area. Without it, flex items default to min-height:auto
                which lets them grow beyond the parent's bounds. */}
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              <StreamRenderer
                events={streamEvents}
                streaming={streaming}
                sessionInfo={{ sessionId }}
              />
            </div>
            {/* Bug: aea2c67 — prompt input bar in rich view */}
            <form
              onSubmit={handlePromptSubmit}
              style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--border-subtle)',
                background: 'var(--bg-inset)',
                display: 'flex',
                gap: '12px',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <input
                type="text"
                value={prompt}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                placeholder="Send a message to the agent..."
                disabled={interactionMode === 'inbox_only'}
                style={{
                  flex: 1,
                  background: 'var(--bg-page)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  padding: '10px 14px',
                  color: 'var(--fg-default)',
                  fontSize: '14px',
                  fontFamily: 'var(--font-sans)',
                  outline: 'none',
                }}
              />
              <button
                type="submit"
                disabled={!prompt.trim() || interactionMode === 'inbox_only'}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  background: prompt.trim() ? 'var(--accent-blue)' : 'var(--bg-muted)',
                  color: '#fff',
                  border: 'none',
                  cursor: prompt.trim() ? 'pointer' : 'default',
                  fontSize: '13px',
                  fontWeight: 600,
                  transition: 'background 0.2s ease',
                }}
              >
                Send
              </button>
            </form>
          </div>
        )}

        {/* Rich view disconnected banner */}
        {viewMode === 'rich' && showReconnectOverlay && (
          <div className="terminal-pane__rich-disconnected">
            Session disconnected —{' '}
            <button
              type="button"
              onClick={() => { void handleReconnect(); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-blue)',
                cursor: 'pointer',
                padding: 0,
                fontSize: 'inherit',
                fontFamily: 'inherit',
                textDecoration: 'underline',
              }}
            >
              Restart
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
