// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readReadingState, writeReadingState, type ReadingState } from '../ui/src/chat/readingState';

const state: ReadingState = {version:4,positionSpaceId:'space',following:false,
  anchor:{kind:'row',rowKey:'row',memberKey:'member',position:12,offset:7},disclosures:{message:true}};
afterEach(() => { sessionStorage.clear(); localStorage.clear(); vi.unstubAllGlobals(); });

it('retains choices within a tab session and ignores durable choices in a new session', () => {
  localStorage.setItem('mandible:chat-reading:chat',JSON.stringify(state));
  expect(readReadingState('chat')).toBeNull();
  writeReadingState('chat',state);
  expect(readReadingState('chat')).toEqual(state);
  sessionStorage.clear();
  expect(readReadingState('chat')).toBeNull();
});

it('retains native reload choices and retires them on native process replacement only', () => {
  const host = (sessionId:string) => vi.stubGlobal('__MANDIBLE_NATIVE_HOST__',{kind:'tauri',platform:'macos',framePresentation:'macos-overlay',sessionId});
  host('process-a');
  sessionStorage.setItem('unrelated','preserved');
  writeReadingState('chat',state);
  host('process-a');
  expect(readReadingState('chat')).toEqual(state);
  host('process-b');
  expect(readReadingState('chat')).toBeNull();
  expect(sessionStorage.getItem('unrelated')).toBe('preserved');
});
