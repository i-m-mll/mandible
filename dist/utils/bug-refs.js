/**
 * Extract Bug: trailer references from a commit message.
 * Returns the issue ID strings (e.g. ["7a141c3", "abc1234"]).
 * Matches lines of the form: `Bug: <id>` at the start of a line.
 * Bug: 7a141c3 — extracted to server-side for graph edge inference
 */
export function extractBugRefs(message) {
    if (!message)
        return [];
    const refs = [];
    const regex = /^Bug:\s+(\S+)/gm;
    let match;
    while ((match = regex.exec(message)) !== null) {
        refs.push(match[1]);
    }
    return refs;
}
