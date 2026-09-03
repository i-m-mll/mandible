import type { JSX } from 'preact';

export type DisclosureChevronIconProps = {
  expanded: boolean;
  size?: number;
};

/** Canonical inline disclosure chevron used beside foldable headings. */
export function DisclosureChevronIcon({
  expanded,
  size = 14,
}: DisclosureChevronIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-disclosure-chevron={expanded ? 'down' : 'right'}
    >
      <path d={expanded ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  );
}
