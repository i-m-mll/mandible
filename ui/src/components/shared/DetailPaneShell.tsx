import { createContext, type ComponentChildren, type Ref } from 'preact';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

type DetailPaneShellAs = 'article' | 'section' | 'div' | 'aside';
export type DetailPaneShellVariant = 'default' | 'compact';

/**
 * Content for the shell's one anchored footer slot. `content` may be a
 * fragment or array when several canonical controls belong in the footer;
 * the shell still renders exactly one outer footer boundary.
 */
export type DetailPaneShellFooter = {
  content: ComponentChildren;
  ariaLabel?: string;
  /** Overlay keeps the body as the full-height scroll owner and masks beneath the footer. */
  mode?: 'anchored' | 'overlay';
};

export type DetailPaneShellProps = {
  as?: DetailPaneShellAs;
  variant?: DetailPaneShellVariant;
  className?: string;
  headerClassName?: string;
  headerPrimaryClassName?: string;
  subheaderClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  headerRef?: Ref<HTMLElement>;
  bodyRef?: Ref<HTMLDivElement>;
  /** One anchored header composition. Prefer DetailPaneHeader for data views. */
  header: ComponentChildren;
  subheader?: ComponentChildren;
  /** One anchored notice boundary between the header region and scrolling body. */
  notice?: ComponentChildren;
  /** Selection-driven anchored content. Omit or pass null to hide the slot. */
  footer?: DetailPaneShellFooter | null;
  /** A floating control above the scrolling body, such as the Chat composer. */
  overlayControl?: ComponentChildren;
  overlays?: ComponentChildren;
  children: ComponentChildren;
  ariaBusy?: boolean;
};

export type DetailPaneOverlayContextValue = {
  host: HTMLElement | null;
  scrollOwner: HTMLElement | null;
};

export const DetailPaneOverlayContext = createContext<DetailPaneOverlayContextValue | null>(null);

type VerticalRect = Pick<DOMRect, 'bottom' | 'height'>;

function overlayControlScrollSpace(
  controlRect: VerticalRect,
  viewportRect: Pick<DOMRect, 'bottom'>,
): number {
  const bottomGap = Math.max(0, viewportRect.bottom - controlRect.bottom);
  return Math.max(0, controlRect.height) + (2 * bottomGap);
}

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export function DetailPaneShell({
  as: Element = 'article',
  variant = 'default',
  className,
  headerClassName,
  headerPrimaryClassName,
  subheaderClassName,
  bodyClassName,
  footerClassName,
  headerRef,
  bodyRef,
  header,
  subheader,
  notice,
  footer,
  overlayControl,
  overlays,
  children,
  ariaBusy,
}: DetailPaneShellProps): JSX.Element {
  const [scrollOwner, setScrollOwner] = useState<HTMLDivElement | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const overlayControlRef = useRef<HTMLDivElement | null>(null);
  const setBodyNode = useCallback((node: HTMLDivElement | null) => {
    setScrollOwner(node);
    assignRef(bodyRef, node);
  }, [bodyRef]);
  const overlayContext = useMemo(() => ({
    host: overlayHost,
    scrollOwner,
  }), [overlayHost, scrollOwner]);

  useLayoutEffect(() => {
    if (footer?.mode !== 'overlay' || !shellRef.current || !footerRef.current || !scrollOwner) return undefined;
    const updateGeometry = () => {
      if (!shellRef.current || !footerRef.current) return;
      shellRef.current.style.setProperty('--detail-pane-overlay-footer-height', `${footerRef.current.offsetHeight}px`);
      shellRef.current.style.setProperty('--detail-pane-scrollbar-width', `${Math.max(0, scrollOwner.offsetWidth - scrollOwner.clientWidth)}px`);
    };
    updateGeometry();
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(footerRef.current);
    observer.observe(scrollOwner);
    return () => observer.disconnect();
  }, [footer?.mode, scrollOwner]);

  useLayoutEffect(() => {
    if (!overlayControl || !shellRef.current || !overlayControlRef.current || !scrollOwner) {
      shellRef.current?.style.removeProperty('--detail-pane-overlay-control-scroll-space');
      return undefined;
    }
    const updateGeometry = () => {
      if (!shellRef.current || !overlayControlRef.current) return;
      const visualControl = overlayControlRef.current.querySelector<HTMLElement>('[data-detail-pane-overlay-visual]');
      shellRef.current.style.setProperty('--detail-pane-overlay-control-height', `${overlayControlRef.current.offsetHeight}px`);
      shellRef.current.style.setProperty('--detail-pane-scrollbar-width', `${Math.max(0, scrollOwner.offsetWidth - scrollOwner.clientWidth)}px`);
      if (visualControl) {
        const scrollSpace = overlayControlScrollSpace(
          visualControl.getBoundingClientRect(),
          scrollOwner.getBoundingClientRect(),
        );
        shellRef.current.style.setProperty('--detail-pane-overlay-control-scroll-space', `${scrollSpace}px`);
      } else {
        shellRef.current.style.removeProperty('--detail-pane-overlay-control-scroll-space');
      }
    };
    updateGeometry();
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(overlayControlRef.current);
    observer.observe(scrollOwner);
    const visualControl = overlayControlRef.current.querySelector<HTMLElement>('[data-detail-pane-overlay-visual]');
    if (visualControl) observer.observe(visualControl);
    window.addEventListener('resize', updateGeometry);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateGeometry);
    };
  }, [overlayControl, scrollOwner]);

  return (
    <DetailPaneOverlayContext.Provider value={overlayContext}>
      <Element
        className={classNames(
          'detail-pane-shell',
          variant === 'compact' ? 'detail-pane-shell--compact' : undefined,
          footer?.mode === 'overlay' ? 'detail-pane-shell--overlay-footer' : undefined,
          overlayControl ? 'detail-pane-shell--overlay-control' : undefined,
          className,
        )}
        ref={(node: HTMLElement | null) => { shellRef.current = node; }}
        data-app-surface="main"
        aria-busy={ariaBusy === undefined ? undefined : ariaBusy ? 'true' : 'false'}
      >
        <header
          className={classNames('detail-pane-shell__header', headerClassName)}
          data-detail-pane-slot="header"
          ref={headerRef}
        >
          <div className={classNames('detail-pane-shell__header-primary', headerPrimaryClassName)}>
            {header}
          </div>
          {subheader && (
            <div className={classNames('detail-pane-shell__subheader', subheaderClassName)}>
              {subheader}
            </div>
          )}
        </header>
        {notice !== undefined && notice !== null && (
          <div className="detail-pane-shell__notice" data-detail-pane-slot="notice">
            {notice}
          </div>
        )}
        <div
          className={classNames('detail-pane-shell__body', bodyClassName)}
          data-detail-pane-slot="body"
          ref={setBodyNode}
        >
          {children}
        </div>
        {footer !== undefined && footer !== null && (
          <footer
            className={classNames('detail-pane-shell__footer', footerClassName)}
            data-detail-pane-slot="footer"
            aria-label={footer.ariaLabel}
            ref={(node: HTMLElement | null) => { footerRef.current = node; }}
          >
            {footer.content}
          </footer>
        )}
        {overlayControl !== undefined && overlayControl !== null && (
          <div
            className="detail-pane-shell__overlay-control"
            data-detail-pane-slot="overlay-control"
            ref={overlayControlRef}
          >
            {overlayControl}
          </div>
        )}
        <div
          className="detail-pane-shell__overlay-host"
          data-detail-pane-slot="overlay-host"
          data-detail-pane-overlay-host
          ref={setOverlayHost}
        />
        {overlays}
      </Element>
    </DetailPaneOverlayContext.Provider>
  );
}
