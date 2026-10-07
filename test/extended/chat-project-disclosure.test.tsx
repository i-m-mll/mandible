import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useChatProjectDisclosure } from '../../ui/src/views/chat-project-disclosure';

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

it('starts folders folded, preserves independent choices on remount, and resets in a new session', () => {
  let view = renderHook(useChatProjectDisclosure);
  expect(view.result.current[0].has('project-a')).toBe(false);
  expect(view.result.current[0].has('project-b')).toBe(false);
  act(() => view.result.current[1]('project-a'));
  view.rerender(); // Chat selection or data reconciliation does not reset disclosure.
  expect(view.result.current[0].has('project-a')).toBe(true);
  expect(view.result.current[0].has('project-b')).toBe(false);
  view.unmount();
  view = renderHook(useChatProjectDisclosure);
  expect(view.result.current[0].has('project-a')).toBe(true);
  act(() => view.result.current[1]('project-a'));
  act(() => view.result.current[1]('project-b'));
  view.unmount();
  view = renderHook(useChatProjectDisclosure);
  expect(view.result.current[0].has('project-a')).toBe(false);
  expect(view.result.current[0].has('project-b')).toBe(true);
  view.unmount();
  window.sessionStorage.clear();
  view = renderHook(useChatProjectDisclosure);
  expect([...view.result.current[0]]).toEqual([]);
});
