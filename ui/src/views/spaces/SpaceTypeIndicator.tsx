import type { SpaceRenderer } from '../../api';
import './SpaceTypeIndicator.css';

export const SPACE_TYPE_LABELS: Record<SpaceRenderer, string> = {
  canvas: 'Canvas',
  document: 'Document',
  board: 'Board',
  collection: 'Collection',
};

export function isSpaceRenderer(value: unknown): value is SpaceRenderer {
  return (
    value === 'canvas' ||
    value === 'document' ||
    value === 'board' ||
    value === 'collection'
  );
}

export function spaceTypeLabel(renderer: SpaceRenderer | string): string {
  return isSpaceRenderer(renderer) ? SPACE_TYPE_LABELS[renderer] : renderer || 'Space';
}

type SpaceTypeIndicatorProps = {
  renderer: SpaceRenderer | string;
  showLabel?: boolean;
  className?: string;
  iconClassName?: string;
  labelClassName?: string;
  'data-testid'?: string;
};

function SpaceTypeGlyph({ renderer, className }: { renderer: SpaceRenderer | string; className?: string }): JSX.Element {
  const common: JSX.SVGAttributes<SVGSVGElement> = {
    className: ['space-type-indicator__icon', className].filter(Boolean).join(' '),
    viewBox: '0 0 20 20',
    width: '20',
    height: '20',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  switch (renderer) {
    case 'document':
      return (
        <svg {...common}>
          <path d="M5 2.75h6.2L15 6.55v10.7H5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M11 2.9v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M7.4 10.1h5.2M7.4 13h5.2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
        </svg>
      );
    case 'board':
      return (
        <svg {...common}>
          <path d="M3.2 4.1h13.6v11.8H3.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path d="M7.7 4.3v11.3M12.3 4.3v11.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
          <path d="M4.9 7h1.5M9.3 9.7h1.5M14 7.8h1.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
        </svg>
      );
    case 'collection':
      return (
        <svg {...common}>
          <path d="M6.8 5.3h9M6.8 10h9M6.8 14.7h9" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" />
          <path d="M3.9 5.3h.1M3.9 10h.1M3.9 14.7h.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
        </svg>
      );
    case 'canvas':
    default:
      return (
        <svg {...common}>
          <path d="M7.1 6.2l5.7 2.8M7.1 13.8l5.7-4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <circle cx="5.1" cy="5.3" r="2.2" fill="none" stroke="currentColor" stroke-width="1.45" />
          <circle cx="14.9" cy="9.8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.45" />
          <circle cx="5.1" cy="14.7" r="2.2" fill="none" stroke="currentColor" stroke-width="1.45" />
        </svg>
      );
  }
}

export function SpaceTypeIndicator({
  renderer,
  showLabel = false,
  className,
  iconClassName,
  labelClassName,
  'data-testid': testId,
}: SpaceTypeIndicatorProps): JSX.Element {
  const label = spaceTypeLabel(renderer);
  return (
    <span
      className={['space-type-indicator', className].filter(Boolean).join(' ')}
      title={label}
      role={showLabel ? undefined : 'img'}
      aria-label={showLabel ? undefined : `${label} space type`}
      data-testid={testId}
    >
      <SpaceTypeGlyph renderer={renderer} className={iconClassName} />
      {showLabel ? (
        <span className={['space-type-indicator__label', labelClassName].filter(Boolean).join(' ')}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
