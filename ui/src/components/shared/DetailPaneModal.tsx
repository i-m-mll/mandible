import { useEffect, useRef, useState } from 'preact/hooks';

export type DetailPaneModalProps = {
  open: boolean;
  onClose: () => void;
  titleId: string;
  title: string;
  closeLabel: string;
  excludeAboveRef: { current: HTMLElement | null };
  scrollOwnerSelector: string;
  scrollLockClassName?: string;
  className?: string;
  panelClassName?: string;
  children: JSX.Element | JSX.Element[];
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
  scrollLockClassName,
  className = '',
  panelClassName = '',
  children,
}: DetailPaneModalProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [bounds, setBoundsState] = useState<PaneBounds | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const excluded = excludeAboveRef.current;
    const scrollOwner = excluded?.closest<HTMLElement>(scrollOwnerSelector);
    if (!excluded || !scrollOwner) {
      setBoundsState(null);
      return undefined;
    }

    const originalScrollTop = scrollOwner.scrollTop;

    const updateBounds = () => {
      const excludedRect = excluded.getBoundingClientRect();
      const ownerRect = scrollOwner.getBoundingClientRect();
      const top = Math.min(ownerRect.bottom, Math.max(ownerRect.top, excludedRect.bottom));
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
      if (scrollLockClassName) scrollOwner.classList.remove(scrollLockClassName);
      scrollOwner.scrollTop = originalScrollTop;
    };
  }, [open, excludeAboveRef, scrollOwnerSelector, scrollLockClassName]);

  if (!open) return null;

  const style = bounds
    ? {
        '--detail-pane-modal-top': `${bounds.top}px`,
        '--detail-pane-modal-right': `${bounds.right}px`,
        '--detail-pane-modal-bottom': `${bounds.bottom}px`,
        '--detail-pane-modal-left': `${bounds.left}px`,
      } as JSX.CSSProperties
    : undefined;

  return (
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
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m18 6-12 12" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
