import path from "node:path";

/** Worktree locations owned by another Mandible/Codex lifecycle. */
export function isPreservedAppWorktreePath(candidate: string): boolean {
  const parts = path.resolve(candidate).split(path.sep);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === ".codex" && parts[index + 1] === "worktrees") return true;
    if (
      parts[index] === ".git" &&
      parts[index + 1] === "mandible-docs-worktrees"
    ) return true;
  }
  return false;
}
