import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION_ORIGIN } from '../src/canonical-origin';
import { installTauriDeepLinkHandler, navigateToMandibleDeepLink, routeHashFromMandibleDeepLink } from '../ui/src/deep-links';
import { __resetAgentPageBindingForTests, getAgentPageBinding } from '../ui/src/agent-page-binding';
import { briefingGroupRoute, hashWithViewSidebarHidden, hashWithViewSidebarVisible, isViewSidebarHidden, parseRouteFromHash, shortRouteId, spacesRouteFromHash } from '../ui/src/routing';
afterEach(() => { __resetAgentPageBindingForTests(); delete (window as Window & { __TAURI__?: unknown }).__TAURI__; });

describe('App routing', () => {
  it('routes legacy monitor hashes into console', () => {
    expect(parseRouteFromHash('#/sessions?session=s1')).toEqual({
      tab: 'console',
      params: { session: 's1' },
    });
  });

  it('routes retired Review hashes into Projects while preserving query params', () => {
    expect(parseRouteFromHash('#/review?repo=repo&base=main&head=feature')).toEqual({
      tab: 'work',
      params: { repo: 'repo', base: 'main', head: 'feature' },
    });
  });

  it('routes retired Presets hashes into instruction artifacts', () => {
    expect(parseRouteFromHash('#/presets')).toEqual({
      tab: 'artifacts',
      params: { role: 'instructions' },
    });
    expect(parseRouteFromHash('#/presets?role=context')).toEqual({
      tab: 'artifacts',
      params: { role: 'context' },
    });
  });

  it('routes removed Switchboard hashes to the default Spaces workspace', () => {
    expect(parseRouteFromHash('#/switchboard')).toEqual({
      tab: 'spaces',
      params: {},
    });
  });

  it('defaults empty and unknown hashes to the Spaces workspace', () => {
    expect(parseRouteFromHash('')).toEqual({ tab: 'spaces', params: {} });
    expect(parseRouteFromHash('#/')).toEqual({ tab: 'spaces', params: {} });
    expect(parseRouteFromHash('#/not-a-real-tab')).toEqual({ tab: 'spaces', params: {} });
  });

  it.each([
    [
      '#/artifacts?artifact=legacy&ref=artifact-blob%3Aabc&series=artifact-series%3Areport&version=2&sidebar=hidden',
      { series: 'artifact-series:report', version: '2', sidebar: 'hidden' },
    ],
    [
      '#/artifacts?artifact=legacy&ref=artifact-version%3Av1&version=3',
      { ref: 'artifact-version:v1' },
    ],
    [
      '#/artifacts?artifact=artifact-blob%3Aabc&version=4',
      { artifact: 'artifact-blob:abc' },
    ],
    [
      '#/artifacts?series=artifact-series%3Areport&version=0',
      { series: 'artifact-series:report' },
    ],
  ])('normalizes direct artifact hash selectors before view wiring: %s', (hash, params) => {
    expect(parseRouteFromHash(hash)).toEqual({ tab: 'artifacts', params });
  });

  it('parses sidebar=hidden as the route-scoped view sidebar hide request', () => {
    const route = parseRouteFromHash('#/issues?repo=dotfiles&issue=e70757d&sidebar=hidden');

    expect(route).toEqual({
      tab: 'issues',
      params: {
        repo: 'dotfiles',
        issue: 'e70757d',
        sidebar: 'hidden',
      },
    });
    expect(isViewSidebarHidden(route)).toBe(true);
    expect(isViewSidebarHidden(parseRouteFromHash('#/issues?sidebar=visible'))).toBe(false);
  });

  it('updates only the sidebar visibility parameter', () => {
    expect(hashWithViewSidebarVisible('#/issues?repo=dotfiles&issue=e70757d&sidebar=hidden')).toBe(
      '#/issues?repo=dotfiles&issue=e70757d',
    );
    expect(hashWithViewSidebarHidden('#/auth?request=abc')).toBe('#/auth?request=abc&sidebar=hidden');
  });

  it('falls back to the Spaces default when toggling the sidebar on an empty hash', () => {
    expect(hashWithViewSidebarHidden('')).toBe('#/spaces?sidebar=hidden');
    expect(hashWithViewSidebarVisible('')).toBe('#/spaces');
  });

  it('maps mandible issue deep links onto the existing Issues hash route', () => {
    expect(routeHashFromMandibleDeepLink('mandible:///issues?issue=dfc924a')).toBe(
      '#/issues?issue=dfc924a',
    );
    expect(
      routeHashFromMandibleDeepLink('mandible:///issues?repo=mandible&issue=dfc924a&comment=2'),
    ).toBe('#/issues?issue=dfc924a&repo=mandible&comment=2');
    expect(routeHashFromMandibleDeepLink('mandible://issues?issue=dfc924a')).toBe(
      '#/issues?issue=dfc924a',
    );
    expect(routeHashFromMandibleDeepLink('https://example.test/issues?issue=dfc924a')).toBeNull();
  });

  it('maps mandible auth and artifact deep links onto existing hash routes', () => {
    expect(routeHashFromMandibleDeepLink('mandible:///auth?request=abc')).toBe(
      '#/auth?request=abc',
    );
    expect(routeHashFromMandibleDeepLink('mandible:///artifacts?ref=bbbbbbbbbbbb')).toBe(
      '#/artifacts?ref=bbbbbbbbbbbb',
    );
    expect(
      routeHashFromMandibleDeepLink('mandible:///artifacts?artifact=artifact%3Asha256%3Aabc'),
    ).toBe('#/artifacts?artifact=artifact%3Asha256%3Aabc');
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?series=artifact-series%3Areport&version=2',
      ),
    ).toBe('#/artifacts?series=artifact-series%3Areport&version=2');
    expect(
      routeHashFromMandibleDeepLink('mandible:///artifacts?ref=artifact-blob%3Aabc'),
    ).toBe('#/artifacts?ref=artifact-blob%3Aabc');
    expect(
      routeHashFromMandibleDeepLink('mandible:///artifacts?artifact=artifact-version%3Av1'),
    ).toBe('#/artifacts?artifact=artifact-version%3Av1');
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?artifact=legacy&ref=artifact-blob%3Aabc&series=artifact-series%3Areport&version=oops',
      ),
    ).toBe('#/artifacts?series=artifact-series%3Areport');
  });

  // Issue f59b5bd — deep links compose: extra params (notably agent_session)
  // carry through into the hash route, but route-owned params always win.
  it('carries extra query params through mandible deep links', () => {
    expect(
      routeHashFromMandibleDeepLink('mandible:///auth?request=abc&agent_session=0198c0de'),
    ).toBe('#/auth?request=abc&agent_session=0198c0de');
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///issues?repo=mandible&issue=dfc924a&agent_session=0198c0de',
      ),
    ).toBe('#/issues?issue=dfc924a&repo=mandible&agent_session=0198c0de');
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?ref=artifact-blob%3Aabc&agent_session=0198c0de',
      ),
    ).toBe('#/artifacts?ref=artifact-blob%3Aabc&agent_session=0198c0de');
    // The artifact normalizer's dropped identity params stay dropped.
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?series=artifact-series%3Areport&version=oops&agent_session=0198c0de',
      ),
    ).toBe('#/artifacts?series=artifact-series%3Areport&agent_session=0198c0de');
  });

  // Issue f59b5bd — deterministically emitted links shorten full UUIDs to the
  // 8-char short form and typed long-hex refs through the shared 7-char ref
  // formatter; ordinary identifiers pass through untouched.
  it('shortens ambiguity-aware UUID and typed-ref routes', () => {
    expect(shortRouteId('e4c52737-40e4-472a-8367-fbdbe97801a2')).toBe('e4c52737');
    expect(shortRouteId(`briefing:${'a'.repeat(64)}`)).toBe('briefing:aaaaaaa');
    expect(shortRouteId(`briefing-round:${'b'.repeat(64)}`)).toBe('briefing-round:bbbbbbb');
    expect(shortRouteId('prj_00mpmto02f_ec55d4e21bfe5ce116fb')).toBe('prj_00mp');
    expect(shortRouteId('e4c52737')).toBe('e4c52737');
    expect(shortRouteId('req-active-1')).toBe('req-active-1');
    expect(shortRouteId('codex-e4c52737-40e4-472a-8367-fbdbe97801a2')).toBe(
      'codex-e4c52737-40e4-472a-8367-fbdbe97801a2',
    );
  });

  it('generates a short canonical Spaces route without dropping unrelated state', () => {
    expect(spacesRouteFromHash(
      '#/spaces?sidebar=hidden&agent_session=01a02175&filter=open',
      {
        projectId: 'prj_00mpmto02f_ec55d4e21bfe5ce116fb',
        projectKey: 'rlrmp',
        spaceId: '7038d21f-b494-47fb-b9b8-d5fb93b3309a',
        renderer: null,
      },
    )).toBe('#/spaces?sidebar=hidden&agent_session=01a02175&filter=open&project=rlrmp&space=7038d21f');
  });

  it('generates a canonical Briefing group route from its active key', () => {
    expect(briefingGroupRoute('policy-health'))
      .toBe('/#/briefing?group=policy-health');
  });

  it('navigates only for supported mandible deep links', () => {
    const navigate = vi.fn();

    expect(navigateToMandibleDeepLink('mandible:///issues?issue=dfc924a', navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('#/issues?issue=dfc924a');

    expect(navigateToMandibleDeepLink('mandible:///issues', navigate)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('adopts and preserves agent_session in Tauri deep-link navigation after boot', () => {
    __resetAgentPageBindingForTests();
    try {
      const navigate = vi.fn();

      expect(
        navigateToMandibleDeepLink(
          'mandible:///auth?request=e4c52737&agent_session=0198c0de',
          navigate,
        ),
      ).toBe(true);
      expect(navigate).toHaveBeenCalledWith('#/auth?request=e4c52737&agent_session=0198c0de');
      expect(getAgentPageBinding()).toBe('0198c0de');

      // A later deep link's binding replaces the current one (display-only).
      expect(
        navigateToMandibleDeepLink(
          'mandible:///issues?issue=dfc924a&agent_session=aaaabbbb',
          navigate,
        ),
      ).toBe(true);
      expect(navigate).toHaveBeenCalledWith('#/issues?issue=dfc924a&agent_session=aaaabbbb');
      expect(getAgentPageBinding()).toBe('aaaabbbb');

      // A deep link without the param never clears the binding.
      expect(navigateToMandibleDeepLink('mandible:///issues?issue=dfc924a', navigate)).toBe(true);
      expect(getAgentPageBinding()).toBe('aaaabbbb');
    } finally {
      __resetAgentPageBindingForTests();
    }
  });

  it('enables Tauri deep-link APIs for the daemon-served loopback dashboard', () => {
    const capability = JSON.parse(
      readFileSync('src-tauri/capabilities/default.json', 'utf8'),
    ) as { remote?: { urls?: string[] }; permissions?: string[] };

    expect(capability.remote?.urls).toEqual([PRODUCTION_ORIGIN]);
    expect(capability.permissions).toContain('deep-link:default');
  });

  it('registers one listener for issue, auth, and artifact links before reading the cold-start URL', async () => {
    const calls: string[] = [];
    const cleanup = vi.fn(() => calls.push('cleanup'));
    const onOpenUrl = vi.fn(async (handler: (urls: string[]) => void) => {
      calls.push('listen');
      handler(['mandible:///issues?repo=mandible&issue=warm']);
      handler(['mandible:///auth?request=warm']);
      handler(['mandible:///artifacts?ref=artifact-version%3Awarm']);
      return cleanup;
    });
    const getCurrent = vi.fn(async () => {
      calls.push('current');
      return ['mandible:///issues?issue=cold'];
    });
    (window as Window & { __TAURI__?: unknown }).__TAURI__ = {};

    const navigate = vi.fn((hash: string) => calls.push(`navigate:${hash}`));
    const removeListener = await installTauriDeepLinkHandler(navigate, { getCurrent, onOpenUrl });

    expect(calls).toEqual([
      'listen',
      'navigate:#/issues?issue=warm&repo=mandible',
      'navigate:#/auth?request=warm',
      'navigate:#/artifacts?ref=artifact-version%3Awarm',
      'current',
      'navigate:#/issues?issue=cold',
    ]);
    expect(onOpenUrl).toHaveBeenCalledOnce();
    expect(getCurrent).toHaveBeenCalledOnce();

    removeListener();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  // Agent-session adoption works on both cold and warm Tauri handoff paths,
  // and each route retains the supplied parameter.
  it('adopts agent_session bindings from both cold and warm Tauri handoff paths', async () => {
    __resetAgentPageBindingForTests();
    try {
      let warmHandler: ((urls: string[]) => void) | undefined;
      const onOpenUrl = vi.fn(async (handler: (urls: string[]) => void) => {
        warmHandler = handler;
        return () => undefined;
      });
      const getCurrent = vi.fn(async () => [
        'mandible:///auth?request=cold-req&agent_session=cold-binding',
      ]);
      (window as Window & { __TAURI__?: unknown }).__TAURI__ = {};

      const navigate = vi.fn();
      await installTauriDeepLinkHandler(navigate, { getCurrent, onOpenUrl });

      expect(navigate).toHaveBeenCalledWith('#/auth?request=cold-req&agent_session=cold-binding');
      expect(getAgentPageBinding()).toBe('cold-binding');

      warmHandler?.(['mandible:///auth?request=warm-req&agent_session=warm-binding']);
      expect(navigate).toHaveBeenCalledWith('#/auth?request=warm-req&agent_session=warm-binding');
      expect(getAgentPageBinding()).toBe('warm-binding');
    } finally {
      __resetAgentPageBindingForTests();
    }
  });
});
