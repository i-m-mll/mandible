import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { DetailPaneOverlayContext } from './DetailPaneShell';

export type DetailPaneModalEmbeddedFallback = {
  scrollOwnerRef?: { current: HTMLElement | null };
  excludeAboveRef?: { current: HTMLElement | null };
  scrollOwnerSelector?: string | string[];
};

export type DetailPaneModalProps = {
  open: boolean;
  onClose: () => void;
  titleId: string;
  title: string;
  closeLabel: string;
  excludeAboveRef?: { current: HTMLElement | null };
  scrollOwnerSelector?: string | string[];
  embeddedFallback?: DetailPaneModalEmbeddedFallback;
  scrollLockClassName?: string;
  className?: string;
  panelClassName?: string;
  children: ComponentChildren;
};

type PaneBounds = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export function DetailPaneModal({
  open,
  onClose,
  titleId,
  title,
  closeLabel,
  excludeAboveRef,
  scrollOwnerSelector,
  embeddedFallback,
  scrollLockClassName,
  className = '',
  panelClassName = '',
  children,
}: DetailPaneModalProps): JSX.Element | null {
  const paneContext = useContext(DetailPaneOverlayContext);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [bounds, setBoundsState] = useState<PaneBounds | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const contextOwner = paneContext?.scrollOwner ?? null;
  const fallbackExcluded = embeddedFallback?.excludeAboveRef?.current ?? excludeAboveRef?.current ?? null;
  const fallbackSelector = embeddedFallback?.scrollOwnerSelector ?? scrollOwnerSelector;
  const fallbackOwner = embeddedFallback?.scrollOwnerRef?.current
    ?? (fallbackExcluded && fallbackSelector
      ? findScrollOwner(fallbackExcluded, fallbackSelector)
      : null);
  const scrollOwner = contextOwner ?? fallbackOwner;
  const excluded = contextOwner ? null : fallbackExcluded;

  useLayoutEffect(() => {
    if (!open) return undefined;
    if (!scrollOwner) {
      setBoundsState(null);
      return undefined;
    }

    const originalScrollTop = scrollOwner.scrollTop;

    const updateBounds = () => {
      const ownerRect = scrollOwner.getBoundingClientRect();
      const excludedRect = excluded?.getBoundingClientRect();
      const top = excludedRect
        ? Math.min(ownerRect.bottom, Math.max(ownerRect.top, excludedRect.bottom))
        : ownerRect.top;
      setModalBounds({
        top: Math.round(top),
        right: Math.round(Math.max(0, window.innerWidth - ownerRect.right)),
        bottom: Math.round(Math.max(0, window.innerHeight - ownerRect.bottom)),
        left: Math.round(Math.max(0, ownerRect.left)),
      });
    };

    const setModalBounds = (next: PaneBounds) => {
      setBoundsState((current) => {
        if (
          current &&
          current.top === next.top &&
          current.right === next.right &&
          current.bottom === next.bottom &&
          current.left === next.left
        ) {
          return current;
        }
        return next;
      });
    };

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel || panel.contains(event.target as Node)) return;
      onCloseRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    const preserveScroll = () => {
      if (scrollOwner.scrollTop !== originalScrollTop) {
        scrollOwner.scrollTop = originalScrollTop;
      }
    };

    updateBounds();
    scrollOwner.classList.add('detail-pane-shell__body--overlay-open');
    if (scrollLockClassName) scrollOwner.classList.add(scrollLockClassName);
    scrollOwner.scrollTop = originalScrollTop;

    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, true);
    scrollOwner.addEventListener('scroll', preserveScroll);

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, true);
      scrollOwner.removeEventListener('scroll', preserveScroll);
      scrollOwner.classList.remove('detail-pane-shell__body--overlay-open');
      if (scrollLockClassName) scrollOwner.classList.remove(scrollLockClassName);
      scrollOwner.scrollTop = originalScrollTop;
    };
  }, [open, scrollOwner, excluded, scrollLockClassName]);

  if (!open || !scrollOwner) return null;

  const style = bounds
    ? {
        '--detail-pane-modal-top': `${bounds.top}px`,
        '--detail-pane-modal-right': `${bounds.right}px`,
        '--detail-pane-modal-bottom': `${bounds.bottom}px`,
        '--detail-pane-modal-left': `${bounds.left}px`,
      } as JSX.CSSProperties
    : undefined;

  const modal = (
    <div
      className={`detail-pane-modal${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={style}
    >
      <div className={`detail-pane-modal__panel${panelClassName ? ` ${panelClassName}` : ''}`} ref={panelRef}>
        <div className="detail-pane-modal__header">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="detail-pane-modal__close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  return paneContext?.host ? createPortal(modal, paneContext.host) : modal;
}

function findScrollOwner(excluded: HTMLElement, selectors: string | string[]): HTMLElement | null {
  for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
    const owner = excluded.closest<HTMLElement>(selector);
    if (owner) return owner;
  }
  return null;
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
