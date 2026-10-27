import { Icon } from '../icons/Icon';
import type { JSX } from 'preact/jsx-runtime';

export function OverlayCloseButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="overlay-close-button" aria-label={label} onClick={onClick}>
      <Icon name="close" />
    </button>
  );
}
