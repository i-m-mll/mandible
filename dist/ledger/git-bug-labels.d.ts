import type { LedgerIssueKind, LedgerPriority, LedgerRelationshipType } from "./types.js";
export type GitBugSemanticLabel = {
    kind: "issue_kind";
    value: LedgerIssueKind;
    raw: string;
} | {
    kind: "priority";
    value: LedgerPriority;
    raw: string;
} | {
    kind: "relationship";
    relationship_type: LedgerRelationshipType;
    target_ref: string;
    direction: "outgoing" | "incoming";
    raw: string;
} | {
    kind: "legacy_parent";
    target_ref: string;
    raw: string;
} | {
    kind: "merged";
    raw: string;
};
export declare function parseGitBugLabel(label: string): GitBugSemanticLabel | null;
export declare function formatKindLabel(kind: LedgerIssueKind): string;
export declare function formatPriorityLabel(priority: LedgerPriority): string;
export declare function formatRelationshipLabel(type: LedgerRelationshipType, targetRef: string): string | null;
