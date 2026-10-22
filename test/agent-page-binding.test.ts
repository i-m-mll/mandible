// Issue 037fa85 / f59b5bd — page-level agent session binding: the
// agent_session hash-fragment param is adopted at boot, held in tab-local
// memory only, and preserved in route URLs with replace semantics.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetAgentPageBindingForTests, adoptAgentSessionBinding, adoptAgentSessionFragment, getAgentPageBinding, subscribeAgentPageBinding } from '../ui/src/agent-page-binding';

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
});

describe('agentSessionFromHash / adoption', () => {
  beforeEach(() => {
    __resetAgentPageBindingForTests();
  });

  afterEach(() => {
    __resetAgentPageBindingForTests();
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
});
