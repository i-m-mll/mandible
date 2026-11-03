import type { ComponentChildren } from 'preact';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';

export function OverflowFade({ children, className = '', lines = 10, direction = 'vertical', scroller }: {
  children: ComponentChildren;
  className?: string;
  lines?: number;
  direction?: 'vertical' | 'horizontal';
  scroller?: HTMLElement | null;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasAbove, setHasAbove] = useState(false);
  const [hasBelow, setHasBelow] = useState(false);
  const refresh = useCallback(() => {
    const node = scroller === undefined ? scrollRef.current : scroller;
    setHasAbove(Boolean(node && (direction === 'horizontal' ? node.scrollLeft > 1 : node.scrollTop > 1)));
    setHasBelow(Boolean(node && (direction === 'horizontal'
      ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1
      : node.scrollTop + node.clientHeight < node.scrollHeight - 1)));
  }, [direction, scroller]);

  useLayoutEffect(() => {
    refresh();
    const node = scroller === undefined ? scrollRef.current : scroller;
    if (!node) return;
    node.addEventListener('scroll', refresh, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refresh);
    const observe = () => { observer?.disconnect(); observer?.observe(node); for (const child of node.children) observer?.observe(child); refresh(); };
    observe();
    const mutation = new MutationObserver(observe); mutation.observe(node, { childList: true });
    return () => { node.removeEventListener('scroll', refresh); observer?.disconnect(); mutation.disconnect(); };
  }, [children, refresh]);

  return (
    <div
      className={`overflow-fade${direction === 'horizontal' ? ' overflow-fade--horizontal' : ''}${hasAbove ? ' overflow-fade--above' : ''}${hasBelow ? ' overflow-fade--below' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--overflow-fade-lines': lines } as Record<string, number>}
    >
      {scroller === undefined ? <div ref={scrollRef} className="overflow-fade__scroll">{children}</div> : children}
    </div>
  );
}

/** Paints only; the caller retains its native scroll box and content geometry. */
export function OverflowTopFade({ scroller, enabled = true, contentStart = 0, className = '' }: {
  scroller: HTMLElement | null;
  enabled?: boolean;
  contentStart?: number;
  className?: string;
}): JSX.Element {
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    const refresh = () => setAbove(Boolean(enabled && scroller && scroller.scrollTop > contentStart));
    refresh(); scroller?.addEventListener('scroll', refresh, { passive: true });
    return () => scroller?.removeEventListener('scroll', refresh);
  }, [scroller, enabled, contentStart]);
  return <div aria-hidden="true" className={`overflow-fade-top${above ? ' overflow-fade-top--visible' : ''}${className ? ` ${className}` : ''}`} />;
}
