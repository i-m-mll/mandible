import type { ComponentChildren } from 'preact';
import { CopyRefButton, DetailHeaderIdentity } from './DetailHeaderIdentity';

export type DetailPaneHeaderVariant = 'standard' | 'compact';

export type DetailPaneHeaderIdentity = {
  /** Human entity kind or owning context, for example `Issue` or `mandible`. */
  entityLabel: string;
  /** Ambiguity-safe short reference rendered in the header. Never pass the full ID here. */
  displayRef: string;
  /** Full canonical reference copied by the identity control. */
  canonicalRef: string;
  copyLabel?: string;
};

export type DetailPaneHeaderSelector = {
  /** Accessible name for the selection and selected-reference copy controls. */
  label: string;
  control: ComponentChildren;
  /** Full canonical reference for the currently selected item. */
  selectedCanonicalRef: string;
  copyLabel?: string;
};

export type DetailPaneHeaderProps = {
  variant: DetailPaneHeaderVariant;
  identity: DetailPaneHeaderIdentity;
  title: ComponentChildren;
  titleId?: string;
  titleTooltip?: string;
  status?: ComponentChildren;
  actions?: ComponentChildren;
  actionsLabel?: string;
  selector?: DetailPaneHeaderSelector;
  secondaryMetadata?: ComponentChildren;
  className?: string;
};

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/**
 * Canonical header composition for DetailPaneShell. It owns identity, title,
 * status, selector, metadata, and actions so consumers only supply meaning.
 */
export function DetailPaneHeader({
  variant,
  identity,
  title,
  titleId,
  titleTooltip,
  status,
  actions,
  actionsLabel = 'Detail actions',
  selector,
  secondaryMetadata,
  className,
}: DetailPaneHeaderProps): JSX.Element {
  return (
    <div
      className={classNames(
        'detail-pane-header',
        `detail-pane-header--${variant}`,
        className,
      )}
      data-detail-pane-header-variant={variant}
    >
      <div className="detail-pane-header__main">
        <div className="detail-pane-header__topline">
          <DetailHeaderIdentity
            className="detail-pane-header__identity"
            contextClassName="detail-pane-header__entity"
            shortIdClassName="detail-pane-header__display-ref"
            contextLabel={identity.entityLabel}
            shortId={identity.displayRef}
            copyValue={identity.canonicalRef}
            copyLabel={identity.copyLabel ?? `Copy ${identity.entityLabel} reference`}
          />
          {status !== undefined && status !== null && (
            <div className="detail-pane-header__status">{status}</div>
          )}
          {selector && (
            <div
              className="detail-pane-header__selector"
              role="group"
              aria-label={selector.label}
            >
              {selector.control}
              <CopyRefButton
                value={selector.selectedCanonicalRef}
                label={
                  selector.copyLabel
                  ?? `Copy selected ${selector.label.toLowerCase()} reference`
                }
              />
            </div>
          )}
        </div>
        <div className="detail-pane-header__title-row">
          <h2 id={titleId} className="detail-pane-header__title" title={titleTooltip}>
            {title}
          </h2>
          {actions !== undefined && actions !== null && (
            <div
              className="detail-pane-header__actions"
              role="group"
              aria-label={actionsLabel}
            >
              {actions}
            </div>
          )}
        </div>
        {secondaryMetadata !== undefined && secondaryMetadata !== null && (
          <div className="detail-pane-header__metadata">{secondaryMetadata}</div>
        )}
      </div>
    </div>
  );
}
