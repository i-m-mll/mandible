import { formatRelativeTime, type RelativeTimeStyle } from '../../lib/format';

type TimestampValue = string | number | null | undefined;

export type EntityTimestampsProps = {
  createdAt?: TimestampValue;
  updatedAt?: TimestampValue;
  createdBy?: string | null;
  updatedBy?: string | null;
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
  actor,
  style,
}: {
  label: 'created' | 'updated';
  value: number;
  actor?: string | null;
  style: RelativeTimeStyle;
}): JSX.Element {
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {label} {formatRelativeTime(value, { style })}{actor ? ` by ${actor}` : ''}
    </time>
  );
}

/**
 * Shared entity timestamp presentation. Creation is always explicit; a
 * distinct update follows it. Actor attribution is rendered only when the
 * caller has authoritative provenance for that event.
 */
export function EntityTimestamps({
  createdAt,
  updatedAt,
  createdBy,
  updatedBy,
  style = 'recent',
  className,
}: EntityTimestampsProps): JSX.Element | null {
  const created = timestampMs(createdAt);
  const updated = timestampMs(updatedAt);
  const showUpdated = updated !== null && (created === null || updated !== created);

  if (created === null && !showUpdated) return null;

  return (
    <span className={className}>
      {created !== null && <Timestamp label="created" value={created} actor={createdBy} style={style} />}
      {showUpdated && created !== null && ' · '}
      {showUpdated && updated !== null && (
        <Timestamp label="updated" value={updated} actor={updatedBy} style={style} />
      )}
    </span>
  );
}
