import { vi } from 'vitest';
import { mockChatViewport } from './conversation-ui-transport';

/** Static layout for interaction tests; exact browser geometry belongs in provisioned tests. */
export function installReadingBrowserFixture(): () => void {
  mockChatViewport();
  const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) {
    const top = Math.max(0, Math.min(Number(options.top ?? this.scrollTop), this.scrollHeight - this.clientHeight));
    if (top === this.scrollTop) return;
    this.scrollTop = top;
    this.dispatchEvent(new Event('scroll'));
    this.dispatchEvent(new Event('scrollend'));
  } });
  const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  const textRect = function (this: Range): DOMRect {
    const node = this.startContainer;
    return (node instanceof Element ? node : node.parentElement)?.getBoundingClientRect() ?? new DOMRect();
  };
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: textRect });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function (this: Range) {
    const rect = textRect.call(this);
    return Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
  } });
  const fonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(new EventTarget(), {
    ready: Promise.resolve(), load: async () => [], check: () => true,
  }) });
  const height = (element: HTMLElement): number => {
    const explicit = parseFloat(element.style.height);
    if (Number.isFinite(explicit)) return explicit;
    return element.classList.contains('stream-renderer__scroll') ? 600 : 80;
  };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const host = this.closest<HTMLElement>('[data-reading-measurement-host]');
    const width = parseFloat(this.style.width) || (host && parseFloat(host.style.width)) || 800;
    return new DOMRect(0, 0, width, height(this));
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Math.max(height(this), ...Array.from(this.children, child => height(child as HTMLElement)));
  });
  vi.stubGlobal('ResizeObserver', class {
    private targets = new Set<Element>();
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.targets.add(target);
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        const contentRect = target.getBoundingClientRect();
        const size = [{ inlineSize: contentRect.width, blockSize: contentRect.height }];
        this.callback([{ target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size }], this as unknown as ResizeObserver);
      });
    }
    unobserve(target: Element): void { this.targets.delete(target); }
    disconnect(): void { this.targets.clear(); }
  });
  return () => {
    if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo);
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    if (rangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeRect);
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    if (rangeRects) Object.defineProperty(Range.prototype, 'getClientRects', rangeRects);
    else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
    if (fonts) Object.defineProperty(document, 'fonts', fonts);
    else delete (document as { fonts?: unknown }).fonts;
  };
}
