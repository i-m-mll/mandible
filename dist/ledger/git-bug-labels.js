import { LEDGER_ISSUE_KINDS, LEDGER_PRIORITIES, } from "./types.js";
const RELATIONSHIP_LABELS = {
    parent: { type: "parent_child", direction: "incoming" },
    "blocked-by": { type: "blocks", direction: "incoming" },
    blocks: { type: "blocks", direction: "outgoing" },
    related: { type: "related", direction: "outgoing" },
    "duplicate-of": { type: "duplicate_of", direction: "outgoing" },
    references: { type: "references", direction: "outgoing" },
};
export function parseGitBugLabel(label) {
    const raw = label.trim();
    if (!raw)
        return null;
    if (raw === "merged")
        return { kind: "merged", raw };
    if (raw.startsWith("parent:")) {
        return { kind: "legacy_parent", target_ref: raw.slice("parent:".length), raw };
    }
    if (!raw.startsWith("mandible:"))
        return null;
    const [, namespace, value] = raw.split(":", 3);
    if (!namespace || !value)
        return null;
    if (namespace === "kind") {
        return isLedgerIssueKind(value) ? { kind: "issue_kind", value, raw } : null;
    }
    if (namespace === "priority") {
        return isLedgerPriority(value) ? { kind: "priority", value, raw } : null;
    }
    const relationshipType = RELATIONSHIP_LABELS[namespace];
    if (relationshipType) {
        return {
            kind: "relationship",
            relationship_type: relationshipType.type,
            target_ref: value,
            direction: relationshipType.direction,
            raw,
        };
    }
    return null;
}
function isLedgerIssueKind(value) {
    return LEDGER_ISSUE_KINDS.includes(value);
}
function isLedgerPriority(value) {
    return LEDGER_PRIORITIES.includes(value);
}
export function formatKindLabel(kind) {
    return `mandible:kind:${kind}`;
}
export function formatPriorityLabel(priority) {
    return `mandible:priority:${priority}`;
}
export function formatRelationshipLabel(type, targetRef) {
    const cleanTarget = targetRef.trim();
    if (!cleanTarget)
        return null;
    switch (type) {
        case "parent_child":
            return `mandible:parent:${cleanTarget}`;
        case "blocks":
            return `mandible:blocks:${cleanTarget}`;
        case "duplicate_of":
            return `mandible:duplicate-of:${cleanTarget}`;
        case "related":
            return `mandible:related:${cleanTarget}`;
        case "references":
            return `mandible:references:${cleanTarget}`;
        default:
            return null;
    }
}
