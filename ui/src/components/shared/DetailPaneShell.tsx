import { createContext, type ComponentChildren, type Ref } from 'preact';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AppOperationalNoticeOutlet } from '../../app-shell';
import { FrameHeaderPortal, useFrameHeaderHost } from './FrameHeader';

type DetailPaneShellAs = 'article' | 'section' | 'div' | 'aside';
export type DetailPaneShellVariant = 'default' | 'compact';
export type DetailPanePresentation = 'main' | 'sidebar';

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
  presentation?: DetailPanePresentation;
  className?: string;
  headerClassName?: string;
  headerPrimaryClassName?: string;
  subheaderClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  headerRef?: Ref<HTMLElement>;
  bodyRef?: Ref<HTMLDivElement>;
  /** One anchored header composition. Omit for a headerless detail view. */
  header?: ComponentChildren;
  /** Explicit primary compact-header placement; embedded/modal headers remain in the pane. */
  headerPlacement?: 'pane' | 'frame';
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
  onDragOverCapture?: (event: JSX.TargetedDragEvent<HTMLElement>) => void;
  onDropCapture?: (event: JSX.TargetedDragEvent<HTMLElement>) => void;
};

export type DetailPaneOverlayContextValue = {
  host: HTMLElement | null;
  scrollOwner: HTMLElement | null;
  registerScrollOwner: (owner: HTMLElement | null) => void;
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
  presentation = 'main',
  className,
  headerClassName,
  headerPrimaryClassName,
  subheaderClassName,
  bodyClassName,
  footerClassName,
  headerRef,
  bodyRef,
  header,
  headerPlacement = 'pane',
  subheader,
  notice,
  footer,
  overlayControl,
  overlays,
  children,
  ariaBusy,
  onDragOverCapture,
  onDropCapture,
}: DetailPaneShellProps): JSX.Element {
  const headerLabelId = useId();
  const frameHeaderHost = useFrameHeaderHost(headerPlacement === 'frame' && presentation === 'main' && header != null);
  const frameHeader = Boolean(frameHeaderHost);
  const paneHeader = frameHeader ? null : header;
  const [bodyScrollOwner, setBodyScrollOwner] = useState<HTMLDivElement | null>(null);
  const [registeredScrollOwner, setRegisteredScrollOwner] = useState<HTMLElement | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const bodyScrollOwnerRef = useRef<HTMLDivElement | null>(null);
  const registeredScrollOwnerRef = useRef<HTMLElement | null>(null);
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const overlayControlRef = useRef<HTMLDivElement | null>(null);
  // Preact may replay callback refs during a descendant-driven render. DOM
  // ownership is state only when the node identity actually changes; writing
  // the same node back here otherwise queues the shell forever.
  const setBodyNode = useCallback((node: HTMLDivElement | null) => {
    if (bodyScrollOwnerRef.current === node) return;
    bodyScrollOwnerRef.current = node;
    setBodyScrollOwner(node);
    assignRef(bodyRef, node);
  }, [bodyRef]);
  const registerScrollOwner = useCallback((node: HTMLElement | null) => {
    if (registeredScrollOwnerRef.current === node) return;
    registeredScrollOwnerRef.current = node;
    setRegisteredScrollOwner(node);
  }, []);
  const setOverlayHostNode = useCallback((node: HTMLDivElement | null) => {
    if (overlayHostRef.current === node) return;
    overlayHostRef.current = node;
    setOverlayHost(node);
  }, []);
  const scrollOwner = registeredScrollOwner ?? bodyScrollOwner;
  const overlayContext = useMemo(() => ({
    host: overlayHost,
    scrollOwner,
    registerScrollOwner,
  }), [overlayHost, registerScrollOwner, scrollOwner]);

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
    const bodyViewport = bodyScrollOwnerRef.current;
    if (!overlayControl || !shellRef.current || !overlayControlRef.current || !scrollOwner || !bodyViewport) {
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
          bodyViewport.getBoundingClientRect(),
        );
        shellRef.current.style.setProperty('--detail-pane-overlay-control-scroll-space', `${scrollSpace}px`);
      } else {
        shellRef.current.style.removeProperty('--detail-pane-overlay-control-scroll-space');
      }
    };
    updateGeometry();
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(overlayControlRef.current);
    observer.observe(bodyViewport);
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
    <>
    {frameHeaderHost ? <FrameHeaderPortal host={frameHeaderHost} headerRef={headerRef as Ref<HTMLDivElement>} labelId={headerLabelId}>{header}</FrameHeaderPortal> : null}
    <DetailPaneOverlayContext.Provider value={overlayContext}>
      <Element
        className={classNames(
          'detail-pane-shell',
          variant === 'compact' ? 'detail-pane-shell--compact' : undefined,
          `detail-pane-shell--${presentation}`,
          footer?.mode === 'overlay' ? 'detail-pane-shell--overlay-footer' : undefined,
          overlayControl ? 'detail-pane-shell--overlay-control' : undefined,
          className,
        )}
        ref={(node: HTMLElement | null) => { shellRef.current = node; }}
        data-app-surface={presentation === 'main' ? 'main' : undefined}
        data-detail-pane-presentation={presentation}
        aria-labelledby={headerPlacement === 'frame' && header != null ? headerLabelId : undefined}
        aria-busy={ariaBusy === undefined ? undefined : ariaBusy ? 'true' : 'false'}
        onDragOverCapture={onDragOverCapture}
        onDropCapture={onDropCapture}
      >
        {(paneHeader !== undefined && paneHeader !== null) || (subheader !== undefined && subheader !== null) ? (
          <header
            className={classNames('detail-pane-shell__header', headerClassName)}
            data-detail-pane-slot="header"
            ref={headerRef}
          >
            {paneHeader !== undefined && paneHeader !== null ? (
              <div id={headerPlacement === 'frame' ? headerLabelId : undefined} className={classNames('detail-pane-shell__header-primary', headerPrimaryClassName)}>
                {paneHeader}
              </div>
            ) : null}
            {subheader !== undefined && subheader !== null ? (
              <div className={classNames('detail-pane-shell__subheader', subheaderClassName)}>
                {subheader}
              </div>
            ) : null}
          </header>
        ) : null}
        <AppOperationalNoticeOutlet
          className="detail-pane-shell__notice"
          detailPaneSlot
          registerAsMain={presentation === 'main'}
        >
          {notice}
        </AppOperationalNoticeOutlet>
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
          ref={setOverlayHostNode}
        />
        {overlays}
      </Element>
    </DetailPaneOverlayContext.Provider>
    </>
  );
}
