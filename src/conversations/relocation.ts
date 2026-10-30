import fs from "node:fs";
import path from "node:path";

import { codexRelocationCandidates, codexRolloutPathsEquivalent, isCodexRolloutPath } from "../parsers/codex.js";

/**
 * Where a provider may move a transcript without changing the conversation.
 *
 * A source path is a locator, not an identity. Providers relocate transcripts
 * wholesale: `codex archive` moves rollouts between `~/.codex/sessions` and
 * `~/.codex/archived_sessions`, and Claude Code keys `~/.claude/projects/<key>`
 * by the encoded working directory, so moving a project renames the key. Two
 * paths are relocation-equivalent when the provider could have moved one to the
 * other; ingestion still has to prove the parsed native identity before it
 * follows a move.
 *
 * Provider session ids are not unique transcripts on their own: Claude subagent
 * files share their parent's session id, a resumed or forked Claude transcript
 * can carry an earlier session id under its own file name, and project copies
 * hold the same transcript at two live paths. The equivalence class keeps each
 * transcript's position below its provider root, so only the movable prefix is
 * ignored.
 */

interface ClaudeProjectLocation {
  root: string;
  key: string;
  relative: string;
}

function claudeProjectLocation(filePath: string): ClaudeProjectLocation | null {
  const parts = path.resolve(filePath).split(path.sep);
  const claude = parts.lastIndexOf(".claude");
  if (claude < 0 || parts[claude + 1] !== "projects" || parts.length < claude + 4) return null;
  const relative = parts.slice(claude + 3).join(path.sep);
  if (!relative.endsWith(".jsonl")) return null;
  return {
    root: parts.slice(0, claude + 2).join(path.sep) || path.sep,
    key: parts[claude + 2],
    relative,
  };
}

/** True when a provider relocation could have moved `left` to `right`. */
export function sourcePathsRelocationEquivalent(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) return false;
  if (isCodexRolloutPath(left) || isCodexRolloutPath(right)) return codexRolloutPathsEquivalent(left, right);
  const a = claudeProjectLocation(left);
  const b = claudeProjectLocation(right);
  return Boolean(a && b && a.root === b.root && a.relative === b.relative && a.key !== b.key);
}

/**
 * Lists the paths a transcript could occupy after a provider relocation, most
 * likely first. Callers probe which of them exist and prove identity.
 *
 * One finder serves one pass: it caches each Claude projects root's
 * key-to-entry index, so probing thousands of rekeyed transcripts costs one
 * directory read per project key rather than one stat per key per transcript.
 */
export function createRelocationCandidateFinder(): (filePath: string) => Promise<string[]> {
  const claudeIndexes = new Map<string, Promise<Map<string, string[]>>>();
  const claudeIndex = (root: string) => {
    let index = claudeIndexes.get(root);
    if (!index) {
      index = buildClaudeProjectIndex(root);
      claudeIndexes.set(root, index);
    }
    return index;
  };
  return async (filePath) => {
    if (isCodexRolloutPath(filePath)) return codexRelocationCandidates(filePath);
    const location = claudeProjectLocation(filePath);
    if (!location) return [];
    const head = location.relative.split(path.sep)[0];
    const keys = (await claudeIndex(location.root)).get(head) ?? [];
    return keys
      .filter((key) => key !== location.key)
      .map((key) => path.join(location.root, key, location.relative));
  };
}

/** Top-level entry name -> project keys holding an entry of that name. */
async function buildClaudeProjectIndex(root: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  let keys: fs.Dirent[];
  try {
    keys = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await fs.promises.readdir(path.join(root, key.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const holders = index.get(entry);
      if (holders) holders.push(key.name);
      else index.set(entry, [key.name]);
    }
  }
  return index;
}
