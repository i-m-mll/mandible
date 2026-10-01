import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export function OverflowFade({ children, className = '', lines = 10, direction = 'vertical' }: {
  children: ComponentChildren;
  className?: string;
  lines?: number;
  direction?: 'vertical' | 'horizontal';
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasAbove, setHasAbove] = useState(false);
  const [hasBelow, setHasBelow] = useState(false);
  const refresh = useCallback(() => {
    const node = scrollRef.current;
    setHasAbove(Boolean(node && (direction === 'horizontal' ? node.scrollLeft > 1 : node.scrollTop > 1)));
    setHasBelow(Boolean(node && (direction === 'horizontal'
      ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1
      : node.scrollTop + node.clientHeight < node.scrollHeight - 1)));
  }, [direction]);

  useEffect(() => {
    refresh();
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(refresh);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [children, refresh]);

  return (
    <div
      className={`overflow-fade${direction === 'horizontal' ? ' overflow-fade--horizontal' : ''}${hasAbove ? ' overflow-fade--above' : ''}${hasBelow ? ' overflow-fade--below' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--overflow-fade-lines': lines } as Record<string, number>}
    >
      <div ref={scrollRef} className="overflow-fade__scroll" onScroll={refresh}>{children}</div>
    </div>
  );
}
