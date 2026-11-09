// @vitest-environment jsdom
import { h } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import type { ResolverResult } from '../src/contracts';
import { __resetAgentPageBindingForTests, adoptAgentSessionFromLocation, getAgentPageBinding } from '../ui/src/agent-page-binding';
import { navigateToMandibleDeepLink } from '../ui/src/deep-links';
import { currentRoute, navigateTo, routeFromUrl } from '../ui/src/routing';
import { IssuesView, type IssueRepoSummary } from '../ui/src/views/issues';
import { issueDetailProjection, render } from './helpers/ui-workspace-fixture';
import { fireEvent, screen, waitFor } from './helpers/dom.js';

describe('route table parsing', () => {
  it.each([
    ['/', null, null],
    ['/issues', 'issues', null],
    ['/briefing', 'briefing', null],
    ['/issue/mandible/4c26383', 'issues', { kind: 'issue', ref: 'mandible/4c26383' }],
    ['/auth/2257522a', 'auth', { kind: 'auth', ref: '2257522a' }],
    ['/artifact/artifact-series:abcdef1@3', 'artifacts', { kind: 'artifact', ref: 'artifact-series:abcdef1@3' }],
    ['/briefing/a%20b', 'briefing', { kind: 'briefing', ref: 'a b' }],
  ])('opens %s in its tab with its entity', (pathname, tab, entity) => {
    const route = routeFromUrl({ pathname, search: '?sidebar=hidden' });
    expect(route).toMatchObject({ tab, entity, params: { sidebar: 'hidden' } });
    expect(route.path.kind).not.toBe('not_found');
  });

  it.each(['/no-such-view', '/issue', '/issues/4c26383', '/issue/%E0%A4%A', '/chat-history'])('treats %s as not found', (pathname) => {
    expect(routeFromUrl({ pathname, search: '' })).toMatchObject({ path: { kind: 'not_found', path: pathname }, tab: null, entity: null });
  });
});

describe('mandible deep links', () => {
  it('navigates to the named path and adopts its agent session', () => {
    __resetAgentPageBindingForTests();
    window.history.replaceState(null, '', '/issues');
    expect(navigateToMandibleDeepLink('mandible:///issue/x?agent_session=s', navigateTo)).toBe(true);
    expect(`${window.location.pathname}${window.location.search}`).toBe('/issue/x?agent_session=s');
    expect(getAgentPageBinding()).toBe('s');
    const navigate = vi.fn();
    expect(navigateToMandibleDeepLink('mandible://connections/setup', navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('issue entity paths', () => {
  const issue = (id: string, title: string) => ({
    id, repo_id: 'mandible', repo_name: 'mandible', title, status: 'open', labels: [], author: 'MLL',
    created_at: '2026-05-30T12:00:00.000Z', description: '',
  });
  const repos: IssueRepoSummary[] = [{
    repo_id: 'mandible', project_key: 'mandible', repo_name: 'mandible', open_count: 2, delivered_count: 0, closed_count: 0,
    issues: [issue('4c26383', 'First issue'), issue('9f0e111', 'Second issue')],
  }];

  function serve(resolution: (ref: string) => ResolverResult): string[] {
    const resolved: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://app.invalid');
      if (url.pathname === '/api/refs/resolve') {
        const ref = url.searchParams.get('ref')!;
        resolved.push(ref);
        return Promise.resolve(Response.json({ resolution: resolution(ref) }));
      }
      const displayId = url.pathname.includes('9f0e111') ? '9f0e111' : '4c26383';
      return Promise.resolve(Response.json(issueDetailProjection({ displayId, title: `Detail ${displayId}` })));
    }));
    return resolved;
  }

  function open(path: string) {
    __resetAgentPageBindingForTests();
    window.history.replaceState(null, '', path);
    adoptAgentSessionFromLocation();
    const route = currentRoute();
    return render(h(IssuesView, { repos, onRescan: async () => undefined, entityRef: route.entity?.ref ?? null }));
  }

  it('opens the resolved issue and keeps agent_session and sidebar through an in-app selection', async () => {
    const resolved = serve((ref) => ({ kind: 'issue', ref, status: 'resolved', entity: { project_key: 'mandible', short_id: '4c26383' } }));
    open('/issue/4c26383?agent_session=s&sidebar=hidden');
    expect(await screen.findByRole('heading', { name: 'Detail 4c26383' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Second issue/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/issue/9f0e111'));
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ agent_session: 's', sidebar: 'hidden' });
    expect(await screen.findByRole('heading', { name: 'Detail 9f0e111' })).toBeTruthy();
    expect(resolved).toEqual(['4c26383']);
  });

  it('opens no issue for a ref the resolver does not find', async () => {
    serve((ref) => ({ kind: 'issue', ref, status: 'not_found' }));
    open('/issue/0000000');
    await waitFor(() => expect(document.querySelector('.entity-route-state code')).not.toBeNull());
    expect(document.querySelector('.issues-detail h2')).toBeNull();
    expect(document.querySelector('.issues-list [aria-current="true"]')).toBeNull();
  });

  it('links each ambiguous candidate to its own path with the query carried', async () => {
    serve((ref) => ({
      kind: 'issue', ref, status: 'ambiguous', total: 52,
      matches: [
        { kind: 'issue', ref: 'mandible/4c26383', title: 'First issue', updated_at: '2026-05-31T00:00:00.000Z' },
        { kind: 'issue', ref: 'widgets/4c26383', title: 'Other issue', updated_at: '2026-05-30T00:00:00.000Z' },
      ],
    }));
    open('/issue/4c26383?agent_session=s&sidebar=hidden');
    await waitFor(() => expect(document.querySelectorAll('.entity-route-state a')).toHaveLength(2));
    const targets = [...document.querySelectorAll<HTMLAnchorElement>('.entity-route-state a')]
      .map((anchor) => routeFromUrl(new URL(anchor.href)));
    expect(targets).toMatchObject(['mandible/4c26383', 'widgets/4c26383'].map((ref) => ({
      entity: { kind: 'issue', ref }, params: { agent_session: 's', sidebar: 'hidden' },
    })));
    expect(document.querySelector('.issues-detail h2')).toBeNull();
  });
});
