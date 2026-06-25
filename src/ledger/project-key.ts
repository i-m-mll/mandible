import path from "node:path";

// Issue: 3d85f43 — pure project_key derivation helpers. Kept in their own module
// (no DB / no projects.ts import) so both ledger/projects.ts (insert path) and
// ledger/project-registry.ts (registry surface) can use them without an import
// cycle.

export function slugifyProjectKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Slugs that carry no project identity — a basename of `repo`, a default
// "Local project" display name, etc. These never become a key on their own; the
// derivation reaches for a more distinctive hint (the parent directory) first
// and only falls back to a generic sentinel (which callers dedupe).
const GENERIC_KEYS = new Set(["", "repo", "repos", "project", "local-project", "local", "src", "code", "git"]);

export function isGenericProjectKey(slug: string | null | undefined): boolean {
  return slug == null || GENERIC_KEYS.has(slug);
}

/**
 * Derive a base project key from canonical identity inputs, in priority order:
 * remote-identity tail, then display name, then checkout basename, then — when
 * the basename is itself generic (e.g. `repo`) — the parent directory as a
 * qualifier (`/x/myproj/repo` -> `myproj-repo`). The path-derived WorkScanner id
 * is deliberately NOT a source. When nothing distinctive is available a generic
 * sentinel is returned (callers dedupe it); the interactive `mandible project
 * add` path requires an explicit `--key` instead of accepting a generic
 * derivation.
 */
export function deriveProjectKeyBase(input: {
  remote_identity?: string | null;
  display_name?: string | null;
  root?: string | null;
}): string {
  const identity = input.remote_identity?.trim() ?? "";
  if (identity && !identity.startsWith("local:") && !identity.startsWith("file:")) {
    const tail = identity.split("/").filter(Boolean).at(-1);
    const slug = slugifyProjectKey(tail);
    if (!isGenericProjectKey(slug)) return slug;
  }
  const fromDisplay = slugifyProjectKey(input.display_name);
  if (!isGenericProjectKey(fromDisplay)) return fromDisplay;
  const root = input.root?.trim();
  if (root) {
    const base = slugifyProjectKey(path.basename(root));
    if (!isGenericProjectKey(base)) return base;
    // The basename is generic (e.g. `repo`): qualify with the parent directory.
    const parent = slugifyProjectKey(path.basename(path.dirname(root)));
    if (!isGenericProjectKey(parent)) {
      return base ? `${parent}-${base}` : parent;
    }
  }
  // Nothing distinctive — a generic, deduped-by-caller fallback.
  return fromDisplay || "project";
}

/** Suffix a base key with -2, -3, … until it is not in `taken`. */
export function dedupeProjectKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}
