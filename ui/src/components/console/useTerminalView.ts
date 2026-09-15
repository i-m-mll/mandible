import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { restartConsoleSession, startConsoleSession } from '../../api';
import { getTerminalTheme } from '../../theme';
import { browserSessionFetch } from '../../client-auth-token';

export type TerminalViewState = {
  containerRef: { current: HTMLDivElement | null };
  wsStatus: 'connecting' | 'open' | 'closed' | 'error';
  showDebugTerminal: boolean;
  handleReconnect: () => Promise<void>;
  handleStartDebugTerminal: () => Promise<void>;
  sendTerminalPrompt: (prompt: string) => boolean;
};

export function useTerminalView({
  sessionId,
  backendType,
  interactionMode,
  isVisible,
  viewMode,
}: {
  sessionId: string;
  backendType: string;
  interactionMode: string;
  isVisible: boolean;
  viewMode: 'terminal' | 'rich' | 'events';
}): TerminalViewState {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingWritesRef = useRef<Uint8Array[]>([]);
  const isVisibleRef = useRef(isVisible);
  const viewModeRef = useRef(viewMode);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const showDebugTerminal = backendType === 'pty';

  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  useEffect(() => {
    if (!showDebugTerminal) return;
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 1.2,
      theme: getTerminalTheme(containerRef.current),
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

    const observer = new ResizeObserver(() => {
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

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, showDebugTerminal]);

  useEffect(() => {
    if (!showDebugTerminal) return;
    if (typeof document === 'undefined') return;
    const applyTheme = () => {
      const term = termRef.current;
      const container = containerRef.current;
      if (term && container) {
        term.options.theme = getTerminalTheme(container);
      }
    };
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-terminal-theme'],
    });
    return () => observer.disconnect();
  }, [showDebugTerminal]);

  useEffect(() => {
    if (!showDebugTerminal) {
      setWsStatus('closed');
      return;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/terminal/${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl, ['mandible']);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('open');
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
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (term.cols > 0) {
          term.write(bytes);
        } else {
          pendingWritesRef.current.push(bytes);
        }
      } else if (typeof event.data === 'string') {
        try {
          JSON.parse(event.data);
        } catch {
          term.write(event.data);
        }
      }
    };

    ws.onclose = () => {
      setWsStatus('closed');
      termRef.current?.blur();
    };

    ws.onerror = () => {
      setWsStatus('error');
    };

    return () => {
      ws.close();
    };
  }, [sessionId, reconnectNonce, showDebugTerminal]);

  useEffect(() => {
    if (!showDebugTerminal) return;
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
  }, [sessionId, interactionMode, showDebugTerminal]);

  useEffect(() => {
    if (!showDebugTerminal) return;
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
          if (pendingWritesRef.current.length > 0) {
            for (const bytes of pendingWritesRef.current) {
              term.write(bytes);
            }
            pendingWritesRef.current = [];
          } else {
            const sessionId_ = sessionId;
            browserSessionFetch(`/api/console/sessions/${sessionId_}/buffer`)
              .then((response) => response.ok ? response.json() as Promise<{ data?: string }> : null)
              .then((resp) => {
                if (resp?.data && termRef.current) {
                  const bytes = Uint8Array.from(atob(resp.data), (char) => char.charCodeAt(0));
                  termRef.current.write(bytes);
                }
              })
              .catch(() => {});
          }
        }
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [isVisible, viewMode, sessionId, showDebugTerminal]);

  const handleReconnect = async () => {
    setWsStatus('connecting');
    termRef.current?.reset();
    pendingWritesRef.current = [];
    try {
      await restartConsoleSession(sessionId);
      setReconnectNonce((n) => n + 1);
    } catch {
      setWsStatus('error');
    }
  };

  const handleStartDebugTerminal = async () => {
    termRef.current?.reset();
    pendingWritesRef.current = [];
    try {
      await startConsoleSession(sessionId);
      setReconnectNonce((n) => n + 1);
    } catch {
      setWsStatus('error');
    }
  };

  const sendTerminalPrompt = (prompt: string): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(prompt + '\r'));
      return true;
    }
    return false;
  };

  return {
    containerRef,
    wsStatus,
    showDebugTerminal,
    handleReconnect,
    handleStartDebugTerminal,
    sendTerminalPrompt,
  };
}
