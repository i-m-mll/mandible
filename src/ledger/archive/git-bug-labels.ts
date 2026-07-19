import type {
  LedgerIssueKind,
  LedgerPriority,
  LedgerRelationshipType,
} from "./types.js";
import {
  LEDGER_ISSUE_KINDS,
  LEDGER_PRIORITIES,
} from "./types.js";

export type GitBugSemanticLabel =
  | { kind: "issue_kind"; value: LedgerIssueKind; raw: string }
  | { kind: "priority"; value: LedgerPriority; raw: string }
  | {
      kind: "relationship";
      relationship_type: LedgerRelationshipType;
      target_ref: string;
      direction: "outgoing" | "incoming";
      raw: string;
    }
  | { kind: "legacy_parent"; target_ref: string; raw: string }
  | { kind: "merged"; raw: string };

const RELATIONSHIP_LABELS: Record<string, { type: LedgerRelationshipType; direction: "outgoing" | "incoming" }> = {
  parent: { type: "parent_child", direction: "incoming" },
  "blocked-by": { type: "blocks", direction: "incoming" },
  blocks: { type: "blocks", direction: "outgoing" },
  related: { type: "related", direction: "outgoing" },
  "duplicate-of": { type: "duplicate_of", direction: "outgoing" },
  references: { type: "references", direction: "outgoing" },
};

export function parseGitBugLabel(label: string): GitBugSemanticLabel | null {
  const raw = label.trim();
  if (!raw) return null;
  if (raw === "merged") return { kind: "merged", raw };
  if (raw.startsWith("parent:")) {
    return { kind: "legacy_parent", target_ref: raw.slice("parent:".length), raw };
  }
  if (!raw.startsWith("mandible:")) return null;

  const [, namespace, value] = raw.split(":", 3);
  if (!namespace || !value) return null;
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

function isLedgerIssueKind(value: string): value is LedgerIssueKind {
  return (LEDGER_ISSUE_KINDS as readonly string[]).includes(value);
}

function isLedgerPriority(value: string): value is LedgerPriority {
  return (LEDGER_PRIORITIES as readonly string[]).includes(value);
}

export function formatKindLabel(kind: LedgerIssueKind): string {
  return `mandible:kind:${kind}`;
}

export function formatPriorityLabel(priority: LedgerPriority): string {
  return `mandible:priority:${priority}`;
}

export function formatRelationshipLabel(type: LedgerRelationshipType, targetRef: string): string | null {
  const cleanTarget = targetRef.trim();
  if (!cleanTarget) return null;
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
