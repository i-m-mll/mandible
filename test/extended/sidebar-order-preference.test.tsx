import { act, cleanup, renderHook, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../ui/src/api';
import { useSidebarOrderPreference } from '../../ui/src/hooks/useSidebarOrderPreference';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('sidebar order preference hook', () => {
  it('loads one shared value and serializes optimistic writes without losing either field', async () => {
    vi.spyOn(api, 'getSidebarOrderPreference').mockResolvedValue({
      version: 1,
      key: 'sidebar_order',
      value: { pinnedConversationIds: ['old'], briefingTopLevelIds: null },
      revision: 4,
    });
    const update = vi.spyOn(api, 'updateSidebarOrderPreference')
      .mockImplementation(async (value, revision) => ({
        version: 1, key: 'sidebar_order', value, revision: revision + 1,
      }));
    const { result } = renderHook(() => useSidebarOrderPreference());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.patch({ pinnedConversationIds: ['new'] }));
    act(() => result.current.patch({ briefingTopLevelIds: ['group:one'] }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));

    expect(update.mock.calls[0]).toEqual([
      { pinnedConversationIds: ['new'], briefingTopLevelIds: ['group:one'] },
      4,
    ]);
    expect(update.mock.calls[1]).toEqual([
      { pinnedConversationIds: ['new'], briefingTopLevelIds: ['group:one'] },
      5,
    ]);
    expect(result.current.value).toEqual({
      pinnedConversationIds: ['new'], briefingTopLevelIds: ['group:one'],
    });
    expect(result.current.notice).toBeNull();
  });

  it('rolls back a rejected write to the last durable value and exposes retryable failure', async () => {
    const durable = { pinnedConversationIds: ['durable'], briefingTopLevelIds: null };
    vi.spyOn(api, 'getSidebarOrderPreference').mockResolvedValue({
      version: 1, key: 'sidebar_order', value: durable, revision: 2,
    });
    vi.spyOn(api, 'updateSidebarOrderPreference').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSidebarOrderPreference());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.patch({ pinnedConversationIds: ['optimistic'] }));
    expect(result.current.value.pinnedConversationIds).toEqual(['optimistic']);
    await waitFor(() => expect(result.current.notice).toContain('not saved'));
    expect(result.current.value).toEqual(durable);
  });

  it('does not let a focus refresh overwrite a newer in-flight write with an older snapshot', async () => {
    let resolveWrite!: (value: api.SidebarOrderPreference) => void;
    let resolveRefresh!: (value: api.SidebarOrderPreference) => void;
    const write = new Promise<api.SidebarOrderPreference>((resolve) => { resolveWrite = resolve; });
    const refresh = new Promise<api.SidebarOrderPreference>((resolve) => { resolveRefresh = resolve; });
    vi.spyOn(api, 'getSidebarOrderPreference')
      .mockResolvedValueOnce({
        version: 1,
        key: 'sidebar_order',
        value: { pinnedConversationIds: ['old'], briefingTopLevelIds: null },
        revision: 4,
      })
      .mockReturnValueOnce(refresh);
    const update = vi.spyOn(api, 'updateSidebarOrderPreference')
      .mockReturnValueOnce(write)
      .mockImplementation(async (value, revision) => ({
        version: 1, key: 'sidebar_order', value, revision: revision + 1,
      }));
    const { result } = renderHook(() => useSidebarOrderPreference());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.patch({ pinnedConversationIds: ['new'] }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.getSidebarOrderPreference).toHaveBeenCalledTimes(2));
    await act(async () => resolveWrite({
      version: 1,
      key: 'sidebar_order',
      value: { pinnedConversationIds: ['new'], briefingTopLevelIds: null },
      revision: 5,
    }));
    await act(async () => resolveRefresh({
      version: 1,
      key: 'sidebar_order',
      value: { pinnedConversationIds: ['old'], briefingTopLevelIds: null },
      revision: 4,
    }));

    expect(result.current.value.pinnedConversationIds).toEqual(['new']);
    act(() => result.current.patch({ briefingTopLevelIds: ['group:one'] }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]?.[1]).toBe(5);
  });
});
