export const LEDGER_ISSUE_STATUSES = ["open", "closed"];
export const LEDGER_ISSUE_RESOLUTIONS = [
    "fixed",
    "merged",
    "duplicate",
    "wontfix",
    "invalid",
    "obsolete",
    "unknown",
];
export const LEDGER_ISSUE_KINDS = [
    "bug",
    "feature",
    "umbrella",
    "task",
    "question",
    "maintenance",
    "deferred",
    "unknown",
];
export const LEDGER_PRIORITIES = ["low", "normal", "high", "urgent", "unknown"];
export const LEDGER_ACTOR_TYPES = [
    "mandible_user",
    "agent",
    "system",
    "external_adapter",
];
export const LEDGER_EVENT_SOURCES = [
    "mandible",
    "git_bug",
    "auth_queue",
    "session",
    "work_unit",
    "import",
    "system",
];
export const LEDGER_OUTBOX_STATUSES = [
    "pending",
    "processing",
    "applied",
    "failed",
    "conflicted",
    "skipped",
];
export const LEDGER_CONFLICT_STATUSES = ["open", "resolved", "dismissed"];
export const LEDGER_RELATIONSHIP_TYPES = [
    "parent_child",
    "blocks",
    "duplicate_of",
    "related",
    "references",
    "fixed_by",
    "caused_by",
    "implements",
    "tests",
];
export const LEDGER_RELATIONSHIP_PROVENANCES = [
    "manual",
    "imported",
    "derived",
    "system",
];
