export const LEDGER_BACKUP_TABLES = [
  "ledger_projects",
  "ledger_project_checkouts",
  "ledger_issues",
  "ledger_issue_aliases",
  "ledger_comments",
  "ledger_labels",
  "ledger_issue_relationships",
  "ledger_events",
  "ledger_outbox",
  "ledger_external_refs",
  "ledger_conflicts",
] as const;

export type LedgerBackupTable = (typeof LEDGER_BACKUP_TABLES)[number];
