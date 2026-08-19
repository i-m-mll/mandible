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
  cancelConsolePrompt,
  getPresetUnion,
  sendConsolePrompt,
} from '../../api';
import type { ConsolePermissionDecision, PresetUnion } from '../../api';
import type { ComposerUsage, QueuedPrompt } from './Composer';

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
  transportLane: ConsoleSession['transport_lane'];
  transportBadge?: ConsoleSession['transport_badge'];
  attention?: ConsoleSession['attention'];
  providerSessionId: string | null;
  isVisible: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  // Bug: b5e1c51 — Channel-enabled PTY sessions get Terminal + Events tabs
  channelEnabled?: boolean;
  workspaceMode?: boolean;
};

const DRAFT_STORAGE_PREFIX = 'mandible:console:composer-draft:v1:';

function draftStorageKey(sessionId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${sessionId}`;
}

function readComposerDraft(sessionId: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(draftStorageKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

function writeComposerDraft(sessionId: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    const key = draftStorageKey(sessionId);
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Browser-local draft persistence is best-effort only.
  }
}

function readUsageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectComposerUsage(events: StreamEvent[], contextTokens: number): ComposerUsage | undefined {
  let usage: Record<string, unknown> | undefined;
  let costUsd: number | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as StreamEvent & {
      usage?: Record<string, unknown>;
      total_cost_usd?: unknown;
      message?: { usage?: Record<string, unknown> };
    };
    usage = event.usage ?? event.message?.usage;
    costUsd = readUsageNumber(event.total_cost_usd);
    if (usage) break;
  }
  const inputTokens = readUsageNumber(usage?.input_tokens);
  const outputTokens = readUsageNumber(usage?.output_tokens);
  const cacheTokens = (readUsageNumber(usage?.cache_creation_input_tokens) ?? 0)
    + (readUsageNumber(usage?.cache_read_input_tokens) ?? 0);
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + cacheTokens;
  if (totalTokens === 0 && contextTokens === 0 && costUsd === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheTokens: cacheTokens > 0 ? cacheTokens : undefined,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    contextTokens: contextTokens > 0 ? contextTokens : undefined,
    costUsd,
  };
}

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
  transportLane,
  transportBadge,
  attention,
  providerSessionId,
  isVisible,
  viewMode,
  onViewModeChange,
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
  const [optimisticAllowedTools, setOptimisticAllowedTools] = useState<string[]>(allowedTools ?? []);
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
  const [prompt, setPrompt] = useState(() => readComposerDraft(sessionId));
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [stopBusy, setStopBusy] = useState(false);
  const lastSeenEventCountRef = useRef(0);
  const flushingQueueRef = useRef(false);

  // Reset unseen count when Events tab is activated
  useEffect(() => {
    if (viewMode === 'events') {
      setUnseenEventCount(0);
      lastSeenEventCountRef.current = channelEventCount;
    }
  }, [viewMode, channelEventCount]);

  const providerFamily = isOperator ? 'claude' : command;
  const availableTools = collectAvailableTools(streamEvents);
  const composerUsage = collectComposerUsage(streamEvents, backendType === 'sdk' ? presetTokenCount : 0);
  const transportLabel = transportBadge?.label ?? transportLane ?? backendType;
  const transportTitle = transportBadge?.title;

  useEffect(() => { setModel(parseModelFromArgs(sessionArgs)); }, [sessionArgs]);
  useEffect(() => { setOptimisticAllowedTools(allowedTools ?? []); }, [allowedTools]);

  const handleRichPermissionResponse = async (
    requestId: string,
    decision: ConsolePermissionDecision,
  ) => {
    await handlePermissionResponse(requestId, decision);
    if (decision === 'allow_always' && permissionRequest?.tool_name) {
      setOptimisticAllowedTools((current) => (
        current.includes(permissionRequest.tool_name)
          ? current
          : [...current, permissionRequest.tool_name].sort()
      ));
    }
  };

  useEffect(() => {
    setPrompt(readComposerDraft(sessionId));
    setQueuedPrompts([]);
  }, [sessionId]);

  useEffect(() => {
    writeComposerDraft(sessionId, prompt);
  }, [sessionId, prompt]);

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

  const submitRichPrompt = (submittedPrompt: string) => {
    beginLocalPrompt(submittedPrompt);
    void sendConsolePrompt(sessionId, submittedPrompt).catch(() => {
      setStreaming(false);
    });
  };

  useEffect(() => {
    if (streaming || viewMode !== 'rich' || queuedPrompts.length === 0 || flushingQueueRef.current) {
      return;
    }
    flushingQueueRef.current = true;
    const [nextPrompt, ...remainingPrompts] = queuedPrompts;
    setQueuedPrompts(remainingPrompts);
    submitRichPrompt(nextPrompt.text);
    window.setTimeout(() => {
      flushingQueueRef.current = false;
    }, 0);
  }, [queuedPrompts, streaming, viewMode]);

  const handlePromptSubmit = (e: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    if (viewMode === 'rich') {
      const submittedPrompt = prompt.trim();
      setPrompt('');
      if (streaming) {
        setQueuedPrompts((current) => [
          ...current,
          {
            id: `qp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            text: submittedPrompt,
          },
        ]);
        return;
      }
      submitRichPrompt(submittedPrompt);
      return;
    }

    if (sendTerminalPrompt(prompt)) {
      setPrompt('');
    }
  };

  const handleStop = () => {
    if (stopBusy) return;
    setStopBusy(true);
    void cancelConsolePrompt(sessionId)
      .then(() => {
        setStreaming(false);
      })
      .catch(() => {
        setStreaming(false);
      })
      .finally(() => {
        setStopBusy(false);
      });
  };

  const attentionSlot = permissionRequest ? (
    <div className="composer-attention composer-attention--permission">
      <span className="composer-attention__label">Permission</span>
      <span className="composer-attention__title">
        {permissionRequest.display_name || permissionRequest.title || permissionRequest.tool_name}
      </span>
    </div>
  ) : attention?.active ? (
    <div className="composer-attention composer-attention--state">
      <span className="composer-attention__label">Needs attention</span>
      <span className="composer-attention__title">{attention.detail.reason || attention.kind}</span>
    </div>
  ) : null;

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
            allowedTools={optimisticAllowedTools}
            availableTools={availableTools}
            permissionRequest={permissionRequest}
            onPermissionRespond={handleRichPermissionResponse}
            selectedMessageId={selectedMessageId}
            onSelectMessageInfo={handleSelectMessageInfo}
            presetTokenCount={presetTokenCount}
            usage={composerUsage}
            queuedPrompts={queuedPrompts}
            transportLabel={transportLabel}
            transportTitle={transportTitle}
            canStop={backendType === 'sdk' || backendType === 'acp'}
            stopBusy={stopBusy}
            attentionSlot={attentionSlot}
            onModelSaved={setModel}
            onPresetTokenCount={setPresetTokenCount}
            prompt={prompt}
            interactionMode={interactionMode}
            onPromptChange={setPrompt}
            onPromptSubmit={handlePromptSubmit}
            onQueuedPromptRemove={(id) => {
              setQueuedPrompts((current) => current.filter((item) => item.id !== id));
            }}
            onStop={handleStop}
            sidebarOpen={sidebarOpen}
            workspaceMode={workspaceMode}
            sidebarTab={sidebarTab}
            onSidebarTabChange={setSidebarTab}
            onSidebarOpenChange={setSidebarOpen}
          />
        )}
      </div>
      {viewMode !== 'rich' && (
        <PermissionDialog
          request={permissionRequest}
          onRespond={handlePermissionResponse}
        />
      )}
    </div>
  );
}
