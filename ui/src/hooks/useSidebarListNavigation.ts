import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';

type SidebarListNavigationOptions<T> = {
  items: readonly T[];
  getKey: (item: T) => string;
  selectedKey: string | null;
  onSelect: (item: T) => void;
};

type SidebarListItemNavigationProps = {
  ref: (element: HTMLElement | null) => void;
  tabIndex: number;
  'aria-current': 'true' | undefined;
  onKeyDown: JSX.KeyboardEventHandler<HTMLElement>;
};

export function useSidebarListNavigation<T>(
  options: SidebarListNavigationOptions<T>,
): {
  getItemNavigationProps: (item: T, index: number) => SidebarListItemNavigationProps;
} {
  const itemRefs = useRef(new Map<string, HTMLElement>());

  const getItemNavigationProps = (item: T, index: number): SidebarListItemNavigationProps => {
    const key = options.getKey(item);
    const selected = options.selectedKey === key;
    return {
      ref: (element) => {
        if (element) {
          itemRefs.current.set(key, element);
        } else {
          itemRefs.current.delete(key);
        }
      },
      tabIndex: selected || (options.selectedKey === null && index === 0) ? 0 : -1,
      'aria-current': selected ? 'true' : undefined,
      onKeyDown: (event) => {
        let nextIndex: number | null = null;
        if (event.key === 'ArrowDown') nextIndex = Math.min(index + 1, options.items.length - 1);
        if (event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0);
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = options.items.length - 1;
        if (nextIndex === null || nextIndex < 0) return;
        event.preventDefault();
        if (nextIndex === index) return;
        const nextItem = options.items[nextIndex];
        options.onSelect(nextItem);
        const nextElement = itemRefs.current.get(options.getKey(nextItem));
        nextElement?.focus({ preventScroll: true });
        nextElement?.scrollIntoView?.({ block: 'nearest' });
      },
    };
  };

  return { getItemNavigationProps };
}
