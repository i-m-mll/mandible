import {
  LEDGER_CONCRETE_ISSUE_KINDS as BACKEND_CONCRETE_ISSUE_KINDS,
  LEDGER_ISSUE_KINDS as BACKEND_ISSUE_KINDS,
  LEDGER_ISSUE_RESOLUTIONS,
  LEDGER_ISSUE_STATUSES,
  LEDGER_PRIORITIES,
} from '../../../src/ledger/types.js';
import type {
  LedgerIssueKind as BackendLedgerIssueKind,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerPriority,
} from '../../../src/ledger/types.js';

// The browser imports the pure ledger vocabulary rather than maintaining a
// second copy. `coordination` is included here until the sibling backend lane
// lands that approved enum; Set keeps the transition idempotent when it does.
const UI_ADDED_ISSUE_KINDS = ['coordination'] as const;
const unique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)];

export { LEDGER_ISSUE_RESOLUTIONS, LEDGER_ISSUE_STATUSES, LEDGER_PRIORITIES };
export type { LedgerIssueResolution, LedgerIssueStatus };

export const LEDGER_ISSUE_KINDS = unique([...BACKEND_ISSUE_KINDS, ...UI_ADDED_ISSUE_KINDS]) as unknown as readonly [
  ...typeof BACKEND_ISSUE_KINDS,
  'coordination',
];
export type LedgerIssueKind = BackendLedgerIssueKind | (typeof UI_ADDED_ISSUE_KINDS)[number];

export const LEDGER_CONCRETE_ISSUE_KINDS = unique([
  ...BACKEND_CONCRETE_ISSUE_KINDS,
  ...UI_ADDED_ISSUE_KINDS,
]) as unknown as readonly [...typeof BACKEND_CONCRETE_ISSUE_KINDS, 'coordination'];

export type LedgerIssuePriority = LedgerPriority;

export function normalizeLedgerIssueKind(value: unknown): LedgerIssueKind {
  return typeof value === 'string' && (LEDGER_ISSUE_KINDS as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as LedgerIssueKind
    : 'unknown';
}

export function normalizeLedgerIssuePriority(value: unknown): LedgerIssuePriority {
  return typeof value === 'string' && (LEDGER_PRIORITIES as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as LedgerIssuePriority
    : 'unknown';
}
