import type { ComponentChildren, Ref } from 'preact';

type DetailPaneShellAs = 'article' | 'section' | 'div';
export type DetailPaneShellVariant = 'default' | 'compact';

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
  footer?: ComponentChildren;
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
      <header className={classNames('detail-pane-shell__header', headerClassName)} ref={headerRef}>
        <div className={classNames('detail-pane-shell__header-primary', headerPrimaryClassName)}>
          {header}
        </div>
        {subheader && (
          <div className={classNames('detail-pane-shell__subheader', subheaderClassName)}>
            {subheader}
          </div>
        )}
      </header>
      <div className={classNames('detail-pane-shell__body', bodyClassName)} ref={bodyRef}>
        {children}
      </div>
      {footer !== undefined && footer !== null && (
        <footer className={classNames('detail-pane-shell__footer', footerClassName)}>
          {footer}
        </footer>
      )}
      {overlays}
    </Element>
  );
}
