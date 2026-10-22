import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../ui/src/api.js';
import { useChatProjectSelection } from '../ui/src/views/conversation-view-state.js';

function Probe(): JSX.Element {
  const [value, setValue, state] = useChatProjectSelection();
  return (
    <div>
      <button type="button" onClick={() => setValue([{ projectId: 'prj-next', checkoutId: 'checkout-next' }])}>
        Change
      </button>
      <output data-ready={String(state.ready)} data-notice={state.notice ?? ''}>{JSON.stringify(value)}</output>
    </div>
  );
}

beforeEach(() => {
  const rows = new Map<string, string>();
  const storage = {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key: string) => rows.get(key) ?? null,
    key: (index: number) => [...rows.keys()][index] ?? null,
    removeItem: (key: string) => rows.delete(key),
    setItem: (key: string, value: string) => rows.set(key, String(value)),
  } as Storage;
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Chat project preference migration', () => {

  it('makes concurrent revision conflicts visible and reloads the winning value', async () => {
    const original = [{ projectId: 'prj-original', checkoutId: 'checkout-original' }];
    const winning = [{ projectId: 'prj-winning', checkoutId: 'checkout-winning' }];
    const read = vi.spyOn(api, 'getChatShownProjectsPreference')
      .mockResolvedValueOnce({ version: 1, key: 'chat_shown_projects', value: original, revision: 2 })
      .mockResolvedValueOnce({ version: 1, key: 'chat_shown_projects', value: winning, revision: 3 });
    vi.spyOn(api, 'updateChatShownProjectsPreference')
      .mockRejectedValue(new api.ApiError('revision conflict', 409));

    render(<Probe />);
    await waitFor(() => expect(JSON.parse(screen.getByRole('status').textContent ?? '[]')).toEqual(original));
    screen.getByRole('button', { name: 'Change' }).click();

    await waitFor(() => expect(JSON.parse(screen.getByRole('status').textContent ?? '[]')).toEqual(winning));
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').getAttribute('data-notice')).toContain('another Mandible window');
  });

  it('stops timer retries and restores the saved selection on an explicit reconnect signal', async () => {
    vi.useFakeTimers();
    const saved = [{ projectId: 'prj-shared', checkoutId: 'checkout-shared' }];
    vi.spyOn(api, 'getChatShownProjectsPreference')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ version: 1, key: 'chat_shown_projects', value: saved, revision: 4 });

    render(<Probe />);

    await vi.waitFor(() => {
      expect(screen.getByRole('status').getAttribute('data-notice')).toMatch(/unavailable|Reconnect/);
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.getChatShownProjectsPreference).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(screen.getByRole('status').getAttribute('data-ready')).toBe('true'));
    expect(JSON.parse(screen.getByRole('status').textContent ?? '[]')).toEqual(saved);
    vi.useRealTimers();
  });
});
