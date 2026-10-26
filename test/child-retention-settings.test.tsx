// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from './helpers/dom';
import { render } from './helpers/notice-test-render';
import { establishTestClientAccess } from './helpers/local-client-access';
import { ChildRetentionSettings } from '../ui/src/components/settings/ChildRetentionSettings';
import { DEFAULT_CHILD_RETENTION_SETTINGS } from '../src/conversations/retention-contract';

beforeEach(establishTestClientAccess);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('retains an unsaved policy across refresh and a failed save, then reloads the persisted policy', async () => {
  let persisted = structuredClone(DEFAULT_CHILD_RETENTION_SETTINGS);
  let rejectSave = true;
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/settings/child-retention');
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      if (rejectSave) return Promise.resolve(new Response(JSON.stringify({ error: 'Save unavailable' }), { status: 503 }));
      persisted = JSON.parse(String(init.body));
    }
    return Promise.resolve(new Response(JSON.stringify(persisted), { headers: { 'content-type': 'application/json' } }));
  }));
  const view = render(<ChildRetentionSettings canSave />);
  const hours = await screen.findByRole('spinbutton', { name: 'Planner idle hours' }) as HTMLInputElement;
  fireEvent.input(hours, { target: { value: '24' } });
  view.rerender(<ChildRetentionSettings canSave />);
  expect(hours.value).toBe('24');
  fireEvent.click(screen.getByRole('button', { name: 'Save child cleanup' }));
  await screen.findByRole('alert');
  expect(hours.value).toBe('24');
  expect(persisted.planner.idleHours).toBe(48);
  rejectSave = false;
  fireEvent.click(screen.getByRole('button', { name: 'Save child cleanup' }));
  await waitFor(() => expect(persisted.planner.idleHours).toBe(24));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save child cleanup' }) as HTMLButtonElement).disabled).toBe(true));
  expect(writes).toEqual([persisted, persisted]);
  view.unmount();
  render(<ChildRetentionSettings canSave />);
  expect((await screen.findByRole('spinbutton', { name: 'Planner idle hours' }) as HTMLInputElement).value).toBe('24');
  fireEvent.click(screen.getByRole('switch', { name: 'Clean up child chats' }));
  expect((screen.getByRole('spinbutton', { name: 'Planner idle hours' }) as HTMLInputElement).disabled).toBe(true);
});
