import type { JSX } from 'preact/jsx-runtime';

const ARROW_PATHS = {
  up: { head: 'm6 12 6-6 6 6', shaft: 'M12 6v12' },
  down: { head: 'm6 12 6 6 6-6', shaft: 'M12 18V6' },
  left: { head: 'm12 6-6 6 6 6', shaft: 'M6 12h12' },
  right: { head: 'm12 6 6 6-6 6', shaft: 'M18 12H6' },
} as const;

export type ArrowIconProps = {
  direction: keyof typeof ARROW_PATHS;
  size?: number;
  strokeWidth?: number;
};

export function ArrowIcon({
  direction,
  size = 16,
  strokeWidth = 2,
}: ArrowIconProps): JSX.Element {
  const paths = ARROW_PATHS[direction];

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
      <path d={paths.head} />
      <path d={paths.shaft} />
    </svg>
  );
}
