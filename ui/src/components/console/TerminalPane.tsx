// Bug: b949700 — Console tab: xterm.js terminal pane with WebSocket PTY and SSE stream events
// Bug: 1d286c1 — console tab overhaul: reconnect, overlay, SSE events, xterm rendering
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ConsoleSession } from '../../state';
import type { ConsolePermissionRequest } from '../../api';
import { StreamRenderer } from '../stream-renderer/StreamRenderer';
import type { StreamEvent, ToolResultContentBlock } from '../stream-renderer/types';
import { ViewToggle } from './ViewToggle';
import { PermissionDialog } from './PermissionDialog';
import { SessionControls } from './SessionControls';
import { PtyBanner } from './PtyBanner';
import { LivePresetPills } from './LivePresetPills';
import { ContextIndicator } from '../presets/ContextIndicator';
import {
  getConversation,
  getConversations,
  getConsolePermissions,
  getConsoleStreamEvents,
  getPresetUnion,
  restartConsoleSession,
  respondToConsolePermission,
  sendConsolePrompt,
  startConsoleSession,
} from '../../api';
import type { PresetUnion } from '../../api';

type ViewMode = 'terminal' | 'rich';
type ActiveSubagent = {
  agent_id: string;
  agent_type: string;
  parent_agent_id: string | null;
  depth: number;
};

type TerminalPaneProps = {
  sessionId: string;
  agentType: ConsoleSession['agent_type'];
  backendType: ConsoleSession['backend_type'];
  allowedTools?: string[] | null;
  command: string;
  sessionArgs: string[];
  isOperator: boolean;
  interactionMode: ConsoleSession['interaction_mode'];
  sessionStatus: ConsoleSession['status'];
  providerSessionId: string | null;
  isVisible: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  // Bug: e4845f6 — DAG leaf for history-first hydration path filtering
  resumeAtMessage?: string | null;
};

const MODEL_OPTIONS: Record<string, string[]> = {
  claude: ['sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opusplan'],
  gemini: [
    'auto',
    'pro',
    'flash',
    'flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
};

function parseModelFromArgs(args: string[]): string | undefined {
  for (let i = args.length - 2; i >= 0; i -= 1) {
    const arg = args[i];
    if ((arg === '--model' || arg === '-m') && args[i + 1]?.trim()) {
      return args[i + 1].trim();
    }
  }
  return undefined;
}

// Bug: 309dd56 — Derive streaming state from the last event in a list.
// Extracted helper to avoid duplicating this pattern across hydration paths.
function deriveStreamingState(
  events: StreamEvent[],
  streamStartAtRef: { current: number | null },
): boolean {
  const last = events[events.length - 1];
  const isStreaming = Boolean(last && last.type !== 'result');
  if (isStreaming && streamStartAtRef.current === null) {
    streamStartAtRef.current = Date.now();
  }
  return isStreaming;
}

// Bug: 309dd56 — Flush pending SSE events after hydration, deduplicating against current state.
function flushPendingSSE(
  pendingSSERef: { current: StreamEvent[] },
  setStreamEvents: (fn: (prev: StreamEvent[]) => StreamEvent[]) => void,
  setStreaming: (v: boolean) => void,
): void {
  const pending = pendingSSERef.current;
  pendingSSERef.current = [];
  if (pending.length === 0) return;
  setStreamEvents(prev => {
    // Deduplicate: skip pending events that match existing events in prev
    const newEvents = pending.filter(pe => {
      const peJson = JSON.stringify(pe);
      return !prev.some(existing => JSON.stringify(existing) === peJson);
    });
    return newEvents.length > 0 ? [...prev, ...newEvents] : prev;
  });
  const lastPending = pending[pending.length - 1];
  if (lastPending?.type === 'result') {
    setStreaming(false);
  }
}

// Bug: 309dd56 — Compute the "live tail": in-memory stream events not yet persisted to
// conversation history. Uses assistant-turn counting as the handoff point.
function computeLiveTail(
  historyEvents: StreamEvent[],
  memEvents: StreamEvent[],
): StreamEvent[] {
  const historyAssistantCount = historyEvents.filter((e) => e.type === 'assistant').length;

  if (historyAssistantCount === 0) {
    // History has no assistant turns — all mem events are potentially new
    return memEvents;
  }

  // Walk memEvents counting assistant events. Once we've seen historyAssistantCount
  // assistant events, everything AFTER that point (including tool results for the
  // last matched turn) is the live tail.
  let assistantsSeen = 0;
  let tailStart = memEvents.length; // default: no tail (history covers everything)

  for (let i = 0; i < memEvents.length; i++) {
    if (memEvents[i].type === 'assistant') {
      assistantsSeen++;
    }
    if (assistantsSeen === historyAssistantCount) {
      // Skip past any remaining events that belong to this last matched turn
      // (tool_result user events that are part of the same assistant turn)
      tailStart = i + 1;
      while (tailStart < memEvents.length) {
        const next = memEvents[tailStart];
        if (next.type === 'user' && 'message' in next) {
          const content = (next as { message: { content?: unknown[] } }).message.content;
          if (Array.isArray(content) && content.every((b: Record<string, unknown>) => b.type === 'tool_result')) {
            tailStart++;
            continue;
          }
        }
        break;
      }
      break;
    }
  }

  return memEvents.slice(tailStart);
}

function collectAvailableTools(events: StreamEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as StreamEvent & { tools?: unknown };
    if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools)) {
      return event.tools.filter((tool): tool is string => typeof tool === 'string');
    }
  }
  return [];
}

function readParentAgentId(event: Record<string, unknown> | undefined): string | null {
  if (!event) {
    return null;
  }
  const candidates = [
    event.parent_agent_id,
    event.parentAgentId,
    event.parentAgentID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

function buildActiveSubagents(events: StreamEvent[]): ActiveSubagent[] {
  const active = new Map<string, Omit<ActiveSubagent, 'depth'> & { started_at: number }>();

  for (const rawEvent of events) {
    const event = rawEvent as StreamEvent & {
      agent_id?: unknown;
      agent_type?: unknown;
      event?: Record<string, unknown>;
    };
    if (event.type !== 'system') {
      continue;
    }
    if (event.subtype === 'subagent_start' && typeof event.agent_id === 'string') {
      active.set(event.agent_id, {
        agent_id: event.agent_id,
        agent_type: typeof event.agent_type === 'string' ? event.agent_type : 'subagent',
        parent_agent_id: readParentAgentId(event.event),
        started_at: active.get(event.agent_id)?.started_at ?? Date.now(),
      });
      continue;
    }
    if (event.subtype === 'subagent_stop' && typeof event.agent_id === 'string') {
      active.delete(event.agent_id);
    }
  }

  const depthFor = (agentId: string, seen = new Set<string>()): number => {
    const entry = active.get(agentId);
    if (!entry?.parent_agent_id || !active.has(entry.parent_agent_id) || seen.has(agentId)) {
      return 0;
    }
    seen.add(agentId);
    return depthFor(entry.parent_agent_id, seen) + 1;
  };

  return Array.from(active.values())
    .sort((left, right) => left.started_at - right.started_at)
    .map((entry) => ({
      agent_id: entry.agent_id,
      agent_type: entry.agent_type,
      parent_agent_id: entry.parent_agent_id,
      depth: depthFor(entry.agent_id),
    }));
}

function conversationBlocksToStreamEvents(
  providerSessionId: string,
  blocks: Array<{
    type: string;
    content: string;
    metadata_json: string;
  }>,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  let assistantBlocks: Array<Record<string, unknown>> = [];

  const flushAssistant = () => {
    if (assistantBlocks.length === 0) return;
    events.push({
      type: 'assistant',
      session_id: providerSessionId,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: assistantBlocks as Array<{ type: string; [key: string]: unknown }>,
      },
    });
    assistantBlocks = [];
  };

  for (const block of blocks) {
    const metadata = (() => {
      try {
        return JSON.parse(block.metadata_json || '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    })();

    if (block.type === 'user_message') {
      flushAssistant();
      events.push({
        type: 'user',
        session_id: providerSessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: block.content }],
        },
      });
      continue;
    }

    if (block.type === 'assistant_message') {
      assistantBlocks.push({ type: 'text', text: block.content });
      continue;
    }

    if (block.type === 'thinking') {
      assistantBlocks.push({ type: 'thinking', thinking: block.content });
      continue;
    }

    if (block.type === 'tool_use') {
      assistantBlocks.push({
        type: 'tool_use',
        id: String(metadata.tool_id ?? `tool-${events.length}`),
        name: String(metadata.tool_name ?? 'tool'),
        input: (metadata.tool_input as Record<string, unknown> | undefined) ?? {},
      });
      continue;
    }

    if (block.type === 'tool_result') {
      const toolResult: ToolResultContentBlock = {
        type: 'tool_result',
        tool_use_id: String(metadata.tool_id ?? ''),
        content: block.content,
      };
      events.push({
        type: 'user',
        session_id: providerSessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [toolResult],
        },
      });
      continue;
    }
  }

  flushAssistant();
  return events;
}

export function TerminalPane({
  sessionId,
  agentType,
  backendType,
  allowedTools,
  command,
  sessionArgs,
  isOperator,
  interactionMode,
  sessionStatus,
  providerSessionId,
  isVisible,
  viewMode,
  onViewModeChange,
  resumeAtMessage,
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
  // Bug: 309dd56 — SSE buffering during hydration: prevent clobbering freshly-set history
  const hydratingRef = useRef(false);
  const pendingSSERef = useRef<StreamEvent[]>([]);

  // WebSocket connection state
  const [wsStatus, setWsStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');

  // Nonce to re-trigger the WS effect on manual reconnect
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // SSE stream events for rich view (accumulated)
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [hydratingHistory, setHydratingHistory] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | undefined>(undefined);
  const streamStartAtRef = useRef<number | null>(null);
  const [model, setModel] = useState<string | undefined>(() => parseModelFromArgs(sessionArgs));
  const [permissionQueue, setPermissionQueue] = useState<ConsolePermissionRequest[]>([]);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [activeSubagents, setActiveSubagents] = useState<ActiveSubagent[]>([]);
  // Bug: 6634023 — Sidebar state for SessionControls (collapsed by default)
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Bug: 11f4f47 — Track preset union token count for ContextIndicator
  const [presetTokenCount, setPresetTokenCount] = useState(0);
  // Bug: 8d3328c — Only PTY sessions have a debug terminal. Spawn sessions
  // have no terminal emulation. Operator sessions always use SDK now (not spawn).
  const showDebugTerminal = backendType === 'pty';
  const providerFamily = isOperator ? 'claude' : command;
  const availableTools = collectAvailableTools(streamEvents);

  // Keep visibility/viewMode refs current so ResizeObserver callback doesn't see stale values
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { setModel(parseModelFromArgs(sessionArgs)); }, [sessionArgs]);

  // Initialize xterm.js terminal
  useEffect(() => {
    if (!showDebugTerminal) return;
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
  }, [sessionId, showDebugTerminal]);

  // Open WebSocket for PTY — re-runs on sessionId change or manual reconnect (reconnectNonce)
  useEffect(() => {
    if (!showDebugTerminal) {
      setWsStatus('closed');
      return;
    }
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
  }, [sessionId, reconnectNonce, showDebugTerminal]);

  // Forward keyboard input to WebSocket.
  // Input is sent as binary (Uint8Array) so the server's isBinary check routes
  // it to the PTY. Text frames are reserved for JSON control messages (resize).
  // Bug: 6a47cec — text frames were silently dropped by the backend JSON parser
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

  // When view mode switches back to terminal and pane becomes visible, refit.
  // Use requestAnimationFrame so CSS display:flex has taken effect before we
  // measure — otherwise offsetWidth is still 0 and xterm measures 0 columns.
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
  }, [isVisible, viewMode, sessionId, showDebugTerminal]);

  // Bug: 309dd56 — Hydrate rich view: conversation history is the authoritative base layer,
  // with in-memory stream events providing only the "live tail" (events not yet persisted).
  useEffect(() => {
    let cancelled = false;
    hydratingRef.current = true;
    pendingSSERef.current = [];

    // Case 1: No provider session — use in-memory events directly (no conversation to look up)
    if (!providerSessionId) {
      getConsoleStreamEvents<StreamEvent>(sessionId, 500)
        .then((events) => {
          if (cancelled) return;
          setStreamEvents(events);
          setStreaming(deriveStreamingState(events, streamStartAtRef));
        })
        .catch(() => {
          if (cancelled) return;
          setStreamEvents([]);
          setStreaming(false);
        })
        .finally(() => {
          if (!cancelled) {
            hydratingRef.current = false;
            flushPendingSSE(pendingSSERef, setStreamEvents, setStreaming);
          }
        });
      return () => { cancelled = true; };
    }

    // Case 2: Has provider session — fetch both conversation history and in-memory events
    setHydratingHistory(true);
    const historyPromise = getConversations({ session_id: providerSessionId, limit: 1 })
      .then(async ({ conversations }) => {
        const conversation = conversations[0];
        if (!conversation) return null;
        // Bug: e4845f6 — Pass leaf (resume_at_message) for DAG path filtering
        const detail = await getConversation(conversation.id, resumeAtMessage || undefined);
        return conversationBlocksToStreamEvents(providerSessionId, detail.blocks);
      })
      .catch(() => null);

    const memPromise = getConsoleStreamEvents<StreamEvent>(sessionId, 500).catch(() => [] as StreamEvent[]);

    Promise.all([historyPromise, memPromise])
      .then(([historyEvents, memEvents]) => {
        if (cancelled) return;

        if (historyEvents && historyEvents.length > 0) {
          // History available — compute live tail from in-memory events
          const liveTail = computeLiveTail(historyEvents, memEvents);
          // Bug: 309dd56 — Extract system events (init, hooks, subagent events) from the
          // portion of memEvents NOT in the live tail. conversationBlocksToStreamEvents
          // only produces user/assistant events, so system events would otherwise be lost.
          const tailStartIndex = memEvents.length - liveTail.length;
          const systemEvents = memEvents
            .slice(0, tailStartIndex)
            .filter(e => e.type === 'system');
          const allEvents = [...systemEvents, ...historyEvents, ...liveTail];
          setStreamEvents(allEvents);
          setStreaming(deriveStreamingState(allEvents, streamStartAtRef));
        } else {
          // No conversation history yet (new session, JSONL not written) — use mem events
          setStreamEvents(memEvents);
          setStreaming(deriveStreamingState(memEvents, streamStartAtRef));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStreamEvents([]);
        setStreaming(false);
      })
      .finally(() => {
        if (!cancelled) {
          setHydratingHistory(false);
          hydratingRef.current = false;
          flushPendingSSE(pendingSSERef, setStreamEvents, setStreaming);
        }
      });

    return () => { cancelled = true; };
  }, [providerSessionId, sessionId, resumeAtMessage]);

  // Bug: 2a04856 — Polling fallback: if streaming stays true for 20s (missed SSE result event,
  // e.g. due to SSE reconnect during daemon rebuild), re-fetch events and check for completion.
  useEffect(() => {
    if (!streaming) return;
    const timer = setTimeout(() => {
      void getConsoleStreamEvents<StreamEvent>(sessionId, 500).then((events) => {
        if (events.length > 0) {
          const last = events[events.length - 1];
          if (last.type === 'result') {
            setStreamEvents(events);
            setStreaming(false);
          }
        }
      }).catch(() => {
        // Non-fatal: will retry on next interval if still streaming
      });
    }, 20_000);
    return () => clearTimeout(timer);
  }, [streaming, sessionId]);

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

      // Bug: 309dd56 — Buffer SSE events during hydration to prevent clobbering
      if (hydratingRef.current) {
        pendingSSERef.current.push(streamEvent);
        // Still update streaming state for UI feedback
        if (streamEvent.type === 'result') {
          setStreaming(false);
        } else {
          setStreaming(true);
        }
        return;
      }

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

  // Bug: 2a54b51 — Derive streamStartAt from stream events so the elapsed timer
  // survives component re-mounts (tab switches). The synthetic_prompt localId
  // encodes Date.now() as "sp-<timestamp>-<rand>". Falling back to Date.now()
  // only if no synthetic prompt is found.
  useEffect(() => {
    if (!streaming) {
      streamStartAtRef.current = null;
      return;
    }
    if (streamStartAtRef.current === null) {
      // Scan backwards for the last synthetic_prompt or user text message
      // to recover the actual activity start time.
      let recovered = false;
      for (let i = streamEvents.length - 1; i >= 0; i--) {
        const ev = streamEvents[i];
        if (ev.type === 'synthetic_prompt') {
          const localId = (ev as { localId?: string }).localId;
          if (localId) {
            const match = localId.match(/^sp-(\d+)-/);
            if (match) {
              streamStartAtRef.current = Number(match[1]);
              recovered = true;
              break;
            }
          }
        }
        // Stop scanning once we hit a result event (previous turn boundary)
        if (ev.type === 'result') break;
      }
      if (!recovered) {
        streamStartAtRef.current = Date.now();
      }
    }
    setElapsedSeconds(Math.floor((Date.now() - streamStartAtRef.current) / 1000));
    const interval = window.setInterval(() => {
      if (streamStartAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - streamStartAtRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [streaming, streamEvents]);

  useEffect(() => {
    if (backendType !== 'sdk') {
      setActiveSubagents([]);
      return;
    }
    setActiveSubagents(buildActiveSubagents(streamEvents));
  }, [backendType, streamEvents]);

  // Bug: 11f4f47 — Fetch initial preset union token count for SDK sessions
  useEffect(() => {
    if (backendType !== 'sdk') return;
    let cancelled = false;
    getPresetUnion({ session_id: sessionId })
      .then((union: PresetUnion) => {
        if (!cancelled) setPresetTokenCount(union.totalTokens);
      })
      .catch(() => {
        // Non-fatal: indicator stays at 0
      });
    return () => { cancelled = true; };
  }, [backendType, sessionId]);

  // Bug: 1d286c1 — handleReconnect now calls backend restart API before opening WS.
  // The previous version only opened a new WS but never restarted the PTY process,
  // so reconnect always got immediately rejected by the backend.
  const handleReconnect = async () => {
    setWsStatus('connecting');
    termRef.current?.reset();
    pendingWritesRef.current = [];
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

    if (viewMode === 'rich') {
      const submittedPrompt = prompt.trim();
      setPrompt('');
      // Bug: 6634023 — Inject a synthetic_prompt event so the user's message appears
      // immediately in the chat view. The SDK event stream does not echo user prompts.
      const localId = `sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setStreamEvents(prev => [...prev, {
        type: 'synthetic_prompt',
        localId,
        text: submittedPrompt,
      }]);
      setElapsedSeconds(0);
      streamStartAtRef.current = Date.now();
      setStreaming(true);
      void sendConsolePrompt(sessionId, submittedPrompt).catch(() => {
        setStreaming(false);
      });
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

  const showReconnectOverlay = showDebugTerminal && (wsStatus === 'closed' || wsStatus === 'error');
  const showDebugStart = showDebugTerminal && viewMode === 'terminal' && sessionStatus !== 'running';
  const debugTerminalLabel = providerSessionId ? 'Resume debug terminal' : 'Start debug terminal';
  const debugTerminalDescription = providerSessionId
    ? 'Resume this same chat in the provider terminal for raw inspection or recovery.'
    : 'Open the provider terminal for this chat. Once a provider session exists, it will resume here.';

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

  useEffect(() => {
    if (backendType !== 'sdk') {
      setPermissionQueue([]);
      return;
    }

    let cancelled = false;
    getConsolePermissions(sessionId)
      .then((requests) => {
        if (!cancelled) {
          setPermissionQueue(requests);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPermissionQueue([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [backendType, sessionId]);

  useEffect(() => {
    if (backendType !== 'sdk') {
      return undefined;
    }

    const handlePermissionRequest = (
      event: Event,
    ) => {
      const detail = (event as CustomEvent<{
        console_session_id: string;
        request: ConsolePermissionRequest;
      }>).detail;
      if (!detail || detail.console_session_id !== sessionId || !detail.request) {
        return;
      }
      setPermissionQueue((prev) => {
        if (prev.some((request) => request.id === detail.request.id)) {
          return prev;
        }
        return [...prev, detail.request];
      });
    };

    window.addEventListener('console:permission:request', handlePermissionRequest);
    return () => {
      window.removeEventListener('console:permission:request', handlePermissionRequest);
    };
  }, [backendType, sessionId]);

  const handlePermissionResponse = async (
    requestId: string,
    decision: 'deny' | 'allow' | 'allow_always',
  ) => {
    setPermissionBusy(true);
    try {
      await respondToConsolePermission(sessionId, requestId, decision);
      setPermissionQueue((prev) => prev.filter((request) => request.id !== requestId));
    } finally {
      setPermissionBusy(false);
    }
  };

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
          <ViewToggle current={viewMode} onChange={onViewModeChange} showTerminal={showDebugTerminal} />
        </div>
        <div className="terminal-pane__header-actions">
          {providerSessionId && (
            <button
              type="button"
              className="terminal-pane__link-btn"
              onClick={() => { window.location.hash = `#/chat-history?session=${encodeURIComponent(providerSessionId)}`; }}
            >
              View history
            </button>
          )}
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
        {showDebugTerminal && (
          <div
            className="terminal-pane__container"
            ref={containerRef}
            style={{ display: viewMode === 'terminal' ? 'flex' : 'none', flex: 1 }}
          />
        )}

        {/* Reconnect overlay — only covers the body area, not the header */}
        {showReconnectOverlay && viewMode === 'terminal' && !showDebugStart && (
          <div className="terminal-pane__reconnect-overlay">
            <span>
              {wsStatus === 'error' ? 'Debug terminal connection error' : 'Debug terminal disconnected'}
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
              Reconnect terminal
            </button>
          </div>
        )}

        {showDebugStart && (
          <div className="terminal-pane__reconnect-overlay">
            <span>{debugTerminalDescription}</span>
            <button
              type="button"
              onClick={() => { void handleStartDebugTerminal(); }}
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
              {debugTerminalLabel}
            </button>
          </div>
        )}

        {/* Rich view: StreamRenderer + sidebar for SessionControls */}
        {viewMode === 'rich' && (
          <div className="terminal-pane__rich-wrapper">
            {/* Main content column: stream + input */}
            <div className="terminal-pane__rich-main">
              {/* Bug: db5e986 — min-height:0 is required on flex column children so the
                  scrollable region doesn't overflow its container and push the input bar
                  below the visible area. Without it, flex items default to min-height:auto
                  which lets them grow beyond the parent's bounds. */}
              <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                {/* Bug: 11f4f47 — PTY deprecation banner in rich view */}
                {backendType === 'pty' && <PtyBanner />}
                {backendType === 'sdk' && activeSubagents.length > 0 && (
                  <div className="terminal-pane__subagents">
                    <div className="terminal-pane__subagents-title">Active subagents</div>
                    <div className="terminal-pane__subagents-list">
                      {activeSubagents.map((subagent) => (
                        <div
                          key={subagent.agent_id}
                          className="terminal-pane__subagent"
                          style={{ paddingLeft: `${subagent.depth * 18}px` }}
                        >
                          <span className="terminal-pane__subagent-type">{subagent.agent_type}</span>
                          <span className="terminal-pane__subagent-id">{subagent.agent_id}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <StreamRenderer
                  events={streamEvents}
                  streaming={streaming}
                  elapsedSeconds={elapsedSeconds}
                  emptyLabel={hydratingHistory ? 'Loading prior messages…' : undefined}
                  sessionInfo={{
                    sessionId,
                    backend: providerFamily,
                    model,
                  }}
                />
              </div>
              {/* Bug: 11f4f47 — Context indicator bar above the input area */}
              {backendType === 'sdk' && (
                <div style={{ padding: '0 16px', flexShrink: 0 }}>
                  <ContextIndicator tokenCount={presetTokenCount} modelName={model} variant="bar" />
                </div>
              )}
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

            {/* Bug: 6634023 — Collapsible right sidebar for session controls */}
            {!sidebarOpen && (
              <button
                type="button"
                className="terminal-pane__sidebar-toggle"
                onClick={() => setSidebarOpen(true)}
                title="Session settings"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M6.5 1.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75v.3a5.45 5.45 0 0 1 1.28.53l.21-.21a.75.75 0 0 1 1.06 0l1.06 1.06a.75.75 0 0 1 0 1.06l-.21.21c.22.4.4.83.53 1.28h.3a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-.75.75h-.3a5.45 5.45 0 0 1-.53 1.28l.21.21a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 0 1-1.06 0l-.21-.21c-.4.22-.83.4-1.28.53v.3a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75v-.3a5.45 5.45 0 0 1-1.28-.53l-.21.21a.75.75 0 0 1-1.06 0L2.89 11.9a.75.75 0 0 1 0-1.06l.21-.21A5.45 5.45 0 0 1 2.57 9.4h-.3a.75.75 0 0 1-.75-.75v-1.5a.75.75 0 0 1 .75-.75h.3c.13-.45.31-.88.53-1.28l-.21-.21a.75.75 0 0 1 0-1.06L3.95 2.8a.75.75 0 0 1 1.06 0l.21.21c.4-.22.83-.4 1.28-.53v-.3zM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" fill="currentColor"/>
                </svg>
              </button>
            )}
            {sidebarOpen && (
              <div className="terminal-pane__sidebar">
                <div className="terminal-pane__sidebar-header">
                  <span className="terminal-pane__sidebar-title">Settings</span>
                  <button
                    type="button"
                    className="terminal-pane__sidebar-close"
                    onClick={() => setSidebarOpen(false)}
                    title="Close settings"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                  </button>
                </div>
                <SessionControls
                  sessionId={sessionId}
                  backendType={backendType}
                  model={model}
                  modelOptions={MODEL_OPTIONS[providerFamily] ?? []}
                  allowedTools={allowedTools}
                  availableTools={availableTools}
                  onModelSaved={setModel}
                />
                {/* Bug: 11f4f47 — Live preset pills in sidebar for SDK sessions */}
                {backendType === 'sdk' && (
                  <LivePresetPills
                    sessionId={sessionId}
                    onUnionUpdate={({ totalTokens }) => setPresetTokenCount(totalTokens)}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <PermissionDialog
        request={backendType === 'sdk' && !permissionBusy ? permissionQueue[0] ?? null : null}
        onRespond={handlePermissionResponse}
      />
    </div>
  );
}
