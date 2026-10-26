// @vitest-environment jsdom
import { installMemoryLocalStorage, stubEventSource, stubRailSettingsFetch, previewInstance, mainInstance } from './helpers/ui-workspace-fixture';
import { cleanup, fireEvent, render, screen, waitFor, act } from './helpers/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChromeShadowPreview } from '../ui/src/hooks/useChromeShadowPreview';
import { ChromeShadowSettings } from '../ui/src/components/settings/ChromeShadowSettings';
import { AppFrame } from '../ui/src/app-frame';
import { App } from '../ui/src/app';
import { CHROME_SHADOW_DEFAULTS, chromeShadowFrameStyles, chromeShadowPreviewKey } from '../ui/src/chrome-shadow';

const key = chromeShadowPreviewKey(previewInstance);
const seeded = JSON.stringify({ version: 1, theme: 'dark', overrides: { dark: { widthPx: 12, profile: 1, maxDarkness: 0.42 } } });

function Harness({ role = 'preview', instanceId = previewInstance.instance_id, open = true }: { role?: string; instanceId?: string; open?: boolean }) {
  const preview = useChromeShadowPreview({ role, instance_id: instanceId }, 'light');
  return <AppFrame chromeShadows={preview.themes} nativeControlsReservation={0} rail={null} headerHostRef={null} hasMainHeader={false}
    viewSidebarAvailable={false} viewSidebarOpen={false} onViewSidebarToggle={() => undefined} rightSidebar={null} rightSidebarOpen={false} onRightSidebarOpenChange={() => undefined}>
    <span aria-label="theme override">{preview.themeOverride ?? 'none'}</span>
    {open && preview.controller ? <ChromeShadowSettings controller={preview.controller} /> : null}
  </AppFrame>;
}

afterEach(() => cleanup());

describe('preview chrome shadow controls', () => {
  it('updates the real frame on input and retains both themes through Settings remount, reconciliation and refresh', () => {
    installMemoryLocalStorage();
    const { container, rerender, unmount } = render(<Harness />);
    const frame = container.querySelector<HTMLElement>('.app-frame')!;
    const originalFrame = frame;
    fireEvent.input(screen.getByRole('slider', { name: 'Width' }), { target: { value: '12.25' } });
    expect(frame.style.getPropertyValue('--app-shadow-light-width')).toBe('12.25px');
    expect((screen.getByRole('spinbutton', { name: 'Width value' }) as HTMLInputElement).value).toBe('12.25');
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Profile value' }), { target: { value: '1' } });
    expect(frame.style.getPropertyValue('--app-shadow-light-linear')).toBe('rgba(0, 0, 0, 0) 0px, rgba(0, 0, 0, 0.03) 12.25px');
    fireEvent.change(screen.getByLabelText('Preview theme'), { target: { value: 'dark' } });
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
    expect(JSON.parse(window.localStorage.getItem(key)!)).toMatchObject({ theme: 'dark', overrides: { light: { widthPx: 12.25, profile: 1 }, dark: { maxDarkness: 0.421 } } });
  });

  it('resets only the edited override and exports both effective themes without local bookkeeping', async () => {
    installMemoryLocalStorage({ [key]: seeded });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Preview theme'), { target: { value: 'light' } });
    fireEvent.input(screen.getByLabelText('Width value'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ ...JSON.parse(seeded), theme: 'light' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy parameters' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Parameters copied.'));
    const exported = { version: 1, light: CHROME_SHADOW_DEFAULTS.light, dark: { widthPx: 12, profile: 1, maxDarkness: 0.42 } };
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(exported);
    expect(JSON.parse((screen.getByLabelText('Chrome shadow parameters') as HTMLTextAreaElement).value)).toEqual(exported);
    writeText.mockRejectedValue(new Error('clipboard denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy parameters' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Could not copy'));
    expect(JSON.parse((screen.getByLabelText('Chrome shadow parameters') as HTMLTextAreaElement).value)).toEqual(exported);
  });

  it('keeps incomplete numeric input local and reports persistence failure without losing the live value', () => {
    installMemoryLocalStorage();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { container } = render(<Harness />);
    const input = screen.getByLabelText('Width value');
    fireEvent.input(input, { target: { value: '' } });
    expect((input as HTMLInputElement).value).toBe('');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-light-width')).toBe('5px');
    fireEvent.input(input, { target: { value: '8' } });
    expect(screen.getByRole('alert').textContent).toContain('could not be saved');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-light-width')).toBe('8px');
  });

  it('separates instances and immediately drops overrides and local theme when the trusted role changes', () => {
    installMemoryLocalStorage({ [key]: seeded });
    const { container, rerender } = render(<Harness />);
    expect(screen.getByLabelText('theme override').textContent).toBe('dark');
    rerender(<Harness instanceId="another-preview" />);
    expect(screen.getByLabelText('theme override').textContent).toBe('none');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-width')).toBe('5px');
    for (const role of ['main', 'dev', 'test', 'unknown']) {
      rerender(<Harness role={role} />);
      expect(screen.queryByLabelText('Preview theme')).toBeNull();
      expect(screen.getByLabelText('theme override').textContent).toBe('none');
      expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-linear')).toBe(chromeShadowFrameStyles()['--app-shadow-dark-linear']);
    }
    rerender(<Harness />);
    expect(screen.getByLabelText('theme override').textContent).toBe('dark');
  });

  it('integrates Settings navigation, root theme and route persistence without canonical mutation calls', async () => {
    installMemoryLocalStorage();
    stubRailSettingsFetch();
    const events = stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: previewInstance };
    window.history.replaceState(null, '', '#/settings');
    const { container } = render(<App />);
    const select = await screen.findByLabelText('Preview theme');
    expect(screen.getByRole('button', { name: 'Chrome shadow · Preview' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'dark' } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    fireEvent.input(screen.getByLabelText('Width value'), { target: { value: '10.5' } });
    fireEvent.click(screen.getByRole('link', { name: 'Spaces' }));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => expect((screen.getByLabelText('Width value') as HTMLInputElement).value).toBe('10.5'));
    act(() => events.emit({ type: 'settings:updated', data: { settings: { app_theme: 'light' } } }));
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-width')).toBe('10.5px');
    expect(document.documentElement.dataset.theme).toBe('dark');
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD'].includes(init.method));
    expect(writes).toEqual([]);
  });

  it('hides the Settings section and ignores seeded preview values and theme in the production App', async () => {
    installMemoryLocalStorage({ [key]: seeded, [chromeShadowPreviewKey({ ...mainInstance, role: 'preview' })]: seeded });
    stubRailSettingsFetch();
    stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: mainInstance };
    window.history.replaceState(null, '', '#/settings');
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.queryByRole('button', { name: 'Chrome shadow · Preview' })).toBeNull();
    expect(screen.queryByLabelText('Preview theme')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(container.querySelector<HTMLElement>('.app-frame')!.style.getPropertyValue('--app-shadow-dark-width')).toBe('5px');
  });
});
