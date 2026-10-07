import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MANAGED_CHAT_OPTIONS } from '../../src/managed-chat-defaults';
import { ManagedChatDefaults } from '../../ui/src/components/settings/ManagedChatDefaults';
import { getManagedChatDefaults, updateManagedChatDefaults } from '../../ui/src/api';

vi.mock('../../ui/src/api', () => ({ getManagedChatDefaults: vi.fn(), updateManagedChatDefaults: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('saves independent provider choices and exposes a failed save without losing the draft', async () => {
  vi.mocked(getManagedChatDefaults).mockResolvedValue(structuredClone(DEFAULT_MANAGED_CHAT_OPTIONS));
  vi.mocked(updateManagedChatDefaults).mockRejectedValueOnce(new Error('Save unavailable')).mockImplementationOnce(async value => value);
  render(h(ManagedChatDefaults, { canSave: true }));
  const effort = await screen.findByLabelText('Codex Thinking effort');
  fireEvent.change(effort, { target: { value: 'high' } });
  const save = screen.getByRole('button', { name: 'Save chat defaults' });
  fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Error: Save unavailable');
  expect((effort as HTMLSelectElement).value).toBe('high');
  fireEvent.click(save);
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
  expect(updateManagedChatDefaults).toHaveBeenLastCalledWith({
    claude_code: DEFAULT_MANAGED_CHAT_OPTIONS.claude_code,
    codex: { ...DEFAULT_MANAGED_CHAT_OPTIONS.codex, effort: 'high' },
  });
});
