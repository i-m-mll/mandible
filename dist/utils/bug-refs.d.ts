/**
 * Extract Bug: trailer references from a commit message.
 * Returns the issue ID strings (e.g. ["7a141c3", "abc1234"]).
 * Matches lines of the form: `Bug: <id>` at the start of a line.
 * Bug: 7a141c3 — extracted to server-side for graph edge inference
 */
export declare function extractBugRefs(message: string): string[];
