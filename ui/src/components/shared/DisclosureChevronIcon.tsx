import { Icon } from '../icons/Icon';
import type { JSX } from 'preact';

export type DisclosureChevronIconProps = {
  expanded: boolean;
  size?: number;
};

/** Canonical inline disclosure chevron used beside foldable headings. */
export function DisclosureChevronIcon({ expanded, size = 14 }: DisclosureChevronIconProps): JSX.Element {
  return <Icon name={expanded ? 'disclosureExpanded' : 'disclosureCollapsed'} size={size} data-disclosure-chevron={expanded ? 'down' : 'right'} />;
}
