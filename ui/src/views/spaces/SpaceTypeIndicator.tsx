import { Icon, type IconName } from '../../components/icons/Icon';
import type { SpaceRenderer } from '../../api';
import './SpaceTypeIndicator.css';

const SPACE_TYPE_ICONS = {
  canvas: 'spaceCanvas', document: 'spaceDocument', board: 'spaceBoard', collection: 'spaceCollection',
} satisfies Record<SpaceRenderer, IconName>;

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
  const role = isSpaceRenderer(renderer) ? SPACE_TYPE_ICONS[renderer] : SPACE_TYPE_ICONS.canvas;
  return <Icon name={role} size={20} className={['space-type-indicator__icon', className].filter(Boolean).join(' ')} />;
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
