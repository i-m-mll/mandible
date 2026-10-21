// The lineage marker: the one structured line a spawner writes as line 1 of a
// child thread's first user message. This module is the only place its syntax
// is known.
//
//   [mandible child parent=<provider>:<session-id> parent-role=<role> role=<role>]
//   [mandible successor predecessor=<provider>:<session-id> role=<role>]

import type { ConversationParent } from "./conversation-lineage.js";
import type { ConversationSource } from "./parsers/types.js";

export type LineageMarker =
  | { relation: "child"; parent: ConversationParent; parentRole: string; role: string }
  | { relation: "successor"; predecessor: ConversationParent; role: string };

/** What line 1 of a conversation's first user message says about its lineage. */
export type OpeningLine =
  | { kind: "none" }
  | { kind: "marker"; marker: LineageMarker; line: string }
  | { kind: "malformed"; line: string; reason: string }
  | { kind: "legacy-prose"; line: string };

const PROVIDERS: Readonly<Record<string, ConversationSource>> = {
  claude: "claude_code",
  codex: "codex",
  gemini: "gemini",
};

const FIELDS = {
  child: ["parent", "parent-role", "role"],
  successor: ["predecessor", "role"],
} as const;

const MARKER_PREFIX = /^\[mandible\b/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[a-z][a-z-]*$/;
const LEGACY_PROSE = /^I am (?:a|an|the|your) [\w-]+(?: agent)? and your parent\b/i;

/** Classify line 1 of a first user message. */
export function readOpeningLine(message: string): OpeningLine {
  const line = message.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (MARKER_PREFIX.test(line)) {
    const parsed = parseMarker(line);
    return parsed.ok
      ? { kind: "marker", marker: parsed.marker, line }
      : { kind: "malformed", line, reason: parsed.reason };
  }
  if (LEGACY_PROSE.test(line)) return { kind: "legacy-prose", line };
  return { kind: "none" };
}

type MarkerParse = { ok: true; marker: LineageMarker } | { ok: false; reason: string };

function parseMarker(line: string): MarkerParse {
  if (!line.endsWith("]")) return { ok: false, reason: "marker does not end with ]" };
  const [, relation, ...pairs] = line.slice(1, -1).trim().split(/\s+/);
  if (relation !== "child" && relation !== "successor") {
    return { ok: false, reason: `relation must be child or successor, not ${relation ?? "nothing"}` };
  }
  const fields = new Map<string, string>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { ok: false, reason: `field ${pair} is not key=value` };
    const key = pair.slice(0, eq);
    if (!(FIELDS[relation] as readonly string[]).includes(key)) {
      return { ok: false, reason: `${relation} marker has no field ${key}` };
    }
    if (fields.has(key)) return { ok: false, reason: `field ${key} is repeated` };
    fields.set(key, pair.slice(eq + 1));
  }
  const missing = FIELDS[relation].find((key) => !fields.has(key));
  if (missing) return { ok: false, reason: `${relation} marker lacks field ${missing}` };

  for (const key of ["parent-role", "role"] as const) {
    const role = fields.get(key);
    if (role !== undefined && !ROLE.test(role)) return { ok: false, reason: `${key} ${role} is not a lowercase role name` };
  }
  const refKey = relation === "child" ? "parent" : "predecessor";
  const ref = parseSessionRef(fields.get(refKey)!);
  if (!ref.ok) return { ok: false, reason: `${refKey} ${ref.reason}` };
  return relation === "child"
    ? { ok: true, marker: { relation, parent: ref.session, parentRole: fields.get("parent-role")!, role: fields.get("role")! } }
    : { ok: true, marker: { relation, predecessor: ref.session, role: fields.get("role")! } };
}

function parseSessionRef(value: string): { ok: true; session: ConversationParent } | { ok: false; reason: string } {
  const colon = value.indexOf(":");
  const source = colon > 0 ? PROVIDERS[value.slice(0, colon)] : undefined;
  if (!source) return { ok: false, reason: `${value} does not start with claude:, codex: or gemini:` };
  const sessionId = value.slice(colon + 1);
  if (!SESSION_ID.test(sessionId)) return { ok: false, reason: `${value} does not name a provider session id` };
  return { ok: true, session: { source, sessionId: sessionId.toLowerCase() } };
}
