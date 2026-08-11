// Issue 037fa85 / f59b5bd — page-level agent session binding: the
// agent_session hash-fragment param is consumed and stripped at boot, held in
// tab-local memory only, and never re-emitted into the URL.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetAgentPageBindingForTests,
  consumeAgentSessionFragment,
  getAgentPageBinding,
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

  it('is idempotent: a later hash change never overwrites the boot binding', () => {
    window.history.replaceState(null, '', '/#/overview?agent_session=first-session');
    consumeAgentSessionFragment();

    window.history.replaceState(null, '', '/#/overview?agent_session=second-session');
    consumeAgentSessionFragment();

    expect(getAgentPageBinding()).toBe('first-session');
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
