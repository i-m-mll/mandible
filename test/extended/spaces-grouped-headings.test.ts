// Grouped Spaces heading contract tests (issue 6fdd924).
//
// Acceptance criteria:
//   (a) Projects with zero Spaces must NOT appear in listSpacesGrouped() output.
//   (b) Every emitted group carries a `project_key` field from ledger_projects.
//   (c) Two distinct projects sharing the same display_name yield distinguishable
//       `project_name` labels (disambiguation via project_key or id prefix).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../../src/db.js";
import { createSpace, listSpacesGrouped } from "../../src/ledger/spaces.js";

let tempDir = "";

function now(): number {
  return Date.now();
}

/**
 * Insert a minimal ledger_projects row. `project_key` defaults to '' (as in
 * the migration schema), matching the state of rows that have not been
 * backfilled. Pass an explicit key to test disambiguation.
 */
function seedProject(
  db: Db,
  id: string,
  name: string,
  projectKey = "",
): string {
  db.prepare(
    `INSERT INTO ledger_projects (id, project_key, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectKey, name, `github.com/test/${id}`, now(), now());
  return id;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mandible-spaces-grouped-headings-"),
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) Zero-space projects excluded from grouped output
// ---------------------------------------------------------------------------

describe("(a) zero-space projects are excluded from listSpacesGrouped output", () => {
  it("omits a project that owns no Spaces", () => {
    const db = openDb(path.join(tempDir, "a1.db"));
    try {
      seedProject(db, "proj-with", "With Spaces", "with-spaces");
      seedProject(db, "proj-without", "Without Spaces", "without-spaces");
      createSpace(db, { project_id: "proj-with", title: "First" });

      const groups = listSpacesGrouped(db);
      const ids = groups.map((g) => g.project_id);
      expect(ids).toContain("proj-with");
      expect(ids).not.toContain("proj-without");
    } finally {
      db.close();
    }
  });

  it("returns an empty array when no projects own any Spaces", () => {
    const db = openDb(path.join(tempDir, "a2.db"));
    try {
      seedProject(db, "p1", "Alpha", "alpha");
      seedProject(db, "p2", "Beta", "beta");
      // No spaces created.
      expect(listSpacesGrouped(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("includes the top-level group when top-level Spaces exist, but no empty project headers", () => {
    const db = openDb(path.join(tempDir, "a3.db"));
    try {
      seedProject(db, "p1", "Empty Project", "empty-proj");
      createSpace(db, { title: "Top-level space" }); // no project_id

      const groups = listSpacesGrouped(db);
      // Only the top-level group (project_id null) should appear.
      expect(groups).toHaveLength(1);
      expect(groups[0].project_id).toBeNull();
      expect(groups[0].project_key).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) project_key present on every emitted group
// ---------------------------------------------------------------------------

describe("(b) project_key is present on every emitted group", () => {
  it("carries the canonical project_key from ledger_projects", () => {
    const db = openDb(path.join(tempDir, "b1.db"));
    try {
      seedProject(db, "proj-a", "Alpha", "alpha-key");
      seedProject(db, "proj-b", "Beta", "beta-key");
      createSpace(db, { project_id: "proj-a", title: "Space A" });
      createSpace(db, { project_id: "proj-b", title: "Space B" });

      const groups = listSpacesGrouped(db);
      const projA = groups.find((g) => g.project_id === "proj-a");
      const projB = groups.find((g) => g.project_id === "proj-b");
      expect(projA).toBeDefined();
      expect(projA!.project_key).toBe("alpha-key");
      expect(projB).toBeDefined();
      expect(projB!.project_key).toBe("beta-key");
    } finally {
      db.close();
    }
  });

  it("emits project_key null when the ledger row has an empty key (unbackfilled)", () => {
    // Rows inserted without project_key default to '' per the migration schema.
    // listSpacesGrouped converts '' to null so callers get a clean null instead.
    const db = openDb(path.join(tempDir, "b2.db"));
    try {
      // seedProject with no key argument → project_key = ''
      seedProject(db, "proj-nokey", "NoKey", "");
      createSpace(db, { project_id: "proj-nokey", title: "Space" });

      const groups = listSpacesGrouped(db);
      const g = groups.find((g) => g.project_id === "proj-nokey");
      expect(g).toBeDefined();
      expect(g!.project_key).toBeNull();
    } finally {
      db.close();
    }
  });

  it("emits project_key null for the top-level group", () => {
    const db = openDb(path.join(tempDir, "b3.db"));
    try {
      createSpace(db, { title: "Top" });
      const groups = listSpacesGrouped(db);
      expect(groups[0].project_id).toBeNull();
      expect(groups[0].project_key).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Colliding display_names yield distinguishable labels
// ---------------------------------------------------------------------------

describe("(c) two rows sharing a display_name yield distinguishable project_name labels", () => {
  it("appends (project_key) to disambiguate when two projects share the same display_name", () => {
    const db = openDb(path.join(tempDir, "c1.db"));
    try {
      seedProject(db, "proj-foo-1", "Shared Name", "foo-1");
      seedProject(db, "proj-foo-2", "Shared Name", "foo-2");
      createSpace(db, { project_id: "proj-foo-1", title: "Space 1" });
      createSpace(db, { project_id: "proj-foo-2", title: "Space 2" });

      const groups = listSpacesGrouped(db);
      const labels = groups
        .filter((g) => g.project_id !== null)
        .map((g) => g.project_name);

      // Both groups must be present with distinct labels.
      expect(labels).toHaveLength(2);
      expect(labels[0]).not.toBe(labels[1]);
      // Each label should include the project_key as disambiguator.
      expect(labels.every((l) => l?.startsWith("Shared Name"))).toBe(true);
      expect(labels).toContain("Shared Name (foo-1)");
      expect(labels).toContain("Shared Name (foo-2)");
    } finally {
      db.close();
    }
  });

  it("does NOT collapse distinct project_id rows into a single group for matching display_name", () => {
    const db = openDb(path.join(tempDir, "c2.db"));
    try {
      seedProject(db, "dup-1", "Duplicate", "dup-key-1");
      seedProject(db, "dup-2", "Duplicate", "dup-key-2");
      createSpace(db, { project_id: "dup-1", title: "A" });
      createSpace(db, { project_id: "dup-2", title: "B" });

      const groups = listSpacesGrouped(db).filter((g) => g.project_id !== null);
      // Two distinct groups, never merged.
      expect(groups).toHaveLength(2);
      expect(groups.map((g) => g.project_id).sort()).toEqual(["dup-1", "dup-2"]);
    } finally {
      db.close();
    }
  });

  it("falls back to id prefix when project_key is empty and display_name collides", () => {
    const db = openDb(path.join(tempDir, "c3.db"));
    try {
      // Both rows have no project_key (empty string default). Use IDs with
      // distinct 8-char prefixes so the id-prefix fallback disambiguates them.
      seedProject(db, "aaaa1111-clash", "Clash", "");
      seedProject(db, "bbbb2222-clash", "Clash", "");
      createSpace(db, { project_id: "aaaa1111-clash", title: "F" });
      createSpace(db, { project_id: "bbbb2222-clash", title: "B" });

      const groups = listSpacesGrouped(db).filter((g) => g.project_id !== null);
      expect(groups).toHaveLength(2);
      // Labels should be distinct (id prefix used as suffix).
      expect(groups[0].project_name).not.toBe(groups[1].project_name);
      // Both should start with the shared display_name.
      expect(groups.every((g) => g.project_name?.startsWith("Clash"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does NOT disambiguate when display_names are unique (no suffix appended)", () => {
    const db = openDb(path.join(tempDir, "c4.db"));
    try {
      seedProject(db, "u1", "Unique Alpha", "u-alpha");
      seedProject(db, "u2", "Unique Beta", "u-beta");
      createSpace(db, { project_id: "u1", title: "S1" });
      createSpace(db, { project_id: "u2", title: "S2" });

      const groups = listSpacesGrouped(db).filter((g) => g.project_id !== null);
      const gAlpha = groups.find((g) => g.project_id === "u1");
      const gBeta = groups.find((g) => g.project_id === "u2");
      // No suffix when display_names are unique.
      expect(gAlpha!.project_name).toBe("Unique Alpha");
      expect(gBeta!.project_name).toBe("Unique Beta");
    } finally {
      db.close();
    }
  });
});
