import { render } from 'preact';
import { SettingsView } from '../../../ui/src/views/settings';
import { DEFAULT_CHILD_RETENTION_SETTINGS } from '../../../src/conversations/retention-contract';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
let loadCleanup: (() => void) | undefined;
const requests: string[] = [];
const unmodeledRequests: string[] = [];
window.fetch = async (input) => {
  const path = String(input);
  requests.push(path);
  if (path === '/api/client-auth/whoami') return json({ authenticated: true, session: { csrf_token: 'fixture' } });
  if (path === '/api/settings/child-retention') return new Promise<Response>(resolve => {
    loadCleanup = () => resolve(json(DEFAULT_CHILD_RETENTION_SETTINGS));
  });
  if (path === '/api/user-settings/managed_chat_defaults') return json({ value: null });
  unmodeledRequests.push(path);
  throw new Error('Unmodeled Settings fixture request: ' + path);
};
const host = document.getElementById('root')!;
const refresh = () => render(<SettingsView settings={{}} onSave={async () => undefined} />, host);
refresh();

async function until(label: string, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    const timer = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error(label + JSON.stringify({ requests, active: document.querySelector('[aria-current]')?.outerHTML, scroll: document.querySelector('.settings-view')?.scrollTop }))); }, 5000);
    const check = () => {
      if (predicate()) { clearTimeout(timer); resolve(); }
      else frame = requestAnimationFrame(check);
    };
    check();
  });
}

Object.assign(window, { runSettingsNavigationProof: async () => {
  await until('Settings mount', () => !!document.querySelector('[aria-current=location]') && !!loadCleanup);
  const root = document.querySelector<HTMLElement>('.settings-view')!;
  const section = (id: string) => root.querySelector<HTMLElement>('#' + id)!;
  const nav = (id: string) => root.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`)!;
  const active = () => root.querySelector<HTMLElement>('[aria-current=location]');
  const atTarget = (id: string) => {
    const target = section(id);
    const offset = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const margin = parseFloat(getComputedStyle(target).scrollMarginTop);
    const max = root.scrollHeight - root.clientHeight;
    return active() === nav(id) && !target.hidden && !nav(id).hidden
      && (Math.abs(offset - margin) < 2 || Math.abs(root.scrollTop - max) < 2);
  };
  const jump = async (id: string) => {
    nav(id).click();
    await until('Navigation did not reach ' + id, () => atTarget(id));
  };
  const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
  const filter = (query: string) => { search.value = query; search.dispatchEvent(new Event('input', { bubbles: true })); };
  const checkpoints: string[] = [];

  await jump('settings-chat-defaults');
  await jump('settings-child-cleanup');
  await jump('settings-conversations');
  checkpoints.push('formerly-misordered-sections');

  // The async cleanup response expands an earlier section while the user reads Conversations.
  root.style.overflowAnchor = 'none';
  const before = section('settings-child-cleanup').getBoundingClientRect().height;
  loadCleanup!();
  await until('Cleanup content did not load', () => section('settings-child-cleanup').getBoundingClientRect().height > before);
  await until('Async content did not update the reading position', () => active() === nav('settings-child-cleanup'));
  root.style.overflowAnchor = '';
  await jump('settings-child-cleanup');
  root.scrollTo({ top: root.scrollTop + section('settings-conversations').getBoundingClientRect().top
    - root.getBoundingClientRect().top - parseFloat(getComputedStyle(section('settings-conversations')).scrollMarginTop), behavior: 'instant' });
  await until('Manual scrolling did not select visible Conversations', () => atTarget('settings-conversations'));
  checkpoints.push('async-height-and-manual-scroll');

  await jump('settings-backup');
  if (section('settings-backup').getBoundingClientRect().top <= root.getBoundingClientRect().top + 26) {
    throw new Error('Fixture must exercise an unreachable trailing alignment');
  }
  checkpoints.push('short-trailing-section');

  nav('settings-notifications').click();
  nav('settings-child-cleanup').click();
  await until('Second navigation failed to supersede motion', () => atTarget('settings-child-cleanup'));
  checkpoints.push('rapid-navigation');

  filter('child cleanup');
  await until('Filter retained a hidden active target', () => nav('settings-conversations').hidden && active() === nav('settings-child-cleanup'));
  const scroll = root.scrollTop;
  refresh();
  await until('Refresh lost filter state', () => root.querySelector<HTMLInputElement>('input[type=search]')?.value === 'child cleanup' && nav('settings-conversations').hidden);
  if (root.scrollTop !== scroll) throw new Error('Unrelated refresh moved Settings scroll');
  filter('no-settings-could-match-this-query');
  await until('Empty search retained selection', () => !active() && !!root.querySelector('[role=status]'));
  filter('');
  await until('Unfilter did not reconcile visible selection', () => !!active() && !section(active()!.getAttribute('aria-controls')!).hidden && !nav('settings-conversations').hidden);
  root.style.fontSize = '20px';
  root.style.height = '620px';
  await jump('settings-child-cleanup');
  checkpoints.push('filter-empty-unfilter-refresh-and-resize');
  if (unmodeledRequests.length) throw new Error('Unmodeled requests: ' + unmodeledRequests.join(', '));
  return checkpoints;
} });
