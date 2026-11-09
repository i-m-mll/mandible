import type { LedgerIssueDetailAuthRequest } from '../../api';

/** An issue's open/closed status, and its resolution when closed. */
export function StatusPill({
  status,
  resolution,
  linkedAuth,
  onOpenAuth,
  size = 'lg',
}: {
  status: string;
  resolution: string | null;
  linkedAuth?: LedgerIssueDetailAuthRequest;
  onOpenAuth?: (auth: LedgerIssueDetailAuthRequest) => void;
  // The header pill is the pane's headline status and stays large. Inline row
  // pills (the umbrella children shelf) take the base size so a row keeps the
  // same height as every other ledger row.
  size?: 'sm' | 'lg';
}): JSX.Element {
  const label = status === 'closed' && resolution ? `${status}: ${resolution}` : status;
  const cls = status === 'open' ? 'status-pill--success' : resolution === 'delivered' ? 'status-pill--merged' : 'status-pill--dismissed';
  const sizeCls = size === 'lg' ? ' status-pill--lg' : '';
  if (linkedAuth && onOpenAuth) {
    return (
      <button type="button" className={`status-pill${sizeCls} ledger-status-button ${cls}`} onClick={() => onOpenAuth(linkedAuth)}>
        {label}
      </button>
    );
  }
  return <span className={`status-pill${sizeCls} ${cls}`}>{label}</span>;
}
