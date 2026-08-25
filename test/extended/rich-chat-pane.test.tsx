import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getConsoleSessionOptions: vi.fn(() => Promise.resolve({
    runOptions: { backendType: 'sdk', command: 'claude', phase: 'ready', revision: 1, options: [] },
  })),
  getConsoleSessionUsage: vi.fn(() => Promise.resolve([])),
  getStatuslineTelemetry: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../ui/src/api', () => api);

import { RichChatPane } from '../../ui/src/components/console/RichChatPane';
import type { StreamEvent } from '../../ui/src/components/stream-renderer/types';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RichChatPane context usage', () => {
  it('renders one composer context meter', async () => {
    const streamEvents: StreamEvent[] = [{
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      parent_tool_use_id: null,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [{ type: 'text', text: 'Ready.' }],
        usage: { input_tokens: 50_000, output_tokens: 100 },
      },
    }];

    const { container } = render(
      <RichChatPane
        backendType="sdk"
        activeSubagents={[]}
        streamEvents={streamEvents}
        streaming={false}
        hydratingHistory={false}
        sessionId="session-1"
        providerFamily="claude"
        model="claude-sonnet-4"
        allowedTools={[]}
        availableTools={[]}
        permissionRequest={null}
        onPermissionRespond={vi.fn()}
        selectedMessageId={null}
        onSelectMessageInfo={vi.fn()}
        queuedPrompts={[]}
        transportLabel="SDK"
        canStop={false}
        onModelSaved={vi.fn()}
        prompt=""
        interactionMode="direct"
        onPromptChange={vi.fn()}
        onPromptSubmit={vi.fn()}
        onQueuedPromptRemove={vi.fn()}
        onStop={vi.fn()}
        sidebarOpen={false}
        workspaceMode={false}
        sidebarTab="settings"
        onSidebarTabChange={vi.fn()}
        onSidebarOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(container.querySelectorAll('.context-ring')).toHaveLength(1));
    expect(container.querySelectorAll('.context-indicator')).toHaveLength(0);
  });
});
