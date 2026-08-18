import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = path.resolve("scripts/demo-briefing.mjs");
const { PRODUCTION_DB_PATH } = createRequire(import.meta.url)("../cli/production-db-guard.cjs");

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-rich-briefing-demo-"));
  roots.push(root);
  return root;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("rich Briefing demo seed command", () => {
  it("requires a non-existing absolute path and rejects managed preview roots", () => {
    expect(run([])).toMatchObject({ status: 1, stderr: expect.stringContaining("explicit absolute") });
    expect(run(["--db", "relative.db"])).toMatchObject({ status: 1, stderr: expect.stringContaining("absolute path") });
    const root = tempRoot();
    const existing = path.join(root, "existing.db");
    fs.writeFileSync(existing, "occupied");
    expect(run(["--db", existing])).toMatchObject({ status: 1, stderr: expect.stringContaining("already exists") });
    const previewRoot = path.join(root, "managed-previews");
    expect(run(["--db", path.join(previewRoot, "fixture.db")], { MANDIBLE_PREVIEW_BASE_DIR: previewRoot }))
      .toMatchObject({ status: 1, stderr: expect.stringContaining("managed preview root") });
    expect(run(["--db", PRODUCTION_DB_PATH]))
      .toMatchObject({ status: 1, stderr: expect.stringContaining("production database path") });
  });

  it("creates the exact two-round semantic state and a useful JSON manifest", () => {
    const root = tempRoot();
    const target = path.join(root, "rich-briefing.db");
    const result = run(["--db", target, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest).toMatchObject({
      schema: "mandible-rich-briefing-demo@1",
      database_path: path.join(fs.realpathSync.native(root), path.basename(target)),
      briefing: { title: "Release candidate readiness review" },
      semantic_state: {
        round_one_answers: { "scope.approval": "keep", "rollback.plan": "dismiss", "operator.runbook": "keep" },
        round_one_annotation_kinds: ["comment", "suggest_replacement"],
        round_two_answers: 0,
        round_two_annotations: 0,
        round_two_submission: null,
      },
    });
    expect(manifest.rounds).toHaveLength(2);
    expect(manifest.rounds[0].artifact_version_id).not.toBe(manifest.rounds[1].artifact_version_id);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(`${target}.artifacts`)).toBe(true);
    const db = new Database(target, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefings").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get()).toEqual({ n: 1 });
    db.close();
  });
});
