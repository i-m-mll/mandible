import {
  LEDGER_CONCRETE_ISSUE_KINDS,
  LEDGER_ISSUE_KINDS,
  LEDGER_ISSUE_RESOLUTIONS,
  LEDGER_ISSUE_STATUSES,
  LEDGER_PRIORITIES,
} from '../../../src/ledger/types.js';
import type {
  LedgerIssueKind,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerPriority,
} from '../../../src/ledger/types.js';

export { LEDGER_CONCRETE_ISSUE_KINDS, LEDGER_ISSUE_KINDS, LEDGER_ISSUE_RESOLUTIONS, LEDGER_ISSUE_STATUSES, LEDGER_PRIORITIES };
export type { LedgerIssueKind, LedgerIssueResolution, LedgerIssueStatus };

export type LedgerIssuePriority = LedgerPriority;

export function normalizeLedgerIssueKind(value: unknown): LedgerIssueKind {
  return typeof value === 'string' && (LEDGER_ISSUE_KINDS as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as LedgerIssueKind
    : 'unknown';
}

export function normalizeLedgerIssuePriority(value: unknown): LedgerIssuePriority {
  return typeof value === 'string' && (LEDGER_PRIORITIES as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as LedgerIssuePriority
    : 'normal';
}
