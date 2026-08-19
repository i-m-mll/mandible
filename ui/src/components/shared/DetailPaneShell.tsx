import type { ComponentChildren, Ref } from 'preact';

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

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
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
  return (
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
        ref={bodyRef}
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
      {overlays}
    </Element>
  );
}
