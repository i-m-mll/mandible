import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { getConsoleSessionUsage, type ConsolePermissionDecision, type ConsolePermissionRequest } from '../../api';
import type { ConsoleSession } from '../../state';
import type { StreamEvent } from '../stream-renderer/types';
import {
  ChatOverlay,
  ChatSurface,
  ContextUsageRing,
  UsageModal,
  deriveChatUsageSummary,
  useStatuslineTelemetry,
} from '../../chat';
import { PtyBanner } from './PtyBanner';
import { SessionControls, SessionModelControl } from './SessionControls';
import { LivePresetPills } from './LivePresetPills';
import { MessageInfoPanel } from './MessageInfoPanel';
import { Composer, type ComposerUsage, type QueuedPrompt } from './Composer';
import { PermissionApprovalCard } from './PermissionApprovalCard';
import { PermissionPolicyStrip } from './PermissionPolicyStrip';

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
  allowedTools,
  availableTools,
  permissionRequest,
  onPermissionRespond,
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
  allowedTools?: string[] | null;
  availableTools: string[];
  permissionRequest: ConsolePermissionRequest | null;
  onPermissionRespond: (id: string, decision: ConsolePermissionDecision) => void | Promise<void>;
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
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const [usageRows, setUsageRows] = useState<Array<Record<string, unknown>>>([]);
  const telemetry = useStatuslineTelemetry({ sessionRef: sessionId });
  const usageSummary = useMemo(() => deriveChatUsageSummary({
    telemetry,
    events: streamEvents,
    usageRows,
  }), [streamEvents, telemetry, usageRows]);

  useEffect(() => {
    let active = true;
    void getConsoleSessionUsage<Record<string, unknown>>(sessionId)
      .then((rows) => {
        if (active) setUsageRows(rows);
      })
      .catch(() => {
        if (active) setUsageRows([]);
      });
    return () => {
      active = false;
    };
  }, [sessionId, streamEvents.length]);

  const openUsage = () => setUsageModalOpen(true);

  return (
    <div className="terminal-pane__rich-wrapper">
      <div className="terminal-pane__rich-main">
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {backendType === 'pty' && <PtyBanner />}
          {(backendType === 'sdk' || backendType === 'acp') && (
            <div className="terminal-pane__policy-row">
              <PermissionPolicyStrip
                allowedTools={allowedTools}
                onOpenSettings={() => {
                  onSidebarOpenChange(true);
                  onSidebarTabChange('settings');
                }}
              />
            </div>
          )}
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
            activePermissionRequest={permissionRequest}
            permissionBackendType={backendType}
            onPermissionRespond={onPermissionRespond}
          />
          <ChatOverlay
            open={usageModalOpen}
            titleId="chat-usage-modal-title"
            onClose={() => setUsageModalOpen(false)}
          >
            <UsageModal
              usage={usageSummary}
              titleId="chat-usage-modal-title"
              onClose={() => setUsageModalOpen(false)}
            />
          </ChatOverlay>
        </div>
        <Composer
          prompt={prompt}
          disabled={interactionMode === 'inbox_only'}
          streaming={streaming}
          queuedPrompts={queuedPrompts}
          transportLabel={transportLabel}
          transportTitle={transportTitle}
          usage={usage}
          contextSlot={<ContextUsageRing usage={usageSummary} onClick={openUsage} />}
          modelSlot={backendType === 'sdk' ? (
            <SessionModelControl
              sessionId={sessionId}
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
        {permissionRequest && (
          <div className="terminal-pane__approval-footer">
            <PermissionApprovalCard
              request={permissionRequest}
              backendType={backendType}
              onRespond={onPermissionRespond}
              variant="sticky"
            />
          </div>
        )}
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
