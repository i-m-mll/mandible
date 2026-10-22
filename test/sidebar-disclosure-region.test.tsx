import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarGroupNode } from '../ui/src/components/shared/SidebarGroupNode';

type ResizeCallback = ResizeObserverCallback;

let nextFrameId = 0;
let frames = new Map<number, FrameRequestCallback>();
let resizeCallbacks: ResizeCallback[] = [];

function setScrollHeight(element: Element, height: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: height });
}

function flushFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  act(() => queued.forEach((callback) => callback(performance.now())));
}

function finishHeightTransition(element: Element): void {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'height' });
  fireEvent(element, event);
}

function mediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
}

beforeEach(() => {
  nextFrameId = 0;
  frames = new Map();
  resizeCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => {
    frames.delete(id);
  }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeCallback) {
      resizeCallbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery(false)));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SidebarDisclosureRegion through typed SidebarGroupNode consumers', () => {
  it('measures live categorical content, cleans up closed focus targets, and preserves disclosure semantics', () => {
    const onToggle = vi.fn();
    const renderNode = (expanded: boolean) => (
      <SidebarGroupNode
        id="chat-pinned"
        presentation="category"
        label="Pinned"
        expanded={expanded}
        onToggle={onToggle}
        bodyAs="ul"
      >
        <li><button type="button">Pinned chat</button></li>
      </SidebarGroupNode>
    );
    const view = render(renderNode(true));

    const heading = screen.getByRole('button', { name: 'Pinned' });
    expect(heading.tagName).toBe('BUTTON');
    expect(heading.getAttribute('type')).toBe('button');
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(heading.getAttribute('aria-controls')).toBe('chat-pinned-body');
    expect(document.querySelector('#chat-pinned-body > ul')).not.toBeNull();
    fireEvent.click(heading);
    expect(onToggle).toHaveBeenCalledOnce();

    const focusTarget = screen.getByRole('button', { name: 'Pinned chat' });
    focusTarget.focus();
    const content = document.querySelector('#chat-pinned-body > ul') as HTMLUListElement;
    setScrollHeight(content, 84);
    view.rerender(renderNode(false));

    const closingRegion = document.getElementById('chat-pinned-body') as HTMLDivElement;
    expect(closingRegion.getAttribute('aria-hidden')).toBe('true');
    expect(closingRegion.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(heading);
    flushFrames();
    expect(closingRegion.style.height).toBe('0px');
    expect(closingRegion.style.opacity).toBe('0');
    finishHeightTransition(closingRegion);
    expect(screen.queryByRole('button', { name: 'Pinned chat' })).toBeNull();
    expect(document.getElementById('chat-pinned-body')).toBeNull();
  });

  it('retargets measured height and safely reverses a canonical-project folder transition', () => {
    const renderNode = (expanded: boolean) => (
      <SidebarGroupNode
        id="chat-project-mandible"
        presentation="folder"
        leadingIcon={<span>F</span>}
        label="Mandible"
        count={2}
        expanded={expanded}
        onToggle={() => undefined}
      >
        <button type="button">Project chat</button>
      </SidebarGroupNode>
    );
    const view = render(renderNode(false));
    expect(document.getElementById('chat-project-mandible-body')).toBeNull();

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 0, bottom: 96, left: 0,
      width: 0, height: 96, toJSON: () => ({}),
    });
    view.rerender(renderNode(true));
    const region = document.getElementById('chat-project-mandible-body') as HTMLDivElement;
    const content = region.firstElementChild as HTMLDivElement;
    expect(region.style.height).toBe('0px');
    setScrollHeight(content, 96);
    flushFrames();
    expect(region.style.height).toBe('96px');
    expect(region.style.opacity).toBe('1');

    setScrollHeight(content, 148);
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));
    expect(region.style.height).toBe('148px');

    view.rerender(renderNode(false));
    view.rerender(renderNode(true));
    setScrollHeight(content, 172);
    flushFrames();
    expect(region.style.height).toBe('172px');
    finishHeightTransition(region);
    expect(region.style.height).toBe('auto');
    expect(screen.getByRole('button', { name: /^Mandible/ }).closest('section')?.classList)
      .toContain('sidebar-group-node--folder');
    expect(screen.getByRole('button', { name: 'Project chat' })).toBeTruthy();
  });

  it('removes collapsed content immediately when reduced motion is preferred', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery(true)));
    const renderNode = (expanded: boolean) => (
      <SidebarGroupNode id="chat-chats" presentation="category" label="Chats" expanded={expanded} onToggle={() => undefined}>
        <button type="button">Chat row</button>
      </SidebarGroupNode>
    );
    const view = render(renderNode(true));
    screen.getByRole('button', { name: 'Chat row' }).focus();
    view.rerender(renderNode(false));

    expect(document.getElementById('chat-chats-body')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chats' }));
    expect(frames.size).toBe(0);
  });
});
