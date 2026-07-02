import type { JSX } from 'preact/jsx-runtime';
import type { ConsoleSession } from '../../state';
import type { StreamEvent } from '../stream-renderer/types';
import { ChatSurface } from '../../chat';
import { ContextIndicator } from '../presets/ContextIndicator';
import { PtyBanner } from './PtyBanner';
import { SessionControls, SessionModelControl } from './SessionControls';
import { LivePresetPills } from './LivePresetPills';
import { MessageInfoPanel } from './MessageInfoPanel';
import { Composer, type ComposerUsage, type QueuedPrompt } from './Composer';

type ActiveSubagent = {
  agent_id: string;
  agent_type: string;
  parent_agent_id: string | null;
  depth: number;
};

export function RichChatPane({
  backendType,
  activeSubagents,
  streamEvents,
  streaming,
  elapsedSeconds,
  hydratingHistory,
  sessionId,
  providerFamily,
  model,
  modelOptions,
  allowedTools,
  availableTools,
  selectedMessageId,
  onSelectMessageInfo,
  presetTokenCount,
  usage,
  queuedPrompts,
  transportLabel,
  transportTitle,
  canStop,
  stopBusy,
  attentionSlot,
  onModelSaved,
  onPresetTokenCount,
  prompt,
  interactionMode,
  onPromptChange,
  onPromptSubmit,
  onQueuedPromptRemove,
  onStop,
  sidebarOpen,
  workspaceMode,
  sidebarTab,
  onSidebarTabChange,
  onSidebarOpenChange,
}: {
  backendType: ConsoleSession['backend_type'];
  activeSubagents: ActiveSubagent[];
  streamEvents: StreamEvent[];
  streaming: boolean;
  elapsedSeconds?: number;
  hydratingHistory: boolean;
  sessionId: string;
  providerFamily: string;
  model?: string;
  modelOptions: string[];
  allowedTools?: string[] | null;
  availableTools: string[];
  selectedMessageId: string | null;
  onSelectMessageInfo: (turnId: string) => void;
  presetTokenCount: number;
  usage?: ComposerUsage;
  queuedPrompts: QueuedPrompt[];
  transportLabel: string;
  transportTitle?: string;
  canStop: boolean;
  stopBusy?: boolean;
  attentionSlot?: JSX.Element | null;
  onModelSaved: (model: string | undefined) => void;
  onPresetTokenCount: (value: number) => void;
  prompt: string;
  interactionMode: ConsoleSession['interaction_mode'];
  onPromptChange: (value: string) => void;
  onPromptSubmit: (event: JSX.TargetedEvent<HTMLFormElement, Event>) => void;
  onQueuedPromptRemove: (id: string) => void;
  onStop: () => void;
  sidebarOpen: boolean;
  workspaceMode: boolean;
  sidebarTab: 'settings' | 'info';
  onSidebarTabChange: (tab: 'settings' | 'info') => void;
  onSidebarOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <div className="terminal-pane__rich-wrapper">
      <div className="terminal-pane__rich-main">
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
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
          <ChatSurface
            events={streamEvents}
            streaming={streaming}
            elapsedSeconds={elapsedSeconds}
            emptyLabel={hydratingHistory ? 'Loading prior messages...' : undefined}
            sessionInfo={{
              sessionId,
              backend: providerFamily,
              model,
            }}
            onSelectMessageInfo={onSelectMessageInfo}
            selectedMessageId={selectedMessageId}
          />
        </div>
        {backendType === 'sdk' && (
          <div style={{ padding: '0 16px', flexShrink: 0 }}>
            <ContextIndicator tokenCount={presetTokenCount} modelName={model} variant="bar" />
          </div>
        )}
        <Composer
          prompt={prompt}
          disabled={interactionMode === 'inbox_only'}
          streaming={streaming}
          queuedPrompts={queuedPrompts}
          transportLabel={transportLabel}
          transportTitle={transportTitle}
          usage={usage}
          modelSlot={backendType === 'sdk' ? (
            <SessionModelControl
              sessionId={sessionId}
              backendType={backendType}
              model={model}
              modelOptions={modelOptions}
              onModelSaved={onModelSaved}
              compact
            />
          ) : null}
          attentionSlot={attentionSlot}
          canStop={canStop}
          stopBusy={stopBusy}
          onPromptChange={onPromptChange}
          onQueuedPromptRemove={onQueuedPromptRemove}
          onSubmit={onPromptSubmit}
          onStop={onStop}
        />
      </div>

      {sidebarOpen && !workspaceMode && (
        <div className="terminal-pane__sidebar">
          <div className="terminal-pane__sidebar-header">
            <div className="terminal-pane__sidebar-tabs">
              <button
                type="button"
                className={`terminal-pane__sidebar-tab${sidebarTab === 'settings' ? ' terminal-pane__sidebar-tab--active' : ''}`}
                onClick={() => onSidebarTabChange('settings')}
              >
                Settings
              </button>
              <button
                type="button"
                className={`terminal-pane__sidebar-tab${sidebarTab === 'info' ? ' terminal-pane__sidebar-tab--active' : ''}`}
                onClick={() => onSidebarTabChange('info')}
              >
                Info
              </button>
            </div>
            <button
              type="button"
              className="terminal-pane__sidebar-close"
              onClick={() => onSidebarOpenChange(false)}
              title="Close sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
          {sidebarTab === 'settings' && (
            <>
              <SessionControls
                sessionId={sessionId}
                backendType={backendType}
                model={model}
                modelOptions={modelOptions}
                allowedTools={allowedTools}
                availableTools={availableTools}
                onModelSaved={onModelSaved}
                hideModel={backendType === 'sdk'}
              />
              {(backendType === 'sdk' || backendType === 'pty') && (
                <LivePresetPills
                  sessionId={sessionId}
                  readOnly={backendType !== 'sdk'}
                  onUnionUpdate={({ totalTokens }) => onPresetTokenCount(totalTokens)}
                />
              )}
            </>
          )}
          {sidebarTab === 'info' && (
            <MessageInfoPanel
              selectedMessageId={selectedMessageId}
              streamEvents={streamEvents}
            />
          )}
        </div>
      )}
    </div>
  );
}
