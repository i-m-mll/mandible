import type { ComponentChildren } from 'preact';
import { CopyRefButton, DetailHeaderIdentity } from './DetailHeaderIdentity';

export type DetailPaneHeaderVariant = 'standard' | 'compact' | 'versioned';

export type DetailPaneHeaderIdentity = {
  /** Human entity kind or owning context, for example `Issue` or `mandible`. */
  entityLabel?: string;
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

type DetailPaneHeaderBaseProps = {
  identity: DetailPaneHeaderIdentity;
  title: ComponentChildren;
  titleId?: string;
  titleTooltip?: string;
  actions?: ComponentChildren;
  actionsLabel?: string;
  selector?: DetailPaneHeaderSelector;
  className?: string;
};

type StandardOrCompactDetailPaneHeaderProps = DetailPaneHeaderBaseProps & {
  variant: 'standard' | 'compact';
  status?: ComponentChildren;
  state?: never;
  secondaryMetadata?: ComponentChildren;
};

type VersionedDetailPaneHeaderProps = DetailPaneHeaderBaseProps & {
  variant: 'versioned';
  /** Subdued logical/version state, for example `Latest`. */
  state?: ComponentChildren;
  status?: never;
  /** Versioned headers have exactly two rows. */
  secondaryMetadata?: never;
};

export type DetailPaneHeaderProps =
  | StandardOrCompactDetailPaneHeaderProps
  | VersionedDetailPaneHeaderProps;

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
  state,
  actions,
  actionsLabel = 'Detail actions',
  selector,
  secondaryMetadata,
  className,
}: DetailPaneHeaderProps): JSX.Element {
  const toplineState = variant === 'versioned' ? state : status;
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
            copyLabel={
              identity.copyLabel
              ?? (identity.entityLabel
                ? `Copy ${identity.entityLabel} reference`
                : 'Copy full canonical reference')
            }
          />
          {(toplineState !== undefined && toplineState !== null || selector) && (
            <div className="detail-pane-header__topline-controls">
              {toplineState !== undefined && toplineState !== null && (
                <div
                  className={variant === 'versioned'
                    ? 'detail-pane-header__state'
                    : 'detail-pane-header__status'}
                >
                  {toplineState}
                </div>
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
