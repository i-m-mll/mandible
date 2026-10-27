// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from './helpers/dom';
import { NativeTopBarBand } from '../ui/src/components/NativeTopBarBand';
import { installNativeTopBarDragging } from '../ui/src/native-top-bar';
import { installNativeDragDiagnostics } from './provisioned/fixtures/native-drag-diagnostics';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.style.removeProperty('--app-frame-header-height'); });

it('reports actual event propagation and native errors without replacing the bridge or authorizing extra drags', async () => {
  const invoke = vi.fn();
  const getCurrentWindow = vi.fn(() => ({ label: 'main', startDragging: vi.fn() }));
  const bridge = { core: { invoke }, window: { getCurrentWindow } };
  vi.stubGlobal('__TAURI__', bridge);
  vi.stubGlobal('__MANDIBLE_NATIVE_HOST__', { kind: 'tauri', platform: 'macos', framePresentation: 'macos-overlay' });
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke, metadata: { currentWindow: { label: 'main' } } });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<div id="proof-root"><NativeTopBarBand /><header data-native-drag-boundary><button>Action</button></header></div>);
  const band = document.querySelector<HTMLElement>('.app-native-top-bar-band')!;
  vi.spyOn(band, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1400, height: 42 } as DOMRect);
  band.style.height = '42px'; document.documentElement.style.setProperty('--app-frame-header-height', '42px');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => band) });
  const removeDiagnostics = installNativeDragDiagnostics();
  const drag = vi.fn().mockRejectedValue(new Error('Real native command rejected'));
  const removeDelegate = installNativeTopBarDragging(document, drag);
  const read = (key: string) => JSON.parse(document.getElementById('native-drag-diagnostics')!.textContent!.split('\n').find(line => line.startsWith(key + ' '))!.slice(key.length + 1));
  try {
    expect(read('bridge')).toMatchObject({ nativeHost: { kind: 'tauri' }, publicInvoke: 'function', internalInvoke: 'function', handle: { label: 'main', startDragging: 'function' } });
    expect(read('band')).toMatchObject({ rect: { top: 0, height: 42 }, computedHeight: '42px', rootHeaderHeight: '42px', centerHit: 'div.app-native-top-bar-band' });
    await act(async () => { fireEvent.mouseDown(band, { button: 0, buttons: 1, clientX: 450, clientY: 20 }); });
    expect(drag).toHaveBeenCalledTimes(1);
    expect(read('mouseCapture')).toMatchObject({ target: 'div.app-native-top-bar-band', boundary: 'div.app-native-top-bar-band', interactive: null, defaultPrevented: false, client: [450, 20] });
    expect(read('mouseBubble')).toMatchObject({ defaultPrevented: true });
    expect(read('error')).toContain('Failed to drag native window:');
    expect(read('error')).toContain('Real native command rejected');
    expect(consoleError).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Action' }), { button: 0 });
    expect(read('mouseBubble')).toMatchObject({ interactive: 'button', defaultPrevented: false });
    expect(drag).toHaveBeenCalledTimes(1);
    expect((window as Window & { __TAURI__: unknown }).__TAURI__).toBe(bridge);
    expect(invoke).not.toHaveBeenCalled();
  } finally { removeDelegate(); removeDiagnostics(); }
  expect(document.getElementById('native-drag-diagnostics')).toBeNull();
  expect(console.error).toBe(consoleError);
});
