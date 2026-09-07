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
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m18 6-12 12" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}
