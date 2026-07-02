import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';

export type ShelfItemStatus = 'active' | 'finished' | 'waiting' | 'error';

export type ShelfItem = {
  id: string;
  icon: string;
  label: string;
  status: ShelfItemStatus;
  meta: string[];
  onActivate: () => void;
};

export type ShelfProps = {
  conversationId: string;
  title: string;
  items: ShelfItem[];
  onEscape?: () => void;
};

function storageKey(conversationId: string): string {
  return `mandible:chat-shelf-expanded:${conversationId}`;
}

function readExpanded(conversationId: string): boolean {
  try {
    const value = window.localStorage.getItem(storageKey(conversationId));
    return value === null ? true : value === 'true';
  } catch {
    return true;
  }
}

function writeExpanded(conversationId: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(storageKey(conversationId), String(expanded));
  } catch {
    // Ignore unavailable storage.
  }
}

export function Shelf({ conversationId, title, items, onEscape }: ShelfProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(() => readExpanded(conversationId));
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setExpanded(readExpanded(conversationId));
    setActiveIndex(0);
  }, [conversationId]);

  useEffect(() => {
    if (activeIndex >= items.length) {
      setActiveIndex(Math.max(0, items.length - 1));
    }
  }, [activeIndex, items.length]);

  const itemCountLabel = useMemo(() => `${title} (${items.length})`, [items.length, title]);

  if (items.length === 0) {
    return null;
  }

  const setExpandedAndStore = (next: boolean): void => {
    setExpanded(next);
    writeExpanded(conversationId, next);
  };

  const focusRow = (index: number): void => {
    const bounded = Math.max(0, Math.min(items.length - 1, index));
    setActiveIndex(bounded);
    rowRefs.current[bounded]?.focus();
  };

  const handleRowKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusRow(index + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusRow(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(items.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      items[index].onActivate();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onEscape?.();
    }
  };

  return (
    <section className="chat-shelf" aria-label={title}>
      <button
        type="button"
        className="chat-shelf__header"
        onClick={() => setExpandedAndStore(!expanded)}
        aria-expanded={expanded}
      >
        <span className="chat-shelf__chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="chat-shelf__title">{itemCountLabel}</span>
      </button>
      {expanded && (
        <div className="chat-shelf__rows">
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => { rowRefs.current[index] = node; }}
              type="button"
              className={`chat-shelf-row chat-shelf-row--${item.status}`}
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)}
              onClick={item.onActivate}
              onKeyDown={(event) => handleRowKeyDown(event, index)}
            >
              <span className="chat-shelf-row__icon" aria-hidden="true">{item.icon}</span>
              <span className="chat-shelf-row__main">
                <span className="chat-shelf-row__label">{item.label}</span>
                <span className="chat-shelf-row__meta">
                  {item.meta.map((part, metaIndex) => <span key={`${item.id}:${metaIndex}`}>{part}</span>)}
                </span>
              </span>
              <span className="chat-shelf-row__status">{item.status}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
