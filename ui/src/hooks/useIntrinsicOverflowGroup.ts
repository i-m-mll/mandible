import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export function useIntrinsicOverflowGroup(enabled: boolean, structureKey: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fixedRef = useRef<HTMLSpanElement>(null);
  const [overflowed, setOverflowed] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) {
      setOverflowed(false);
      return undefined;
    }

    const container = containerRef.current;
    const content = contentRef.current;
    const fixed = fixedRef.current;
    if (!container || !content || !fixed) return undefined;

    const gap = (element: Element) => {
      const styles = getComputedStyle(element);
      return Number.parseFloat(styles.columnGap || styles.gap) || 0;
    };
    const intrinsicWidth = (element: Element) => Math.max(
      element.getBoundingClientRect().width,
      element instanceof HTMLElement ? element.scrollWidth : 0,
    );
    const sumWidths = (elements: Element[], itemGap: number) => elements.reduce(
      (width, element) => width + intrinsicWidth(element),
      Math.max(0, elements.length - 1) * itemGap,
    );
    const measure = () => {
      // Measure the controls themselves, not the flex row that contains them.
      // The row's scrollWidth includes its allocated free space, so combining it
      // with the fixed actions creates a feedback loop where any rerender can
      // falsely force the controls into overflow despite unchanged geometry.
      const contentWidth = sumWidths(Array.from(content.children), gap(content));
      const fixedChildren = Array.from(fixed.children).filter((child) => !child.hasAttribute('data-overflow-trigger'));
      const requiredWidth = contentWidth + sumWidths(fixedChildren, gap(fixed)) + gap(container);
      setOverflowed(requiredWidth > container.getBoundingClientRect().width + 0.5);
    };

    measure();
    const frame = requestAnimationFrame(measure);
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (container.parentElement) observer.observe(container.parentElement);
    observer.observe(content);
    Array.from(content.querySelectorAll('*')).forEach((element) => observer.observe(element));
    Array.from(fixed.children).forEach((element) => observer.observe(element));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [enabled, structureKey]);

  return { containerRef, contentRef, fixedRef, overflowed };
}
