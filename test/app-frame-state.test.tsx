// @vitest-environment jsdom
import { createContext } from 'preact';
import { useCallback, useContext, useState } from 'preact/hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from './helpers/dom';
import { AppFrame } from '../ui/src/app-frame';
import { useNativeWindowPresentation } from '../ui/src/native-window-presentation';
import { getNativeWindowCapabilities, listenNativeFrameChanges, type NativeHost, type NativeWindowCapabilities } from '../ui/src/api';

vi.mock('../ui/src/api', async importOriginal => ({
  ...await importOriginal<typeof import('../ui/src/api')>(),
  getNativeWindowCapabilities: vi.fn(),
  listenNativeFrameChanges: vi.fn(),
}));

const windowed: NativeWindowCapabilities = { framePresentation: 'macos-overlay', topBarHeight: 42, trafficLightReservation: 95, liquidGlassRegular: true };
function nativeHost() {
  Object.assign(window, {
    __TAURI_INTERNALS__: { invoke: vi.fn() },
    __MANDIBLE_NATIVE_HOST__: { kind: 'tauri', platform: 'macos', framePresentation: 'macos-overlay' } satisfies NativeHost,
  });
}
beforeEach(() => {
  vi.mocked(getNativeWindowCapabilities).mockReset().mockResolvedValue({ ...windowed, framePresentation: 'system', trafficLightReservation: 0, liquidGlassRegular: false });
  vi.mocked(listenNativeFrameChanges).mockReset().mockResolvedValue(() => {});
});
import { AppShellProvider, type AppShellContextValue, type AppRightSidebarDescriptor } from '../ui/src/app-shell';
import { DetailPaneHeader } from '../ui/src/components/shared/DetailPaneHeader';
import { DetailPaneShell } from '../ui/src/components/shared/DetailPaneShell';

const Selection = createContext('');
function HeaderAction({ onChoose }: { onChoose(value: string): void }) {
  const selected = useContext(Selection);
  return <button onClick={() => onChoose(selected)}>Choose current item</button>;
}
function Harness() {
  const reservation = useNativeWindowPresentation();
  const [route, setRoute] = useState('chat');
  const [revision, setRevision] = useState(0);
  const [chosen, setChosen] = useState('');
  const [open, setOpen] = useState(true);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [owners, setOwners] = useState(0);
  const registerFrameHeader = useCallback(() => { setOwners(n => n + 1); return () => setOwners(n => n - 1); }, []);
  const descriptor: AppRightSidebarDescriptor = { id: 'test', kind: 'panel', title: 'Preview', ariaLabel: 'Preview', open, width: 300, content: null, onOpenChange: setOpen, onWidthChange: () => undefined };
  const context: AppShellContextValue = { active: true, frameHeaderHost: host, registerFrameHeader, rightSidebar: descriptor, registerRightSidebar: () => () => undefined, updateRightSidebar: () => undefined, registerInitialRouteLoad: () => undefined, setViewSidebarWidth: () => undefined };
  return <>
    <button onClick={() => setRoute(route === 'chat' ? 'issue' : 'chat')}>Switch route</button>
    <button onClick={() => setRevision(n => n + 1)}>Reconcile</button>
    <output aria-label="Chosen item">{chosen}</output>
    <AppFrame nativeControlsReservation={reservation} rail={null} headerHostRef={setHost} hasMainHeader={owners > 0} viewSidebarAvailable={false} viewSidebarOpen={false} onViewSidebarToggle={() => undefined} rightSidebar={descriptor} rightSidebarOpen={open} onRightSidebarOpenChange={setOpen}>
      <section hidden={route !== 'chat'}>
        <AppShellProvider value={{ ...context, active: route === 'chat' }}>
          <Selection.Provider value={`selected-${revision}`}>
            <DetailPaneShell headerPlacement="frame" header={<DetailPaneHeader variant="compact" title="Current conversation" menu={<HeaderAction onChoose={setChosen} />} />}>
              <textarea aria-label="Draft" />
              <div role="region" aria-label="Transcript" style={{ overflow: 'auto', height: 30 }}><div style={{ height: 900 }} /></div>
              <DetailPaneShell presentation="sidebar" header={<DetailPaneHeader variant="compact" title="Nested inspector" />}>Nested content</DetailPaneShell>
            </DetailPaneShell>
          </Selection.Provider>
        </AppShellProvider>
      </section>
      <section hidden={route !== 'issue'}><AppShellProvider value={{ ...context, active: route === 'issue' }}>
        <DetailPaneShell header={<DetailPaneHeader variant="standard" identity={{ displayRef: '123', canonicalRef: '123' }} title="Current issue" />}>Issue content</DetailPaneShell>
      </AppShellProvider></section>
    </AppFrame>
  </>;
}
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  Reflect.deleteProperty(window, '__MANDIBLE_NATIVE_HOST__');
  vi.restoreAllMocks();
});

it('keeps the active primary header connected to its view and preserves mounted view intent', async () => {
  render(<Harness />);
  expect(document.documentElement.dataset.framePresentation).toBe('system');
  const bar = screen.getByRole('banner', { name: 'Application controls' });
  await waitFor(() => expect(within(bar).getByRole('heading', { name: 'Current conversation' })).toBeTruthy());
  expect(within(bar).queryByRole('heading', { name: 'Nested inspector' })).toBeNull();
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  fireEvent.input(draft, { target: { value: 'Unsent work' } });
  const transcript = screen.getByRole('region', { name: 'Transcript' });
  transcript.scrollTop = 90;
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
  fireEvent.click(within(bar).getByRole('button', { name: 'Choose current item' }));
  expect(screen.getByRole('status', { name: 'Chosen item' }).textContent).toBe('selected-1');
  fireEvent.click(screen.getByRole('button', { name: 'Switch route' }));
  await waitFor(() => expect(within(bar).queryByRole('heading', { name: 'Current conversation' })).toBeNull());
  expect(screen.getByRole('heading', { name: 'Current issue' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Switch route' }));
  await waitFor(() => expect(within(bar).getByRole('heading', { name: 'Current conversation' })).toBeTruthy());
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('Unsent work');
  expect(transcript.scrollTop).toBe(90);
});

it('retains the focused dock toggle while its open state changes', async () => {
  render(<Harness />);
  const toggle = screen.getByRole('button', { name: 'Hide Preview' });
  toggle.focus();
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show Preview' })).toBe(toggle));
  expect(document.activeElement).toBe(toggle);
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Hide Preview' })).toBe(toggle));
  expect(document.activeElement).toBe(toggle);
});


it('establishes the native frame from host identity while capability and event access are unavailable', async () => {
  nativeHost();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let rejectRead!: (error: Error) => void;
  vi.mocked(getNativeWindowCapabilities).mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
  vi.mocked(listenNativeFrameChanges).mockRejectedValue(new Error('Event listen denied'));
  render(<Harness />);
  const bar = screen.getByRole('banner', { name: 'Application controls' });
  const back = within(bar).getByRole('button', { name: 'Back' });
  await waitFor(() => expect(document.documentElement.dataset.framePresentation).toBe('macos-overlay'));
  await waitFor(() => expect(errors).toHaveBeenCalledWith('Failed to subscribe to native frame changes:', expect.any(Error)));
  rejectRead(new Error('Capability read unavailable'));
  await waitFor(() => expect(errors).toHaveBeenCalledWith('Failed to read native window capabilities:', expect.any(Error)));
  expect(document.documentElement.dataset.framePresentation).toBe('macos-overlay');
  expect(within(bar).getByRole('button', { name: 'Back' })).toBe(back);
  expect(back.previousElementSibling).toBeNull();
});

it('changes only the native reservation through fullscreen entry and exit while preserving the frame and view intent', async () => {
  nativeHost();
  let capabilities = windowed;
  let refresh!: () => void;
  const unsubscribe = vi.fn();
  vi.mocked(getNativeWindowCapabilities).mockImplementation(async () => capabilities);
  vi.mocked(listenNativeFrameChanges).mockImplementation(async callback => { refresh = callback; return unsubscribe; });
  const view = render(<Harness />);
  const bar = screen.getByRole('banner', { name: 'Application controls' });
  const back = within(bar).getByRole('button', { name: 'Back' });
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  fireEvent.input(draft, { target: { value: 'Unsent native work' } });
  await waitFor(() => expect(back.previousElementSibling?.tagName).toBe('SPAN'));
  expect(document.documentElement.dataset.framePresentation).toBe('macos-overlay');
  capabilities = { ...windowed, trafficLightReservation: 0 };
  refresh();
  await waitFor(() => expect(back.previousElementSibling).toBeNull());
  expect(document.documentElement.dataset.framePresentation).toBe('macos-overlay');
  expect(within(bar).getByRole('button', { name: 'Back' })).toBe(back);
  capabilities = windowed;
  refresh();
  await waitFor(() => expect(back.previousElementSibling?.tagName).toBe('SPAN'));
  expect(document.documentElement.dataset.framePresentation).toBe('macos-overlay');
  expect(screen.getByRole('banner', { name: 'Application controls' })).toBe(bar);
  expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe('Unsent native work');
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
