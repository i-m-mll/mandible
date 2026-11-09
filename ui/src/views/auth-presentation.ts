import type { AuthRequestType } from '../../../src/contracts';

export const AUTH_TYPE_META: Record<AuthRequestType, { label: string; cssClass: string }> = {
  'merge':          { label: 'Merge',       cssClass: 'type-badge--merge' },
  'commit':         { label: 'Commit',      cssClass: 'type-badge--commit' },
  'force-push':     { label: 'Force Push',  cssClass: 'type-badge--force-push' },
  'branch-delete':  { label: 'Delete',      cssClass: 'type-badge--branch-delete' },
  'config-change':  { label: 'Config',      cssClass: 'type-badge--config-change' },
  'data-delete':    { label: 'Delete Data', cssClass: 'type-badge--data-delete' },
  'custody-transfer': { label: 'Custody',   cssClass: 'type-badge--custody-transfer' },
};

export function isFailedLikeStatus(status: string): boolean {
  return status === 'failed' || status === 'needs_rebase' || status === 'expired';
}

export function authStatusPillClass(status: string): string {
  return `status-pill status-pill--${isFailedLikeStatus(status) ? 'failed' : status.toLowerCase()}`;
}
