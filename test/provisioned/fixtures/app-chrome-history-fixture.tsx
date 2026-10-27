import { render } from 'preact';
import { createPortal } from 'preact/compat';
import { useState } from 'preact/hooks';
import { AppFrame } from '../../../ui/src/app-frame';
import { appHistory, pushAppHistory, replaceAppHistory } from '../../../ui/src/app-history';
import { useAppHistory } from '../../../ui/src/hooks/useAppHistory';
import { AppHoverTips, appTip } from '../../../ui/src/components/shared/AppHoverTips';
import { navigateAuthFile } from '../../../ui/src/views/auth-review-navigation';
import { DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE } from '../../../ui/src/views/auth-change-breakdown-state';

const reloaded = sessionStorage.getItem('chrome-proof-reload') === 'yes';
if (!reloaded) {
  history.replaceState({ previousDocument: true }, '', '#/bootstrap');
  history.pushState({ deepLink: true }, '', '#/A');
}
function Fixture(): JSX.Element {
  const navigation = useAppHistory();
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  return <div className="app-shell"><AppHoverTips /><AppFrame navigation={navigation} nativeControlsReservation={0} rail={<aside className="app-rail"><button className="app-rail__item" {...appTip('Rail', 'right')}>Rail</button></aside>}
    headerHostRef={setHeader} hasMainHeader viewSidebarAvailable viewSidebarOpen onViewSidebarToggle={() => undefined} rightSidebar={null} rightSidebarOpen={false} onRightSidebarOpenChange={() => undefined}>
    <aside className="view-sidebar"><span>Sidebar UI</span><input aria-label="Search" /></aside><main className="proof-main"><a id="hash-link" href="#/B"><span>Hash navigation</span></a><p>Selectable workspace content</p></main>
  </AppFrame>{header ? createPortal(<button {...appTip('Portaled action')} aria-label="Portaled action"><span>Action</span></button>, header) : null}</div>;
}
render(<Fixture />, document.getElementById('root')!);
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const wait = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) { if (predicate()) return; await wait(); }
  throw new Error(label);
}
async function proof(): Promise<void> {
  const owner = appHistory();
  const back = document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!;
  const forward = document.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!;
  if (!reloaded) {
    assert(back.disabled && forward.disabled, 'fresh deep link must disable both directions despite prior browser entry');
    owner.back(); assert(location.hash === '#/A', 'app Back must not enter bootstrap');
    document.querySelector<HTMLElement>('#hash-link span')!.click();
    await until(() => location.hash === '#/B' && !back.disabled, 'hash anchor must route through owner');
    const firstB = owner.snapshot().entryId;
    owner.back(); owner.back();
    await until(() => location.hash === '#/A' && back.disabled, 'repeated Back must stop at known boundary');
    owner.forward(); await until(() => location.hash === '#/B', 'Forward must recover after guarded traversal');
    pushAppHistory('#/C');
    let changes = 0; const unsubscribe = owner.subscribe(() => changes++);
    history.back();
    await until(() => location.hash === '#/B' && !forward.disabled, 'browser Back must select known entry');
    await wait(); assert(changes === 1, 'popstate/hashchange pair must publish once'); unsubscribe();
    owner.forward(); await until(() => location.hash === '#/C' && forward.disabled, 'app Forward must traverse');
    owner.back(); await until(() => location.hash === '#/B', 'app Back must traverse');
    pushAppHistory('#/B');
    assert(owner.snapshot().entryId !== firstB && !owner.snapshot().canForward, 'repeated URL needs unique identity and push truncates Forward');
    const replacement = owner.snapshot().entryId;
    replaceAppHistory('#/D', { unrelated: 'preserved' });
    assert(owner.snapshot().entryId === replacement, 'replace must preserve position');
    owner.back(); await until(() => location.hash === '#/B', 'replace must not add entry');
    owner.forward(); await until(() => location.hash === '#/D', 'replacement remains traversable');
    navigateAuthFile('request', { oldPath: 'before.ts', newPath: 'after.ts' }, {
      requestId: 'request', breakdown: DEFAULT_AUTH_CHANGE_BREAKDOWN_VIEW_STATE,
      description: { descriptionExpanded: false, referencesExpanded: true }, actions: { expanded: true, actionIds: ['a'] },
      showSpec: true, showDirtyNote: true, outerOffset: 123, itemOffsets: {},
    });
    assert(location.hash.includes('view=diff') && history.state.unrelated === 'preserved', 'Auth Diff must retain unrelated state');
    owner.back(); await until(() => location.hash.includes('view=info'), 'Auth Back must restore Info origin');
    assert(history.state.mandibleAuthReview.info.outerOffset === 123, 'Auth origin payload must survive');
    sessionStorage.setItem('chrome-proof-reload', 'yes'); location.reload(); return;
  }
  await until(() => !back.disabled && !forward.disabled, 'refresh must restore both known directions');
  assert(location.hash.includes('view=info') && history.state.mandibleAuthReview.info.outerOffset === 123, 'refresh must retain current selection and Auth payload');
  const portal = document.querySelector<HTMLButtonElement>('[aria-label="Portaled action"]')!;
  const initial = portal.getBoundingClientRect();
  portal.focus();
  await until(() => document.querySelector('[role="tooltip"]')?.textContent === 'Portaled action', 'focus must open shared fast portal tip');
  const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!.getBoundingClientRect();
  assert(tip.left >= 0 && tip.right <= innerWidth && tip.top >= 0 && tip.bottom <= innerHeight, 'tooltip must stay inside viewport');
  assert(!portal.hasAttribute('title') && portal.getBoundingClientRect().left === initial.left, 'custom tip must not duplicate browser title or move layout');
  portal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !document.querySelector('[role="tooltip"]'), 'Escape must dismiss tip');
  assert(getComputedStyle(document.querySelector('.app-frame__bar')!).userSelect === 'none', 'top bar must not select');
  assert(getComputedStyle(document.querySelector('.app-rail')!).userSelect === 'none', 'rail must not select');
  assert(getComputedStyle(document.querySelector('.view-sidebar')!).userSelect === 'none', 'view sidebar must not select');
  assert(getComputedStyle(document.querySelector('input')!).userSelect === 'text', 'editable fields remain selectable');
  assert(getComputedStyle(document.querySelector('.proof-main')!).userSelect !== 'none', 'workspace content remains selectable');
  history.pushState({ unknown: true }, '', '#/unowned');
  owner.back();
  await until(() => back.disabled && forward.disabled, 'unknown entry must reset safe boundary');
  assert(location.hash === '#/unowned', 'controls must not escape an unknown boundary');
  back.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  await until(() => document.querySelector('[role="tooltip"]')?.textContent === 'Back', 'disabled Back must retain its hover tip');
  document.title = btoa(JSON.stringify({ ok: true, reload: true, history: 'known entries only', tips: 'pointer/focus/portal', selection: 'chrome only' }));
}
void proof().catch(error => { document.title = 'proof-error:' + btoa(String(error?.stack ?? error)); });
