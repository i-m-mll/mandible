// Issue 037fa85 / f59b5bd — page-level agent session binding: the
// agent_session hash-fragment param is consumed and stripped at boot, held in
// tab-local memory only, and never re-emitted into the URL. Review R1 — the
// same consumption function also serves the Tauri deep-link handoff after
// boot, with replace semantics and subscriber notification.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAgentPageBindingForTests,
  adoptAgentSessionBinding,
  consumeAgentSessionFragment,
  consumeAgentSessionFromHash,
  getAgentPageBinding,
  subscribeAgentPageBinding,
} from '../ui/src/agent-page-binding';

describe('agent page binding', () => {
  beforeEach(() => {
    __resetAgentPageBindingForTests();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    __resetAgentPageBindingForTests();
    window.history.replaceState(null, '', '/');
  });

  it('consumes agent_session from the hash-fragment query and strips it', () => {
    window.history.replaceState(
      null,
      '',
      '/#/overview?agent_session=0198c0de-1111-2222-3333-444455556666&sidebar=hidden',
    );

    consumeAgentSessionFragment();

    expect(getAgentPageBinding()).toBe('0198c0de-1111-2222-3333-444455556666');
    expect(window.location.hash).toBe('#/overview?sidebar=hidden');
  });

  it('accepts a short-prefix binding value verbatim', () => {
    window.history.replaceState(null, '', '/#/overview?agent_session=0198c0de');

    consumeAgentSessionFragment();

    expect(getAgentPageBinding()).toBe('0198c0de');
    expect(window.location.hash).toBe('#/overview');
  });

  // Review R1 — replace semantics: a newer deep link's binding replaces the
  // current one. The binding is display-only, so replacement is safe.
  it('adopts a later consumed binding over the boot binding', () => {
    window.history.replaceState(null, '', '/#/overview?agent_session=first-session');
    consumeAgentSessionFragment();
    expect(getAgentPageBinding()).toBe('first-session');

    window.history.replaceState(null, '', '/#/overview?agent_session=second-session');
    consumeAgentSessionFragment();

    expect(getAgentPageBinding()).toBe('second-session');
    expect(window.location.hash).toBe('#/overview');
  });

  it('does not bind from the retired codex_session param', () => {
    window.history.replaceState(null, '', '/#/overview?codex_session=some-session');

    consumeAgentSessionFragment();

    expect(getAgentPageBinding()).toBeNull();
    // The unrecognized param is left alone — it is not ours to strip.
    expect(window.location.hash).toBe('#/overview?codex_session=some-session');
  });

  it('reports no binding when the fragment has no query', () => {
    window.history.replaceState(null, '', '/#/overview');

    consumeAgentSessionFragment();

    expect(getAgentPageBinding()).toBeNull();
  });
});

// Review R1 — the pure consumption function shared by boot and the Tauri
// deep-link handoff, plus adoption/subscription semantics.
describe('consumeAgentSessionFromHash / adoption', () => {
  beforeEach(() => {
    __resetAgentPageBindingForTests();
  });

  afterEach(() => {
    __resetAgentPageBindingForTests();
  });

  it('extracts and strips agent_session from a hash string', () => {
    expect(
      consumeAgentSessionFromHash('#/auth?request=abc&agent_session=0198c0de'),
    ).toEqual({ value: '0198c0de', hash: '#/auth?request=abc' });
    expect(consumeAgentSessionFromHash('#/auth?agent_session=0198c0de')).toEqual({
      value: '0198c0de',
      hash: '#/auth',
    });
    expect(consumeAgentSessionFromHash('#/auth?request=abc')).toEqual({
      value: null,
      hash: '#/auth?request=abc',
    });
    expect(consumeAgentSessionFromHash('#/auth')).toEqual({
      value: null,
      hash: '#/auth',
    });
  });

  it('adoption replaces the binding and notifies subscribers', () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeAgentPageBinding((value) => seen.push(value));

    adoptAgentSessionBinding('first-session');
    adoptAgentSessionBinding('second-session');

    expect(getAgentPageBinding()).toBe('second-session');
    expect(seen).toEqual(['first-session', 'second-session']);
    unsubscribe();
  });

  it('adoption of null or empty never clears an existing binding', () => {
    const listener = vi.fn();
    subscribeAgentPageBinding(listener);
    adoptAgentSessionBinding('kept-session');

    adoptAgentSessionBinding(null);
    adoptAgentSessionBinding('');
    adoptAgentSessionBinding('   ');

    expect(getAgentPageBinding()).toBe('kept-session');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribed listeners stop receiving adoptions', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentPageBinding(listener);
    unsubscribe();

    adoptAgentSessionBinding('after-unsubscribe');

    expect(listener).not.toHaveBeenCalled();
  });
});
