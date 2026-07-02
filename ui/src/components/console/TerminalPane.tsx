// Bug: b949700 — Console tab: xterm.js terminal pane with WebSocket PTY and SSE stream events
// Bug: 1d286c1 — console tab overhaul: reconnect, overlay, SSE events, xterm rendering
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConsoleSession } from '../../state';
import type { StreamEvent } from '../stream-renderer/types';
import { ChannelEventsPane } from './ChannelEventsPane';
import { PermissionDialog } from './PermissionDialog';
import { RichChatPane } from './RichChatPane';
import { useConsoleStream } from './useConsoleStream';
import { useTerminalView } from './useTerminalView';
import { usePermissionQueue } from './usePermissionQueue';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { TerminalDebugOverlay } from './TerminalDebugOverlay';
import {
  getPresetUnion,
  sendConsolePrompt,
} from '../../api';
import type { PresetUnion } from '../../api';

export type ViewMode = 'terminal' | 'rich' | 'events';
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
  // Bug: b5e1c51 — Channel-enabled PTY sessions get Terminal + Events tabs
  channelEnabled?: boolean;
  workspaceMode?: boolean;
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
  channelEnabled = false,
  workspaceMode = false,
}: TerminalPaneProps): JSX.Element {
  const {
    streamEvents,
    setStreaming,
    streaming,
    hydratingHistory,
    elapsedSeconds,
    beginLocalPrompt,
  } = useConsoleStream({
    sessionId,
    providerSessionId,
    resumeAtMessage,
    sessionStatus,
  });
  const {
    containerRef,
    wsStatus,
    showDebugTerminal,
    handleReconnect,
    handleStartDebugTerminal,
    sendTerminalPrompt,
  } = useTerminalView({
    sessionId,
    backendType,
    interactionMode,
    isVisible,
    viewMode,
  });
  const [model, setModel] = useState<string | undefined>(() => parseModelFromArgs(sessionArgs));
  const {
    request: permissionRequest,
    handlePermissionResponse,
  } = usePermissionQueue({ backendType, sessionId });
  const [activeSubagents, setActiveSubagents] = useState<ActiveSubagent[]>([]);
  // Bug: 6634023 — Sidebar state for SessionControls (collapsed by default)
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Bug: 60b1fd7 — Sidebar tab state: settings vs info panel
  const [sidebarTab, setSidebarTab] = useState<'settings' | 'info'>('settings');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  // Bug: 11f4f47 — Track preset union token count for ContextIndicator
  const [presetTokenCount, setPresetTokenCount] = useState(0);
  // Bug: b5e1c51 — Unseen channel event badge tracking
  const [channelEventCount, setChannelEventCount] = useState(0);
  const [unseenEventCount, setUnseenEventCount] = useState(0);
  const lastSeenEventCountRef = useRef(0);

  // Reset unseen count when Events tab is activated
  useEffect(() => {
    if (viewMode === 'events') {
      setUnseenEventCount(0);
      lastSeenEventCountRef.current = channelEventCount;
    }
  }, [viewMode, channelEventCount]);

  const providerFamily = isOperator ? 'claude' : command;
  const availableTools = collectAvailableTools(streamEvents);

  useEffect(() => { setModel(parseModelFromArgs(sessionArgs)); }, [sessionArgs]);

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

  // Bug: 60b1fd7 — Selection handler for sidebar info panel
  const handleSelectMessageInfo = (turnId: string) => {
    if (selectedMessageId === turnId && sidebarTab === 'info') {
      setSelectedMessageId(null);
      return;
    }
    setSelectedMessageId(turnId);
    setSidebarOpen(true);
    setSidebarTab('info');
  };

  const [prompt, setPrompt] = useState('');

  const handlePromptSubmit = (e: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    if (viewMode === 'rich') {
      const submittedPrompt = prompt.trim();
      setPrompt('');
      beginLocalPrompt(submittedPrompt);
      void sendConsolePrompt(sessionId, submittedPrompt).catch(() => {
        setStreaming(false);
      });
      return;
    }

    if (sendTerminalPrompt(prompt)) {
      setPrompt('');
    }
  };

  const showReconnectOverlay = showDebugTerminal && (wsStatus === 'closed' || wsStatus === 'error');
  const showDebugStart = showDebugTerminal && viewMode === 'terminal' && sessionStatus !== 'running';
  const debugTerminalLabel = providerSessionId ? 'Resume debug terminal' : 'Start debug terminal';
  const debugTerminalDescription = providerSessionId
    ? 'Resume this same chat in the provider terminal for raw inspection or recovery.'
    : 'Open the provider terminal for this chat. Once a provider session exists, it will resume here.';

  return (
    <div
      className="terminal-pane"
      style={{ display: isVisible ? 'flex' : 'none' }}
    >
      <TerminalPaneHeader
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        showDebugTerminal={showDebugTerminal}
        channelEnabled={channelEnabled}
        unseenEventCount={unseenEventCount}
        workspaceMode={workspaceMode}
        providerSessionId={providerSessionId}
        onSidebarToggle={() => setSidebarOpen((prev) => !prev)}
      />

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

        {/* Bug: b5e1c51 — Channel events pane for PTY+Channel sessions */}
        {channelEnabled && viewMode === 'events' && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
            <ChannelEventsPane
              streamEvents={streamEvents}
              onEventCountChange={(count) => {
                setChannelEventCount(count);
                if (viewMode !== 'events') {
                  const newEvents = count - lastSeenEventCountRef.current;
                  setUnseenEventCount(Math.max(0, newEvents));
                }
              }}
            />
          </div>
        )}

        <TerminalDebugOverlay
          visible={showReconnectOverlay && viewMode === 'terminal' && !showDebugStart}
          message={wsStatus === 'error' ? 'Debug terminal connection error' : 'Debug terminal disconnected'}
          buttonLabel="Reconnect terminal"
          onClick={() => { void handleReconnect(); }}
        />

        <TerminalDebugOverlay
          visible={showDebugStart}
          message={debugTerminalDescription}
          buttonLabel={debugTerminalLabel}
          onClick={() => { void handleStartDebugTerminal(); }}
        />

        {/* Rich view: shared ChatSurface + sidebar for SessionControls */}
        {viewMode === 'rich' && (
          <RichChatPane
            backendType={backendType}
            activeSubagents={activeSubagents}
            streamEvents={streamEvents}
            streaming={streaming}
            elapsedSeconds={elapsedSeconds}
            hydratingHistory={hydratingHistory}
            sessionId={sessionId}
            providerFamily={providerFamily}
            model={model}
            modelOptions={MODEL_OPTIONS[providerFamily] ?? []}
            allowedTools={allowedTools}
            availableTools={availableTools}
            selectedMessageId={selectedMessageId}
            onSelectMessageInfo={handleSelectMessageInfo}
            presetTokenCount={presetTokenCount}
            onModelSaved={setModel}
            onPresetTokenCount={setPresetTokenCount}
            prompt={prompt}
            interactionMode={interactionMode}
            onPromptChange={setPrompt}
            onPromptSubmit={handlePromptSubmit}
            sidebarOpen={sidebarOpen}
            workspaceMode={workspaceMode}
            sidebarTab={sidebarTab}
            onSidebarTabChange={setSidebarTab}
            onSidebarOpenChange={setSidebarOpen}
          />
        )}
      </div>
      <PermissionDialog
        request={permissionRequest}
        onRespond={handlePermissionResponse}
      />
    </div>
  );
}
