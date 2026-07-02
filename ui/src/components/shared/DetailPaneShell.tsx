import type { ComponentChildren, Ref } from 'preact';

type DetailPaneShellAs = 'article' | 'section' | 'div';

export type DetailPaneShellProps = {
  as?: DetailPaneShellAs;
  className?: string;
  headerClassName?: string;
  headerPrimaryClassName?: string;
  subheaderClassName?: string;
  bodyClassName?: string;
  headerRef?: Ref<HTMLElement>;
  bodyRef?: Ref<HTMLDivElement>;
  header: ComponentChildren;
  subheader?: ComponentChildren;
  overlays?: ComponentChildren;
  children: ComponentChildren;
  ariaBusy?: boolean;
};

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function DetailPaneShell({
  as: Element = 'article',
  className,
  headerClassName,
  headerPrimaryClassName,
  subheaderClassName,
  bodyClassName,
  headerRef,
  bodyRef,
  header,
  subheader,
  overlays,
  children,
  ariaBusy,
}: DetailPaneShellProps): JSX.Element {
  return (
    <Element
      className={classNames('detail-pane-shell', className)}
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
      {overlays}
    </Element>
  );
}
