import type { JSX } from 'preact/jsx-runtime';

const ARROW_PATHS = {
  up: { head: 'm6 12 6-6 6 6', shaft: 'M12 6v12' },
  down: { head: 'm6 12 6 6 6-6', shaft: 'M12 18V6' },
  left: { head: 'm12 6-6 6 6 6', shaft: 'M6 12h12' },
  right: { head: 'm12 6 6 6-6 6', shaft: 'M18 12H6' },
} as const;

const HISTORY_ARROW_PATHS = {
  left: { head: 'm11 6-6 6 6 6', shaft: 'M5 12h14' },
  right: { head: 'm13 6 6 6-6 6', shaft: 'M19 12H5' },
} as const;

export type ArrowIconProps = {
  size?: number;
  strokeWidth?: number;
} & (
  | { direction: keyof typeof ARROW_PATHS; proportions?: 'standard' }
  | { direction: keyof typeof HISTORY_ARROW_PATHS; proportions: 'history' }
);

export function ArrowIcon(props: ArrowIconProps): JSX.Element {
  const { size = 16, strokeWidth = 2 } = props;
  const paths = props.proportions === 'history' ? HISTORY_ARROW_PATHS[props.direction] : ARROW_PATHS[props.direction];

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
