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

/**
 * Derive a base project key from canonical identity inputs, in priority order:
 * remote-identity tail, then display name, then checkout basename. The
 * path-derived WorkScanner id is deliberately NOT a source.
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
    if (slug) return slug;
  }
  const fromDisplay = slugifyProjectKey(input.display_name);
  if (fromDisplay && fromDisplay !== "local-project") return fromDisplay;
  const root = input.root?.trim();
  if (root) {
    const fromRoot = slugifyProjectKey(path.basename(root));
    if (fromRoot) return fromRoot;
  }
  return fromDisplay || "project";
}

/** Suffix a base key with -2, -3, … until it is not in `taken`. */
export function dedupeProjectKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}
