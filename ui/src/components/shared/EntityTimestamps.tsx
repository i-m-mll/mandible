import { formatRelativeTime, type RelativeTimeStyle } from '../../lib/format';

type TimestampValue = string | number | null | undefined;

export type EntityTimestampsProps = {
  createdAt?: TimestampValue;
  updatedAt?: TimestampValue;
  style?: RelativeTimeStyle;
  className?: string;
};

function timestampMs(value: TimestampValue): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function Timestamp({
  label,
  value,
  style,
}: {
  label: 'created' | 'updated';
  value: number;
  style: RelativeTimeStyle;
}): JSX.Element {
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {label} {formatRelativeTime(value, { style })}
    </time>
  );
}

/**
 * Shared entity timestamp presentation. Creation is always explicit; an
 * independently changed update time is shown first so recent activity leads.
 */
export function EntityTimestamps({
  createdAt,
  updatedAt,
  style = 'recent',
  className,
}: EntityTimestampsProps): JSX.Element | null {
  const created = timestampMs(createdAt);
  const updated = timestampMs(updatedAt);
  const showUpdated = updated !== null && (created === null || updated !== created);

  if (created === null && !showUpdated) return null;

  return (
    <span className={className}>
      {showUpdated && updated !== null && (
        <Timestamp label="updated" value={updated} style={style} />
      )}
      {showUpdated && created !== null && ' · '}
      {created !== null && <Timestamp label="created" value={created} style={style} />}
    </span>
  );
}
