import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import { resolveArtifactProject, resolveArtifactProjects } from "../src/permissions/resources.js";
import {
  canonicalArtifactBlobShortRefs,
  canonicalLogicalArtifactShortRefs,
  projectArtifactPublicValue,
} from "../src/provider-artifacts.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: Db;
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-ref-batching-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedBlob(hash: string): void {
  db.prepare("INSERT INTO artifact_blob(id, content_hash, created_at) VALUES (?, ?, 1)").run(`artifact-blob:${hash}`, hash);
}

function seedLogical(id: string): void {
  db.prepare("INSERT INTO artifact(id, identity_key, created_at, updated_at) VALUES (?, ?, 1, 1)").run(id, `key:${id}`);
}

/** Statements `fn` executes against `db`. */
function statementsRun(fn: () => void): number {
  let count = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => new Proxy(prepare(sql), {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "all" || property === "get" || property === "run" || property === "iterate") count += 1;
        return value.apply(target, args);
      };
    },
  })) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = prepare;
  }
  return count;
}

function recordVersions(count: number, offset: number) {
  return Array.from({ length: count }, (_, index) => recordArtifactVersion(db, {
    source_kind: "managed",
    provider_id: "test",
    content: `content ${offset + index}\n`,
    logical_name: `logical-${offset + index}`,
  }, 1000 + offset + index, tempDir));
}

function artifactRecords(recorded: ReturnType<typeof recordVersions>) {
  return recorded.flatMap((entry) => [
    { id: `artifact-blob:${entry.version.content_hash}`, content_hash: entry.version.content_hash },
    { id: entry.series.id, series_key: "series" },
    { id: entry.version.id, version_no: entry.version.version_no },
    { id: entry.series.id.replace(/^artifact-series:/, "artifact:"), identity_key: "logical" },
  ]);
}

describe("artifact short refs for a page", () => {
  it("lengthen past every shared prefix, across blobs and logical artifacts", () => {
    const shared = "0123456789abcdef";
    const first = `${shared}${"a".repeat(48)}`;
    const second = `${shared}${"b".repeat(48)}`;
    const lone = `fedcba987654${"1".repeat(52)}`;
    const missing = "9".repeat(64);
    for (const hash of [first, second, lone]) seedBlob(hash);
    const besideBlob = `artifact:fedcba987654${"0".repeat(20)}`;
    const alone = "artifact:22223333444455556666777788889999";
    seedLogical(besideBlob);
    seedLogical(alone);

    expect(canonicalArtifactBlobShortRefs(db, [first, `artifact-blob:${second}`, lone, missing])).toEqual([
      `artifact-blob:${first.slice(0, 17)}`,
      `artifact-blob:${second.slice(0, 17)}`,
      `artifact-blob:${lone.slice(0, 12)}`,
      `artifact-blob:${missing}`,
    ]);
    expect(canonicalLogicalArtifactShortRefs(db, [besideBlob, alone, "artifact:absent"])).toEqual([
      "artifact:fedcba9876540",
      "artifact:222233334444",
      "artifact:absent",
    ]);
  });

  it("cost the same number of statements for a dozen records as for a hundred", () => {
    const few = artifactRecords(recordVersions(3, 0));
    const many = artifactRecords(recordVersions(25, 100));
    projectArtifactPublicValue(db, few);

    const fewStatements = statementsRun(() => projectArtifactPublicValue(db, { artifacts: few }));
    const manyStatements = statementsRun(() => projectArtifactPublicValue(db, { artifacts: many }));

    expect(manyStatements).toBe(fewStatements);
  });
});

describe("artifact projects for a page", () => {
  it("resolve every id in one statement, as each id resolves alone", () => {
    const recorded = recordVersions(6, 0);
    const ids = recorded.flatMap((entry) => [
      entry.series.id.replace(/^artifact-series:/, "artifact:"),
      entry.version.id,
      `artifact-blob:${entry.version.content_hash}`,
    ]);

    let resolved = new Map<string, unknown>();
    expect(statementsRun(() => { resolved = resolveArtifactProjects(db, ids); })).toBe(1);
    expect([...resolved]).toEqual(ids.map((id) => [id, resolveArtifactProject(db, id)]));
  });
});
