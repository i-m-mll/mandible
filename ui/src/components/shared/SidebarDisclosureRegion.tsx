import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

type SidebarDisclosureRegionProps = {
  id: string;
  controllerId: string;
  expanded: boolean;
  children: ComponentChildren;
  contentAs?: 'div' | 'ul';
  className?: string;
  contentClassName?: string;
  contentAttributes?: { 'data-sidebar-reorder-list': string };
};

const FALLBACK_TRANSITION_MS = 240;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return window.setTimeout(() => callback(performance.now()), 0);
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
}

/** One motion and focus-safety contract for foldable sidebar content regions. */
export function SidebarDisclosureRegion({
  id,
  controllerId,
  expanded,
  children,
  contentAs = 'div',
  className = '',
  contentClassName = '',
  contentAttributes,
}: SidebarDisclosureRegionProps): JSX.Element | null {
  const reducedMotion = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(expanded);
  const regionRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement | HTMLUListElement>(null);
  const frameRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const previousExpandedRef = useRef(expanded);
  const freshOpenRef = useRef(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const clearPending = (): void => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current);
      frameRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  useLayoutEffect(() => {
    if (expanded && !mounted) {
      freshOpenRef.current = true;
      setMounted(true);
      return;
    }

    const region = regionRef.current;
    const content = contentRef.current;
    if (!mounted || !region || !content) return;

    if (!expanded && region.contains(document.activeElement)) {
      document.getElementById(controllerId)?.focus();
    }

    clearPending();
    if (reducedMotion) {
      region.style.height = expanded ? 'auto' : '0px';
      region.style.opacity = expanded ? '1' : '0';
      previousExpandedRef.current = expanded;
      freshOpenRef.current = false;
      if (!expanded) setMounted(false);
      return;
    }

    if (previousExpandedRef.current === expanded) return;
    previousExpandedRef.current = expanded;

    const freshOpen = expanded && freshOpenRef.current;
    freshOpenRef.current = false;
    const renderedHeight = freshOpen ? 0 : region.getBoundingClientRect().height;
    region.style.height = `${renderedHeight || (expanded ? 0 : content.scrollHeight)}px`;
    region.style.opacity = expanded ? '0' : '1';
    void region.offsetHeight;

    frameRef.current = requestFrame(() => {
      frameRef.current = null;
      const liveRegion = regionRef.current;
      const liveContent = contentRef.current;
      if (!liveRegion || !liveContent || expandedRef.current !== expanded) return;
      liveRegion.style.height = expanded ? `${liveContent.scrollHeight}px` : '0px';
      liveRegion.style.opacity = expanded ? '1' : '0';
      if (!expanded) {
        closeTimerRef.current = window.setTimeout(() => {
          closeTimerRef.current = null;
          if (!expandedRef.current) setMounted(false);
        }, FALLBACK_TRANSITION_MS);
      }
    });
  }, [controllerId, expanded, mounted, reducedMotion]);

  useEffect(() => () => clearPending(), []);

  useEffect(() => {
    if (!mounted || typeof ResizeObserver === 'undefined') return;
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const region = regionRef.current;
      const liveContent = contentRef.current;
      if (!region || !liveContent || !expandedRef.current || region.style.height === 'auto') return;
      region.style.height = `${liveContent.scrollHeight}px`;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [mounted]);

  if (!mounted) return null;

  const Content = contentAs;
  return (
    <div
      ref={regionRef}
      id={id}
      className={`sidebar-disclosure-region${className ? ` ${className}` : ''}`}
      aria-hidden={expanded ? undefined : true}
      inert={expanded ? undefined : true}
      onTransitionEnd={(event) => {
        if (event.currentTarget !== event.target || event.propertyName !== 'height') return;
        if (!expandedRef.current) {
          clearPending();
          setMounted(false);
        } else {
          event.currentTarget.style.height = 'auto';
          event.currentTarget.style.opacity = '1';
        }
      }}
    >
      <Content ref={contentRef as never} className={contentClassName} {...contentAttributes}>{children}</Content>
    </div>
  );
}
