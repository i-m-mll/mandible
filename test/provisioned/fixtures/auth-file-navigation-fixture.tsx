import { render } from 'preact';
import { RoutedAuthReview, navigationDiff, navigationRequest, navigationRequestId } from '../../helpers/auth-navigation-fixture';

window.fetch = () => Promise.reject(new Error('Offline review fixture'));
const diagnostic = new URLSearchParams(window.location.search).has('diagnostic');
const canonical = new URLSearchParams(window.location.search).has('canonical');
const canonicalId = '5e68b070-1111-4444-8888-0123456789ab';
const requestId = canonical ? canonicalId : navigationRequestId;
if (new URLSearchParams(window.location.search).has('small')) {
  const style = document.createElement('style');
  style.textContent = '.auth-detail__body{flex:none;height:463px}';
  document.head.append(style);
}
if (!window.location.hash) {
  window.localStorage.clear();
  if (diagnostic || canonical) {
    window.localStorage.setItem(`auth-review-tab:${requestId}`, JSON.stringify('diff'));
    window.localStorage.setItem(`auth-review-scroll:${requestId}:diff`, '6758.5');
  }
  window.history.replaceState({ fixtureState: 'preserved' }, '', `#/auth?request=${canonical ? canonicalId.slice(0, 8) : navigationRequestId}&sidebar=hidden&agent_session=fixture-agent`);
}
const root = document.getElementById('root')!;
const actionLayout = new URLSearchParams(location.search).has('action-layout');
if (actionLayout) {
  const completed = new URLSearchParams(location.search).has('completed');
  const issueTitle = 'A complete long issue title that remains accessible while the action row truncates its visible identity '.repeat(3);
  const request = { ...navigationRequest, repo: 'a-long-project-name-for-approval-sidebar-truncation',
    title: 'A long approval title with enough detail to truncate in the sidebar',
    status: completed ? 'completed' : 'pending', action_count: 2,
    actions: ['first', 'second'].map((id, index) => ({ ...navigationRequest.actions![0]!, id,
      kind: 'issue_close' as const, payload: {}, target_issue_ref: 'abcdef1',
      outcome_detail: null, ordinal: index,
      state: completed ? 'applied' as const : index === 0 ? 'staged' as const : 'vetoed' as const })),
  };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = input => {
    const path = String(input);
    if (path.startsWith('/api/spaces/resolve')) return Promise.resolve(json({ resolved: true,
      entity: { id: 'abcdef1', short_id: 'abcdef1', project_ref: request.repo, title: issueTitle }, detail: { same_project: true } }));
    if (path.endsWith('/actions')) return Promise.resolve(json({ actions: request.actions }));
    if (path.startsWith('/api/auth/request/')) return Promise.resolve(json(request));
    return Promise.reject(new Error('Offline layout fixture: ' + path));
  };
  render(<RoutedAuthReview requests={[request]} sidebarHidden={false} />, root);
} else if (diagnostic || canonical) {
  const events: unknown[] = [];
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (key.startsWith('auth-review-')) events.push({ event: 'save', key, value, at: performance.now() });
    setItem.call(this, key, value);
  };
  document.addEventListener('scroll', event => {
    const node = event.target;
    if (node instanceof HTMLElement && node.classList.contains('auth-detail__body')) {
      events.push({ event: 'scroll', top: node.scrollTop, height: node.clientHeight, scrollHeight: node.scrollHeight, at: performance.now() });
    }
  }, true);
  if (canonical) {
    const full = { ...navigationRequest, id: canonicalId };
    const summary = { ...full, diff_summary: undefined, spec_content: undefined, output: undefined, change_report: undefined, actions: undefined };
    let resolveDetail: ((response: Response) => void) | undefined;
    let detailCalls = 0;
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = input => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      if (path === '/api/client-auth/whoami') return Promise.resolve(json({ authenticated: true, session: { csrf_token: 'fixture' } }));
      if (path.endsWith('/actions')) return Promise.resolve(json({ actions: full.actions }));
      if (path.startsWith('/api/auth/request/')) {
        detailCalls += 1;
        return new Promise(resolve => { if (detailCalls === 1) resolveDetail = resolve; });
      }
      return Promise.reject(new Error('Offline fixture route: ' + path));
    };
    Object.assign(window, { scrollDiagnostic: { events, requestId, resolveDetail: () => resolveDetail?.(json(full)), get detailCalls() { return detailCalls; } } });
    render(<RoutedAuthReview requests={[summary]} />, root);
  } else {
    const mount = (hydrated: boolean) => render(<RoutedAuthReview requests={[hydrated ? navigationRequest : {
      ...navigationRequest, diff_summary: undefined, spec_content: undefined, output: undefined,
    }]} />, root);
    Object.assign(window, { scrollDiagnostic: { events, requestId, hydrate: () => mount(true), summary: () => mount(false), unmount: () => render(null, root) } });
    mount(false);
  }
} else render(<RoutedAuthReview requests={[new URLSearchParams(window.location.search).has('partial') ? {
  ...navigationRequest, diff_summary: navigationDiff.split(/^(?=diff --git )/m).slice(0, 18).join(''),
} : navigationRequest]} />, root);
