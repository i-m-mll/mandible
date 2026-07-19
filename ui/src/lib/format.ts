export type RelativeTimeStyle = 'compact' | 'recent' | 'verbose';

export type RelativeTimeOptions = {
  style?: RelativeTimeStyle;
  empty?: string;
  invalid?: 'input' | string;
  absoluteAfterDays?: number;
  zeroIsEmpty?: boolean;
};

export type AbsoluteTimeOptions = {
  empty?: string;
  invalid?: 'input' | string;
  zeroIsEmpty?: boolean;
};

type ArtifactLinkBadge = {
  link_kind?: string | null;
  resolved_version_no?: number | null;
};

function invalidTimeLabel(
  value: string | number,
  invalid: 'input' | string = 'input',
): string {
  return invalid === 'input' ? String(value) : invalid;
}

/**
 * Format a timestamp using one of the UI's established display styles.
 *
 * The options preserve the intentional differences between compact ledger
 * labels, recent-activity labels, and the verbose settings status text while
 * keeping parsing and boundary behavior in one place.
 */
export function formatRelativeTime(
  value?: string | number | null,
  options: RelativeTimeOptions = {},
): string {
  const {
    style = 'compact',
    empty = '',
    invalid = 'input',
    absoluteAfterDays,
    zeroIsEmpty = false,
  } = options;
  if (value === null || value === undefined || value === '' || (zeroIsEmpty && value === 0)) {
    return empty;
  }

  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(parsed)) return invalidTimeLabel(value, invalid);

  const delta = Date.now() - parsed;
  const seconds = Math.floor(delta / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (style === 'verbose') {
    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  if (style === 'recent') {
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (absoluteAfterDays !== undefined && days >= absoluteAfterDays) {
      return new Date(parsed).toLocaleDateString();
    }
    return `${days}d ago`;
  }

  if (delta < 0) return 'just now';
  if (days > 1) return `${days}d ago`;
  if (days === 1) return 'yesterday';
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

export function formatAbsoluteTime(
  value?: string | number | null,
  options: AbsoluteTimeOptions = {},
): string {
  const { empty = '', invalid = 'input', zeroIsEmpty = false } = options;
  if (value === null || value === undefined || value === '' || (zeroIsEmpty && value === 0)) {
    return empty;
  }
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(parsed)) return invalidTimeLabel(value, invalid);
  return new Date(parsed).toLocaleString();
}

export function truncate(text: string, maxLen = 20): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

export function artifactLinkBadgeLabel(link: ArtifactLinkBadge): string {
  const version = typeof link.resolved_version_no === 'number' ? `v${link.resolved_version_no}` : null;
  if (link.link_kind === 'living') return version ? `latest → ${version}` : 'latest';
  return version ? `${version} pinned` : 'pinned';
}
