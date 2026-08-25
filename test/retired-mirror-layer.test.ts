import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Issue beb76d6 — the git-bug mirror/sync layer is retired. Its tables still
// exist (ledger_external_refs holds 3,111 real git-bug id mappings and
// ledger_sync_jobs 72 historical import jobs), so they are still declared,
// migrated and backed up. What must not come back is a reader or writer: every
// such query was dead, returned permanently-empty results, and cost four
// queries per issue-detail render.
//
// This guard fails on reintroduction rather than on the schema's continued
// existence, so the Phase 3 table drop does not have to touch it.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETIRED_TABLES = [
  "ledger_outbox",
  "ledger_external_refs",
  "ledger_conflicts",
  "ledger_sync_jobs",
];

/**
 * Modules that legitimately name the tables without querying their contents:
 * schema declaration, forward migration, backup enumeration, and the
 * project-delete relocation map.
 */
const SCHEMA_OWNERS = new Set([
  "db-baseline.ts",
  "db-migrations.ts",
  "ledger/backup.ts",
  "ledger/project-registry.ts",
]);

function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(rel);
    }
  }
  return out;
}

describe("retired git-bug mirror layer", () => {
  it("has no production reader or writer of the retired mirror tables", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles(path.join(REPO_ROOT, "src"))) {
      if (SCHEMA_OWNERS.has(rel)) continue;
      const text = readFileSync(path.join(REPO_ROOT, "src", rel), "utf8");
      for (const table of RETIRED_TABLES) {
        if (text.includes(table)) offenders.push(`src/${rel} references ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the retired tables declared and backed up while their rows exist", () => {
    const baseline = readFileSync(path.join(REPO_ROOT, "src/db-baseline.ts"), "utf8");
    const backup = readFileSync(path.join(REPO_ROOT, "src/ledger/backup.ts"), "utf8");
    for (const table of RETIRED_TABLES) {
      expect(baseline).toContain(`CREATE TABLE ${table} `);
      expect(backup).toContain(`"${table}"`);
    }
  });
});
