import { useIsFrameHeader } from './FrameHeader';
import { appTip } from './AppHoverTips';
import type { ComponentChildren } from 'preact';
import { shortIdentityRef } from '../../identity-refs';
import { CopyRefButton, DetailHeaderIdentity } from './DetailHeaderIdentity';
import type { DetailPanePresentation } from './DetailPaneShell';

export type DetailPaneHeaderVariant = 'standard' | 'compact' | 'versioned';

export type DetailPaneHeaderIdentity = {
  /** Human entity kind or owning context, for example `Issue` or `mandible`. */
  entityLabel?: string;
  /** Ambiguity-safe short reference rendered in the header. Never pass the full ID here. */
  displayRef: string;
  /** Exact canonical authority retained for API and storage operations. */
  canonicalRef: string;
  /** Ordinary ambiguity-safe clipboard ref. Defaults to compacting canonicalRef. */
  copyRef?: string;
  copyLabel?: string;
};

export type DetailPaneHeaderSelector = {
  /** Accessible name for the selection and selected-reference copy controls. */
  label: string;
  /** Bare selection control; the header owns its shared wrapper and preset. */
  control: ComponentChildren;
  /** Exact canonical authority for the currently selected item. */
  selectedCanonicalRef: string;
  /** Ordinary ambiguity-safe clipboard ref. Defaults to compacting selectedCanonicalRef. */
  selectedCopyRef?: string;
  copyLabel?: string;
};

type DetailPaneHeaderBaseProps = {
  presentation?: DetailPanePresentation;
  title: ComponentChildren;
  titleId?: string;
  titleTooltip?: string;
  /** Supporting context rendered with the title without adding another header row. */
  supportingMetadata?: ComponentChildren;
  selector?: DetailPaneHeaderSelector;
  className?: string;
};

type DetailPaneHeaderActionFields = {
  actions?: ComponentChildren;
  actionsLabel?: string;
  menu?: never;
  menuLabel?: never;
  metadata?: never;
};

type StandardOrCompactDetailPaneHeaderFields = {
  status?: ComponentChildren;
  state?: never;
  secondaryMetadata?: ComponentChildren;
};

type StandardDetailPaneHeaderProps = DetailPaneHeaderBaseProps & DetailPaneHeaderActionFields & StandardOrCompactDetailPaneHeaderFields & {
  variant: 'standard';
  identity: DetailPaneHeaderIdentity;
};

type CompactDetailPaneHeaderProps = DetailPaneHeaderBaseProps & {
  variant: 'compact';
  identity?: DetailPaneHeaderIdentity;
  /** Title-adjacent overflow or context menu. */
  menu?: ComponentChildren;
  menuLabel?: string;
  /** Fixed right-aligned provider, status, pill, or supporting control region. */
  metadata?: ComponentChildren;
  /** Fixed trailing actions. The shared row always places these after metadata. */
  actions?: ComponentChildren;
  actionsLabel?: string;
  status?: never;
  state?: never;
  secondaryMetadata?: never;
};

type VersionedDetailPaneHeaderProps = DetailPaneHeaderBaseProps & DetailPaneHeaderActionFields & {
  variant: 'versioned';
  identity: DetailPaneHeaderIdentity;
  /** Subdued logical/version state, for example `Latest`. */
  state?: ComponentChildren;
  status?: never;
  /** Versioned headers have exactly two rows. */
  secondaryMetadata?: never;
};

export type DetailPaneHeaderProps =
  | StandardDetailPaneHeaderProps
  | CompactDetailPaneHeaderProps
  | VersionedDetailPaneHeaderProps;

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function renderIdentity(identity: DetailPaneHeaderIdentity): JSX.Element {
  return (
    <DetailHeaderIdentity
      className="detail-pane-header__identity"
      contextClassName="detail-pane-header__entity"
      shortIdClassName="detail-pane-header__display-ref"
      contextLabel={identity.entityLabel}
      shortId={identity.displayRef}
      copyValue={identity.copyRef ?? shortIdentityRef(identity.canonicalRef)}
      copyLabel={
        identity.copyLabel
        ?? (identity.entityLabel
          ? `Copy ${identity.entityLabel} reference`
          : 'Copy reference')
      }
    />
  );
}

/**
 * Canonical header composition for DetailPaneShell. It owns identity, title,
 * status, selector, metadata, and actions so consumers only supply meaning.
 */
export function DetailPaneHeader({
  variant,
  presentation = 'main',
  identity,
  title,
  titleId,
  titleTooltip,
  supportingMetadata,
  status,
  state,
  actions,
  actionsLabel = 'Detail actions',
  menu,
  menuLabel = 'Detail menu',
  metadata,
  selector,
  secondaryMetadata,
  className,
}: DetailPaneHeaderProps): JSX.Element {
  const frameHeader = useIsFrameHeader();
  if (variant === 'compact') {
    return (
      <div
        className={classNames('detail-pane-header', 'detail-pane-header--compact', className)}
        data-detail-pane-header-variant="compact"
        data-detail-pane-presentation={presentation}
      >
        <div className="detail-pane-header__main">
          <div className="detail-pane-header__title-row">
            {supportingMetadata !== undefined && supportingMetadata !== null ? (
              <div className="detail-pane-header__title-block">
                <h2 id={titleId} className="detail-pane-header__title" {...(frameHeader ? appTip(titleTooltip) : { title: titleTooltip })}>
                  {title}
                </h2>
                <div className="detail-pane-header__supporting-metadata">{supportingMetadata}</div>
              </div>
            ) : (
              <h2 id={titleId} className="detail-pane-header__title" {...(frameHeader ? appTip(titleTooltip) : { title: titleTooltip })}>
                {title}
              </h2>
            )}
            {menu !== undefined && menu !== null && (
              <div className="detail-pane-header__menu" role="group" aria-label={menuLabel}>
                {menu}
              </div>
            )}
          </div>
          {(identity || (metadata !== undefined && metadata !== null) || selector) && (
            <div className="detail-pane-header__compact-metadata">
              {identity && renderIdentity(identity)}
              {metadata !== undefined && metadata !== null && metadata}
              {selector && (
                <div className="detail-pane-header__selector" role="group" aria-label={selector.label}>
                  <div className="detail-pane-header__selector-control">{selector.control}</div>
                  <CopyRefButton
                    value={selector.selectedCopyRef ?? shortIdentityRef(selector.selectedCanonicalRef)}
                    label={selector.copyLabel ?? `Copy selected ${selector.label.toLowerCase()} reference`}
                  />
                </div>
              )}
            </div>
          )}
          {(actions !== undefined && actions !== null) ? (
            <div
              className="detail-pane-header__actions"
              role="group"
              aria-label={actionsLabel}
            >
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const toplineState = variant === 'versioned' ? state : status;
  return (
    <div
      className={classNames(
        'detail-pane-header',
        `detail-pane-header--${variant}`,
        className,
      )}
      data-detail-pane-header-variant={variant}
      data-detail-pane-presentation={presentation}
    >
      <div className="detail-pane-header__main">
        {(identity || (toplineState !== undefined && toplineState !== null) || selector) && (
          <div className="detail-pane-header__topline">
            {identity && renderIdentity(identity)}
            {((toplineState !== undefined && toplineState !== null) || selector) && (
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
                    <div className="detail-pane-header__selector-control">
                      {selector.control}
                    </div>
                    <CopyRefButton
                      value={selector.selectedCopyRef ?? shortIdentityRef(selector.selectedCanonicalRef)}
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
        )}
        <div className="detail-pane-header__title-row">
          {supportingMetadata !== undefined && supportingMetadata !== null ? (
            <div className="detail-pane-header__title-block">
              <h2 id={titleId} className="detail-pane-header__title" {...(frameHeader ? appTip(titleTooltip) : { title: titleTooltip })}>
                {title}
              </h2>
              <div className="detail-pane-header__supporting-metadata">{supportingMetadata}</div>
            </div>
          ) : (
            <h2 id={titleId} className="detail-pane-header__title" {...(frameHeader ? appTip(titleTooltip) : { title: titleTooltip })}>
              {title}
            </h2>
          )}
          {actions !== undefined && actions !== null ? (
            <div
              className="detail-pane-header__actions"
              role="group"
              aria-label={actionsLabel}
            >
              {actions}
            </div>
          ) : null}
        </div>
        {secondaryMetadata !== undefined && secondaryMetadata !== null && (
          <div className="detail-pane-header__metadata">{secondaryMetadata}</div>
        )}
      </div>
    </div>
  );
}
