// @vitest-environment node
// Grouped Spaces listing (issues 812df41, 6fdd924): top-level Spaces first, then
// one group per project that owns Spaces, each labelled distinguishably.

import { afterEach, beforeEach, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import {
  createSpace,
  listAllSpaces,
  listSpaces,
  listSpacesGrouped,
  listTopLevelSpaces,
} from "../src/ledger/spaces.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: Db;

function seedProject(id: string, name: string, projectKey = ""): string {
  db.prepare(
    `INSERT INTO ledger_projects (id, project_key, display_name, remote_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectKey, name, `github.com/test/${id}`, Date.now(), Date.now());
  return id;
}

beforeEach(() => {
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
});

it("lists top-level Spaces first, then projects by name, omitting projects without Spaces", () => {
  seedProject("proj-b", "Beta", "beta");
  seedProject("proj-a", "Alpha", "alpha");
  seedProject("proj-empty", "Empty", "empty");
  expect(listSpacesGrouped(db)).toEqual([]);

  const top1 = createSpace(db, { title: "Top One" });
  const top2 = createSpace(db, { title: "Top Two" });
  const a1 = createSpace(db, { project_id: "proj-a", title: "Alpha Space" });
  const b1 = createSpace(db, { project_id: "proj-b", title: "Beta Space" });

  const groups = listSpacesGrouped(db);
  expect(groups.map((g) => g.project_id)).toEqual([null, "proj-a", "proj-b"]);
  expect(groups[0].spaces.map((s) => s.id).sort()).toEqual([top1.id, top2.id].sort());
  expect(groups[1].spaces.map((s) => s.id)).toEqual([a1.id]);
  expect(groups[2].spaces.map((s) => s.id)).toEqual([b1.id]);

  expect(listTopLevelSpaces(db).map((s) => s.id).sort()).toEqual([top1.id, top2.id].sort());
  expect(listSpaces(db, "proj-a").map((s) => s.id)).toEqual([a1.id]);
  expect(listAllSpaces(db)).toHaveLength(4);
});

it("carries each project's key, null when unbackfilled and for the top-level group", () => {
  seedProject("proj-a", "Alpha", "alpha-key");
  seedProject("proj-nokey", "NoKey", "");
  createSpace(db, { title: "Top" });
  createSpace(db, { project_id: "proj-a", title: "Space A" });
  createSpace(db, { project_id: "proj-nokey", title: "Space N" });

  expect(listSpacesGrouped(db).map((g) => [g.project_id, g.project_key])).toEqual([
    [null, null],
    ["proj-a", "alpha-key"],
    ["proj-nokey", null],
  ]);
});

it("disambiguates colliding display names by key, then id prefix, and never merges their groups", () => {
  seedProject("proj-foo-1", "Shared Name", "foo-1");
  seedProject("proj-foo-2", "Shared Name", "foo-2");
  seedProject("aaaa1111-clash", "Clash", "");
  seedProject("bbbb2222-clash", "Clash", "");
  seedProject("u1", "Unique", "u-key");
  for (const id of ["proj-foo-1", "proj-foo-2", "aaaa1111-clash", "bbbb2222-clash", "u1"]) {
    createSpace(db, { project_id: id, title: `Space ${id}` });
  }

  const groups = listSpacesGrouped(db);
  expect(groups.map((g) => g.project_id).sort()).toEqual(
    ["aaaa1111-clash", "bbbb2222-clash", "proj-foo-1", "proj-foo-2", "u1"],
  );
  const label = (id: string) => groups.find((g) => g.project_id === id)?.project_name;
  expect(label("proj-foo-1")).toBe("Shared Name (foo-1)");
  expect(label("proj-foo-2")).toBe("Shared Name (foo-2)");
  expect(label("aaaa1111-clash")).not.toBe(label("bbbb2222-clash"));
  expect(label("aaaa1111-clash")).toMatch(/^Clash /);
  expect(label("u1")).toBe("Unique");
});
