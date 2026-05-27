import { createHash, randomBytes } from "node:crypto";
export const LEDGER_ID_PREFIXES = [
    "prj",
    "chk",
    "iss",
    "com",
    "evt",
    "out",
    "rel",
    "cnf",
    "xref",
    "job",
    "rec",
    "mis",
    "opb",
    "opm",
];
const TIME_WIDTH = 10;
const RANDOM_BYTES = 10;
/**
 * Generate a Mandible ledger ID. This is UUIDv7-like rather than a full RFC
 * UUIDv7 implementation: lexicographic order follows millisecond time, then a
 * cryptographic-random suffix prevents path/title/git-bug-derived IDs.
 */
export function createLedgerId(prefix, options = {}) {
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now) || now < 0) {
        throw new Error(`Invalid ledger ID timestamp: ${now}`);
    }
    const time = Math.floor(now).toString(36).padStart(TIME_WIDTH, "0");
    const entropy = options.random ?? randomBytes(RANDOM_BYTES);
    if (entropy.length < RANDOM_BYTES) {
        throw new Error(`Ledger ID entropy must be at least ${RANDOM_BYTES} bytes`);
    }
    return `${prefix}_${time}_${entropy.subarray(0, RANDOM_BYTES).toString("hex")}`;
}
export function isLedgerIdWithPrefix(value, prefix) {
    return value.startsWith(`${prefix}_`);
}
export function createCreationNonce() {
    return randomBytes(16).toString("hex");
}
export function createStableIssueId(input) {
    return sha256Hex({
        type: "mandible.issue.v1",
        project_id: input.project_id,
        title: input.title,
        body: input.body ?? "",
        source: input.source ?? "mandible",
        created_at: input.created_at,
        author_actor_id: input.author_actor_id ?? null,
        author_actor_type: input.author_actor_type ?? "external_adapter",
        author_display: input.author_display ?? "",
        nonce: input.nonce,
    });
}
export function createStableCommentId(input) {
    return sha256Hex({
        type: "mandible.comment.v1",
        issue_id: input.issue_id,
        ordinal: input.ordinal,
        body: input.body,
        source: input.source ?? "mandible",
        created_at: input.created_at,
        author_actor_id: input.author_actor_id ?? null,
        author_actor_type: input.author_actor_type ?? "external_adapter",
        author_display: input.author_display ?? "",
        nonce: input.nonce,
    });
}
export function createStableEventId(input) {
    return sha256Hex({
        type: "mandible.event.v1",
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        event_type: input.event_type,
        actor_id: input.actor_id ?? null,
        actor_type: input.actor_type,
        source: input.source,
        payload: input.payload,
        occurred_at: input.occurred_at,
        observed_at: input.observed_at,
        occurrence: input.occurrence,
    });
}
export function isSha256Hex(value) {
    return /^[0-9a-f]{64}$/.test(value);
}
export function shortestUniquePrefix(id, ids, minimum = 7) {
    const normalized = id.toLowerCase();
    const peers = Array.from(ids, (peer) => peer.toLowerCase()).filter((peer) => peer !== normalized);
    for (let length = Math.min(minimum, normalized.length); length <= normalized.length; length++) {
        const prefix = normalized.slice(0, length);
        if (!peers.some((peer) => peer.startsWith(prefix)))
            return prefix;
    }
    return normalized;
}
function sha256Hex(record) {
    return createHash("sha256").update(stableJson(record)).digest("hex");
}
function stableJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    const object = value;
    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
        .join(",")}}`;
}
