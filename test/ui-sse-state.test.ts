import { describe, expect, it } from 'vitest';
import { appReducer, authEventRequiresProjectionRefresh, applySSEEvent, initialState, selectBadgeCounts, parseAuthOutputEvent, parseAuthResolvedId, MAX_AUTH_OUTPUT_CHARS } from '../ui/src/state';

describe('SSE handling', () => {
  it('refetches canonical auth projections for every dependency transition event', () => {
    expect([
      'auth:new', 'auth:updated', 'auth:merged', 'auth:resolved', 'auth:finalized', 'auth:lifecycle',
    ].every(authEventRequiresProjectionRefresh)).toBe(true);
    expect(authEventRequiresProjectionRefresh('auth:output')).toBe(false);
  });

  it('updates badge counts from SSE events', () => {
    let state = initialState;
    state = applySSEEvent(state, {
      type: 'auth:new',
      data: { request: { id: 'a1', status: 'pending' } },
    });
    state = applySSEEvent(state, {
      type: 'work:branch:updated',
      data: { repo_id: 'r1', branch: { name: 'main', status: 'dirty' } },
    });

    const badges = selectBadgeCounts(state);
    expect(badges.auth).toBe(1);
    expect(badges.work).toBe(1);
  });

  it('keeps badge counts stable when cached inbox data is partial', () => {
    const state = {
      ...initialState,
      inboxData: {},
    };

    const badges = selectBadgeCounts(state as typeof initialState);
    expect(badges.inbox).toBe(0);
  });

  it('appends streaming output', () => {
    let state = appReducer(initialState, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: 'line1\n',
    });
    state = appReducer(state, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: 'line2\n',
    });
    expect(state.authOutputs.a1).toBe('line1\nline2\n');
  });

  it('strips ANSI escape sequences from appended output', () => {
    let state = appReducer(initialState, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: '\x1b[32mgreen\x1b[0m\n',
    });
    state = appReducer(state, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: '\x1b[1mbold\x1b[0m done\n',
    });
    expect(state.authOutputs.a1).toBe('green\nbold done\n');
  });

  it('bounds retained output to the tail when it exceeds the cap', () => {
    const head = 'H'.repeat(MAX_AUTH_OUTPUT_CHARS);
    let state = appReducer(initialState, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: head,
    });
    state = appReducer(state, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: 'TAIL',
    });
    expect(state.authOutputs.a1.length).toBe(MAX_AUTH_OUTPUT_CHARS);
    expect(state.authOutputs.a1.endsWith('TAIL')).toBe(true);
  });

  it('routes auth:output SSE events through the reducer with ANSI stripped', () => {
    const state = applySSEEvent(initialState, {
      type: 'auth:output',
      data: { request_id: 'a1', text: '\x1b[31mred\x1b[0m line\n' },
    });
    expect(state.authOutputs.a1).toBe('red line\n');
  });

  it('parses auth:output and auth:resolved event shapes', () => {
    expect(
      parseAuthOutputEvent({
        type: 'auth:output',
        data: { request_id: 'a1', text: 'hello' },
      }),
    ).toEqual({ requestId: 'a1', text: 'hello' });
    expect(
      parseAuthResolvedId({
        type: 'auth:resolved',
        data: { request_id: 'a2', status: 'completed' },
      }),
    ).toBe('a2');
    expect(parseAuthResolvedId({ type: 'auth:resolved' })).toBe('');
  });
});
