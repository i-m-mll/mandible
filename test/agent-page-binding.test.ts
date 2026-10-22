// Issue 037fa85 / f59b5bd — page-level agent session binding: the
// agent_session hash-fragment param is adopted at boot, held in tab-local
// memory only, and preserved in route URLs with replace semantics.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAgentPageBindingForTests,
  adoptAgentSessionBinding,
  adoptAgentSessionFragment,
  agentSessionFromHash,
  getAgentPageBinding,
  hashWithAgentSession,
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

  it('adopts agent_session from the hash-fragment query and preserves it', () => {
    window.history.replaceState(
      null,
      '',
      '/#/overview?agent_session=0198c0de-1111-2222-3333-444455556666&sidebar=hidden',
    );

    adoptAgentSessionFragment();

    expect(getAgentPageBinding()).toBe('0198c0de-1111-2222-3333-444455556666');
    expect(window.location.hash).toBe('#/overview?agent_session=0198c0de-1111-2222-3333-444455556666&sidebar=hidden');
  });

  it('accepts a short-prefix binding value verbatim', () => {
    window.history.replaceState(null, '', '/#/overview?agent_session=0198c0de');

    adoptAgentSessionFragment();

    expect(getAgentPageBinding()).toBe('0198c0de');
    expect(window.location.hash).toBe('#/overview?agent_session=0198c0de');
  });

  // Review R1 — replace semantics: a newer deep link's binding replaces the
  // current one. The binding is display-only, so replacement is safe.
  it('adopts a later consumed binding over the boot binding', () => {
    window.history.replaceState(null, '', '/#/overview?agent_session=first-session');
    adoptAgentSessionFragment();
    expect(getAgentPageBinding()).toBe('first-session');

    window.history.replaceState(null, '', '/#/overview?agent_session=second-session');
    adoptAgentSessionFragment();

    expect(getAgentPageBinding()).toBe('second-session');
    expect(window.location.hash).toBe('#/overview?agent_session=second-session');
  });

  it('does not bind from the retired codex_session param', () => {
    window.history.replaceState(null, '', '/#/overview?codex_session=some-session');

    adoptAgentSessionFragment();

    expect(getAgentPageBinding()).toBeNull();
    // The unrecognized param is left alone — it is not ours to strip.
    expect(window.location.hash).toBe('#/overview?codex_session=some-session');
  });

  it('reports no binding when the fragment has no query', () => {
    window.history.replaceState(null, '', '/#/overview');

    adoptAgentSessionFragment();

    expect(getAgentPageBinding()).toBeNull();
  });
});

describe('agentSessionFromHash / adoption', () => {
  beforeEach(() => {
    __resetAgentPageBindingForTests();
  });

  afterEach(() => {
    __resetAgentPageBindingForTests();
  });

  it('extracts and carries agent_session across routes', () => {
    expect(agentSessionFromHash('#/auth?request=abc&agent_session=0198c0de'))
      .toBe('0198c0de');
    expect(agentSessionFromHash('#/auth?request=abc')).toBeNull();
    expect(agentSessionFromHash('#/auth')).toBeNull();
    expect(hashWithAgentSession('#/issues?issue=abc', '0198c0de'))
      .toBe('#/issues?issue=abc&agent_session=0198c0de');
    expect(hashWithAgentSession('#/settings', '0198c0de'))
      .toBe('#/settings?agent_session=0198c0de');
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
