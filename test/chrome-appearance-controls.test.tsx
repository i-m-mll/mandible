// @vitest-environment jsdom
import { installMemoryLocalStorage, stubEventSource, stubRailSettingsFetch, previewInstance, mainInstance, render } from './helpers/ui-workspace-fixture';
import { cleanup, fireEvent, screen, waitFor, act } from './helpers/dom.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChromeAppearancePreview } from '../ui/src/hooks/useChromeAppearancePreview';
import { ChromeAppearanceActions, ChromeAppearanceControls } from '../ui/src/components/preview/ChromeAppearanceControls';
import { AppFrame } from '../ui/src/app-frame';
import { App } from '../ui/src/app';
import * as api from '../ui/src/api';
import { DEFAULT_CHILD_RETENTION_SETTINGS } from '../src/conversations/retention-contract';
import { jsonFixture } from './helpers/strict-ui-fixture';
import { chromeAppearanceFrameStyles, chromeAppearancePreviewKey } from '../ui/src/chrome-appearance';

function stubChromeSettingsFetch(): void {
  stubRailSettingsFetch(undefined, false, [{
    name: 'child retention settings', method: 'GET', path: '/api/settings/child-retention',
    respond: () => jsonFixture(DEFAULT_CHILD_RETENTION_SETTINGS),
  }]);
}

const key = chromeAppearancePreviewKey(previewInstance);
const seeded = JSON.stringify({ version: 1, theme: 'dark', overrides: { dark: { widthPx: 12, profile: 1, maxDarkness: 0.42 } } });

function Harness({ role = 'preview', instanceId = previewInstance.instance_id, open = true, glassAvailable = false }: { role?: string; instanceId?: string; open?: boolean; glassAvailable?: boolean }) {
  const preview = useChromeAppearancePreview({ role, instance_id: instanceId }, 'light', glassAvailable);
  return <AppFrame navigation={{ canBack: true, canForward: true, href: '', entryId: 'fixture', revision: 0, back: () => window.history.back(), forward: () => window.history.forward() }} chromeAppearance={preview.themes} nativeControlsReservation={0} rail={null} headerHostRef={null} hasMainHeader={false}
    viewSidebarAvailable={false} viewSidebarOpen={false} onViewSidebarToggle={() => undefined} rightSidebar={null} rightSidebarOpen={false} onRightSidebarOpenChange={() => undefined}>
    <span aria-label="theme override">{preview.themeOverride ?? 'none'}</span>
    {open && preview.controller ? <><ChromeAppearanceControls controller={preview.controller} /><ChromeAppearanceActions controller={preview.controller} /></> : null}
  </AppFrame>;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

afterEach(() => cleanup());

describe('preview chrome appearance controls', () => {
  it('migrates saved deltas once to absolute points while retaining both themes and other tuning', () => {
    installMemoryLocalStorage({ [key]: JSON.stringify({ version: 1, theme: 'light', overrides: {
      light: { widthPx: 9, profile: 0.75, maxDarkness: 0.08, glassTransparency: 0.3, textIncrementPt: 0.5 },
      dark: { widthPx: 12, profile: 1, maxDarkness: 0.42, glassTransparency: 0.65, textIncrementPt: 2 },
    } }) });
    const writes = vi.spyOn(window.localStorage, 'setItem');
    const { rerender, unmount } = render(<Harness />);
    const expected = { version: 2, theme: 'light', overrides: {
      light: { widthPx: 9, profile: 0.75, maxDarkness: 0.08, glassTransparency: 0.3, uiFontSizePt: 11 },
      dark: { widthPx: 12, profile: 1, maxDarkness: 0.42, glassTransparency: 0.65, uiFontSizePt: 12.5 },
    } };
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(expected);
    expect((screen.getByLabelText('UI font size value') as HTMLInputElement).value).toBe('11');
    rerender(<Harness />);
    unmount();
    render(<Harness />);
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(expected);
    expect(writes.mock.calls.filter(([storageKey]) => storageKey === key)).toHaveLength(1);
    const exported = JSON.parse((screen.getByLabelText('Chrome parameters') as HTMLTextAreaElement).value);
    expect(exported.version).toBe(2);
    expect(exported.dark.uiFontSizePt).toBe(12.5);
    expect(exported.dark).not.toHaveProperty('textIncrementPt');
  });

  it('shows the native glass value disabled in browsers and enables immediate per-theme tint updates only with Regular capability', async () => {
    installMemoryLocalStorage({ [key]: seeded });
    const { container, rerender, unmount } = render(<Harness />);
    const slider = screen.getByRole('slider', { name: 'Liquid Glass transparency' }) as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(slider.value).toBe('12');
    expect(screen.getByText('Available in the macOS preview window.')).toBeTruthy();
    rerender(<Harness glassAvailable />);
    expect(slider.disabled).toBe(false);
    const frame = container.querySelector<HTMLElement>('.app-frame')!;
    fireEvent.input(slider, { target: { value: '65' } });
    expect(frame.style.getPropertyValue('--app-chrome-dark-tint-percentage')).toBe('35%');
    expect((screen.getByLabelText('Liquid Glass transparency value') as HTMLInputElement).value).toBe('65');
    expect(JSON.parse((screen.getByLabelText('Chrome parameters') as HTMLTextAreaElement).value).dark.glassTransparency).toBe(0.65);
    fireEvent.change(screen.getByLabelText('Preview theme'), { target: { value: 'light' } });
    fireEvent.input(screen.getByLabelText('Liquid Glass transparency value'), { target: { value: '100' } });
    expect(frame.style.getPropertyValue('--app-chrome-light-tint-percentage')).toBe('0%');
    expect(frame.style.getPropertyValue('--app-chrome-dark-tint-percentage')).toBe('35%');
    rerender(<Harness glassAvailable open={false} />);
    rerender(<Harness glassAvailable />);
    expect(container.querySelector('.app-frame')).toBe(frame);
    unmount();
    render(<Harness glassAvailable />);
    expect((screen.getByLabelText('Liquid Glass transparency value') as HTMLInputElement).value).toBe('100');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByLabelText('Liquid Glass transparency value') as HTMLInputElement).value).toBe('12');
    expect(JSON.parse(window.localStorage.getItem(key)!).overrides).toEqual({ dark: { widthPx: 12, profile: 1, maxDarkness: 0.42, glassTransparency: 0.65, uiFontSizePt: 11 } });
  });

  it('reacts to the existing native capability owner and removes the material when Regular glass becomes unavailable', async () => {
    installMemoryLocalStorage();
    stubChromeSettingsFetch();
    stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: previewInstance };
    window.history.replaceState(null, '', '#/settings');
    let regular = true;
    let refresh!: () => void;
    vi.spyOn(api, 'getNativeWindowCapabilities').mockImplementation(async () => ({ framePresentation: 'macos-overlay', liquidGlassRegular: regular, topBarHeight: 42, trafficLightReservation: 88 }));
    vi.spyOn(api, 'listenNativeFrameChanges').mockImplementation(async callback => { refresh = callback; return () => undefined; });
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview appearance' }));
    const slider = await screen.findByRole('slider', { name: 'Liquid Glass transparency' }) as HTMLInputElement;
    await waitFor(() => expect(slider.disabled).toBe(false));
    const frame = container.querySelector<HTMLElement>('.app-frame')!;
    fireEvent.input(slider, { target: { value: '0' } });
    expect(frame.style.getPropertyValue('--app-chrome-light-tint-percentage')).toBe('100%');
    expect(document.documentElement.dataset.nativeGlass).toBe('regular');
    regular = false;
    await act(async () => refresh());
    await waitFor(() => expect(slider.disabled).toBe(true));
    expect(document.documentElement.hasAttribute('data-native-glass')).toBe(false);
    expect(container.querySelector('.app-frame')).toBe(frame);
    expect(JSON.parse((screen.getByLabelText('Chrome parameters') as HTMLTextAreaElement).value).light.glassTransparency).toBe(0);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD'].includes(init.method))).toEqual([]);
  });

  it('updates the real frame on input and retains both themes through Settings remount, reconciliation and refresh', () => {
    installMemoryLocalStorage();
    const { container, rerender, unmount } = render(<Harness />);
    const frame = container.querySelector<HTMLElement>('.app-frame')!;
    const originalFrame = frame;
    fireEvent.input(screen.getByRole('slider', { name: 'UI font size' }), { target: { value: '12.25' } });
    expect(frame.style.getPropertyValue('--app-chrome-light-ui-font-size')).toBe('12.25pt');
    fireEvent.input(screen.getByRole('slider', { name: 'Shadow width' }), { target: { value: '12.25' } });
    expect(frame.style.getPropertyValue('--app-shadow-light-width')).toBe('12.25px');
    expect((screen.getByRole('spinbutton', { name: 'Shadow width value' }) as HTMLInputElement).value).toBe('12.25');
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Profile value' }), { target: { value: '1' } });
    expect(frame.style.getPropertyValue('--app-shadow-light-linear')).toBe('rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0.04) 12.25px');
    fireEvent.change(screen.getByLabelText('Preview theme'), { target: { value: 'dark' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'UI font size value' }), { target: { value: '13.5' } });
    fireEvent.input(screen.getByRole('slider', { name: 'Maximum darkness' }), { target: { value: '42.1' } });
    expect(frame.style.getPropertyValue('--app-shadow-dark-linear')).toContain('0.421');
    expect(screen.queryByText('Dark shadow is off')).toBeNull();
    expect(container.querySelector('.app-frame')).toBe(originalFrame);
    rerender(<Harness open={false} />);
    rerender(<Harness />);
    expect((screen.getByLabelText('Preview theme') as HTMLSelectElement).value).toBe('dark');
    expect((screen.getByLabelText('Maximum darkness value') as HTMLInputElement).value).toBe('42.1');
    unmount();
    render(<Harness />);
    expect((screen.getByLabelText('Maximum darkness value') as HTMLInputElement).value).toBe('42.1');
    expect((screen.getByLabelText('UI font size value') as HTMLInputElement).value).toBe('13.5');
    expect(JSON.parse(window.localStorage.getItem(key)!)).toMatchObject({ theme: 'dark', overrides: { light: { widthPx: 12.25, profile: 1, uiFontSizePt: 12.25 }, dark: { maxDarkness: 0.421, uiFontSizePt: 13.5 } } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect((screen.getByLabelText('UI font size value') as HTMLInputElement).value).toBe('11');
    expect(JSON.parse(window.localStorage.getItem(key)!).overrides).toEqual({ light: { widthPx: 12.25, profile: 1, maxDarkness: 0.04, glassTransparency: 0.12, uiFontSizePt: 12.25 } });
  });

  it('resets only the edited override and exports both effective themes without local bookkeeping', async () => {
    installMemoryLocalStorage({ [key]: seeded });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Preview theme'), { target: { value: 'light' } });
    fireEvent.input(screen.getByLabelText('Shadow width value'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ ...JSON.parse(seeded), version: 2, theme: 'light', overrides: { dark: { widthPx: 12, profile: 1, maxDarkness: 0.42, glassTransparency: 0.12, uiFontSizePt: 11 } } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy parameters' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Parameters copied.'));
    const exported = { version: 2, light: { widthPx: 16, profile: 0.25, maxDarkness: 0.04, glassTransparency: 0.12, uiFontSizePt: 11 }, dark: { widthPx: 12, profile: 1, maxDarkness: 0.42, glassTransparency: 0.12, uiFontSizePt: 11 } };
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(exported);
    expect(JSON.parse((screen.getByLabelText('Chrome parameters') as HTMLTextAreaElement).value)).toEqual(exported);
    writeText.mockRejectedValue(new Error('clipboard denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy parameters' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Could not copy'));
    expect(JSON.parse((screen.getByLabelText('Chrome parameters') as HTMLTextAreaElement).value)).toEqual(exported);
  });

  it('keeps incomplete numeric input local and reports persistence failure without losing the live value', () => {
    installMemoryLocalStorage();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { container } = render(<Harness glassAvailable />);
    const input = screen.getByLabelText('Shadow width value');
    fireEvent.input(input, { target: { value: '' } });
    expect((input as HTMLInputElement).value).toBe('');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-light-width')).toBe('16px');
    fireEvent.input(input, { target: { value: '8' } });
    expect(screen.getByRole('alert').textContent).toContain('could not be saved');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-light-width')).toBe('8px');
    fireEvent.input(screen.getByLabelText('Liquid Glass transparency value'), { target: { value: '66' } });
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-chrome-light-tint-percentage')).toBe('34%');
    expect(JSON.parse((screen.getByLabelText('Chrome parameters') as HTMLTextAreaElement).value).light.glassTransparency).toBe(0.66);
  });

  it('separates instances and immediately drops overrides and local theme when the trusted role changes', () => {
    const withGlass = JSON.parse(seeded);
    withGlass.overrides.dark.glassTransparency = 0.91;
    installMemoryLocalStorage({ [key]: JSON.stringify(withGlass) });
    const { container, rerender } = render(<Harness />);
    expect(screen.getByLabelText('theme override').textContent).toBe('dark');
    rerender(<Harness instanceId="another-preview" />);
    expect(screen.getByLabelText('theme override').textContent).toBe('none');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-width')).toBe('5px');
    for (const role of ['main', 'dev', 'test', 'unknown']) {
      rerender(<Harness role={role} />);
      expect(screen.queryByLabelText('Preview theme')).toBeNull();
      expect(screen.getByLabelText('theme override').textContent).toBe('none');
      expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-linear')).toBe(chromeAppearanceFrameStyles()['--app-shadow-dark-linear']);
      expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-chrome-dark-tint-percentage')).toBe('88%');
    }
    rerender(<Harness />);
    expect(screen.getByLabelText('theme override').textContent).toBe('dark');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-chrome-dark-tint-percentage')).toBe('9%');
  });

  it('integrates Settings navigation, root theme and route persistence without canonical mutation calls', async () => {
    installMemoryLocalStorage();
    stubChromeSettingsFetch();
    const events = stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: previewInstance };
    window.history.replaceState(null, '', '#/settings');
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview appearance' }));
    const select = await screen.findByLabelText('Preview theme');
    fireEvent.change(select, { target: { value: 'dark' } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    fireEvent.input(screen.getByLabelText('Shadow width value'), { target: { value: '10.5' } });
    fireEvent.click(screen.getByRole('link', { name: 'Spaces' }));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => expect((screen.getByLabelText('Shadow width value') as HTMLInputElement).value).toBe('10.5'));
    act(() => events.emit({ type: 'settings:updated', data: { settings: { app_theme: 'light' } } }));
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-width')).toBe('10.5px');
    expect(document.documentElement.dataset.theme).toBe('dark');
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD'].includes(init.method));
    expect(writes).toEqual([]);
  });

  it('hides the Settings section and ignores seeded preview values and theme in the production App', async () => {
    installMemoryLocalStorage({ [key]: seeded, [chromeAppearancePreviewKey({ ...mainInstance, role: 'preview' })]: seeded });
    stubChromeSettingsFetch();
    stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: mainInstance };
    window.history.replaceState(null, '', '#/settings');
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.queryByRole('button', { name: 'Preview appearance' })).toBeNull();
    expect(screen.queryByLabelText('Preview theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-width')).toBe('5px');
  });
});
