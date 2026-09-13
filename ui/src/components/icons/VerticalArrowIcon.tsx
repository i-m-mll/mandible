import type { JSX } from 'preact/jsx-runtime';

export type VerticalArrowIconProps = {
  direction: 'up' | 'down';
  size?: number;
  strokeWidth?: number;
};

export function VerticalArrowIcon({
  direction,
  size = 16,
  strokeWidth = 2,
}: VerticalArrowIconProps): JSX.Element {
  const points = direction === 'up' ? 'm6 12 6-6 6 6' : 'm6 12 6 6 6-6';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={points} />
      <path d={direction === 'up' ? 'M12 6v12' : 'M12 18V6'} />
    </svg>
  );
}
