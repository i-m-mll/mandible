import { createContext, type ComponentChildren, type Ref } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';

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
  overlays?: ComponentChildren;
  children: ComponentChildren;
  ariaBusy?: boolean;
};

export type DetailPaneOverlayContextValue = {
  host: HTMLElement | null;
  scrollOwner: HTMLElement | null;
};

export const DetailPaneOverlayContext = createContext<DetailPaneOverlayContextValue | null>(null);

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
  overlays,
  children,
  ariaBusy,
}: DetailPaneShellProps): JSX.Element {
  const [scrollOwner, setScrollOwner] = useState<HTMLDivElement | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const setBodyNode = useCallback((node: HTMLDivElement | null) => {
    setScrollOwner(node);
    assignRef(bodyRef, node);
  }, [bodyRef]);
  const overlayContext = useMemo(() => ({
    host: overlayHost,
    scrollOwner,
  }), [overlayHost, scrollOwner]);

  return (
    <DetailPaneOverlayContext.Provider value={overlayContext}>
      <Element
        className={classNames(
          'detail-pane-shell',
          variant === 'compact' ? 'detail-pane-shell--compact' : undefined,
          className,
        )}
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
          >
            {footer.content}
          </footer>
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
