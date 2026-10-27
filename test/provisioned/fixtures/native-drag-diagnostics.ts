type ProofWindow = Window & {
  __MANDIBLE_NATIVE_HOST__?: { kind: string; platform: string; framePresentation: string };
  __TAURI__?: { core?: { invoke?: unknown }; window?: { getCurrentWindow?: () => { label?: string; startDragging?: unknown } } };
  __TAURI_INTERNALS__?: { invoke?: unknown; metadata?: { currentWindow?: { label?: string } } };
};

// Diagnostic reflection of the current delegate exclusions; this never authorizes a drag.
const INTERACTIVE = 'a,button,input,textarea,select,option,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="slider"],[role="separator"],[tabindex]:not([tabindex="-1"]),[contenteditable]:not([contenteditable="false"]),[data-native-drag-exclude]';
const describe = (element: Element | null): string | null => element
  ? `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}${element.classList.length ? '.' + Array.from(element.classList).join('.') : ''}`
  : null;
const errorText = (value: unknown): string => {
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new TextDecoder().decode(new Uint8Array(value as ArrayBuffer));
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return value instanceof Error ? value.stack ?? value.message : String(value);
};

export function installNativeDragDiagnostics(): () => void {
  const host = window as ProofWindow;
  const panel = document.createElement('pre');
  panel.id = 'native-drag-diagnostics';
  panel.setAttribute('aria-label', 'Native drag diagnostics');
  panel.style.cssText = 'position:fixed;left:16px;bottom:16px;width:calc(100% - 32px);max-width:1200px;max-height:calc(100vh - 90px);overflow:hidden;z-index:10000;box-sizing:border-box;margin:0;padding:12px;border:1px solid #777;background:#111e;color:#fff;font:11px/1.4 monospace;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none';
  document.body.append(panel);
  const state: Record<string, unknown> = { pointerCapture: null, mouseCapture: null, mouseBubble: null, error: null };
  const hit = (x: number, y: number) => describe(document.elementFromPoint?.(x, y) ?? null);
  const paint = () => {
    const band = document.querySelector('.app-native-top-bar-band');
    const rect = band?.getBoundingClientRect();
    let handle: unknown;
    try {
      const current = host.__TAURI__?.window?.getCurrentWindow?.();
      handle = current ? { label: current.label, startDragging: typeof current.startDragging } : null;
    } catch (error) { handle = { error: errorText(error) }; }
    const bridge = { nativeHost: host.__MANDIBLE_NATIVE_HOST__ ?? null,
      publicInvoke: typeof host.__TAURI__?.core?.invoke, internalInvoke: typeof host.__TAURI_INTERNALS__?.invoke,
      metadataWindow: host.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null, handle };
    const bandState = rect ? { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      centerHit: hit(rect.left + rect.width / 2, rect.top + rect.height / 2),
      computedHeight: getComputedStyle(band!).height, pointerEvents: getComputedStyle(band!).pointerEvents,
      rootHeaderHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-frame-header-height').trim() } : null;
    panel.textContent = ['Native drag diagnostics (nonshipping)', `bridge ${JSON.stringify(bridge)}`,
      `band ${JSON.stringify(bandState)}`, ...Object.entries(state).map(([key, value]) => `${key} ${JSON.stringify(value)}`)].join('\n');
  };
  const observeMouse = (key: string) => (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    state[key] = { target: describe(target), boundary: describe(target?.closest('[data-native-drag-boundary]') ?? null),
      interactive: describe(target?.closest(INTERACTIVE) ?? null), defaultPrevented: event.defaultPrevented,
      button: event.button, buttons: event.buttons, detail: event.detail, trusted: event.isTrusted,
      client: [event.clientX, event.clientY], screen: [event.screenX, event.screenY], hit: hit(event.clientX, event.clientY) };
    paint();
  };
  const pointerCapture = observeMouse('pointerCapture');
  const mouseCapture = observeMouse('mouseCapture');
  const mouseBubble = observeMouse('mouseBubble');
  const error = (event: ErrorEvent) => { state.error = errorText(event.error ?? event.message); paint(); };
  const rejection = (event: PromiseRejectionEvent) => { state.error = errorText(event.reason); paint(); };
  const originalConsoleError = console.error;
  const consoleError = (...args: unknown[]) => { state.error = args.map(errorText).join(' '); paint(); originalConsoleError.apply(console, args); };
  console.error = consoleError;
  window.addEventListener('pointerdown', pointerCapture, true);
  window.addEventListener('mousedown', mouseCapture, true);
  // Window bubbling observes defaultPrevented after the actual document delegate.
  window.addEventListener('mousedown', mouseBubble);
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  window.addEventListener('resize', paint);
  const observer = new MutationObserver(paint);
  const app = document.getElementById('proof-root');
  if (app) observer.observe(app, { childList: true, subtree: true });
  paint();
  return () => {
    observer.disconnect(); panel.remove();
    window.removeEventListener('pointerdown', pointerCapture, true);
    window.removeEventListener('mousedown', mouseCapture, true);
    window.removeEventListener('mousedown', mouseBubble);
    window.removeEventListener('error', error);
    window.removeEventListener('unhandledrejection', rejection);
    window.removeEventListener('resize', paint);
    if (console.error === consoleError) console.error = originalConsoleError;
  };
}
