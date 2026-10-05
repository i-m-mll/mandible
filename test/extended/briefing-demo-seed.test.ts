import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = path.resolve("scripts/demo-briefing.mjs");
const { PRODUCTION_DB_PATH } = createRequire(import.meta.url)("../../cli/production-db-guard.cjs");

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
      schema: "mandible-rich-briefing-demo@2",
      database_path: path.join(fs.realpathSync.native(root), path.basename(target)),
      briefing: { title: "Release candidate readiness review" },
      semantic_state: {
        round_one_answer_shapes: {
          "release.verdict": "verdict",
          "release.posture": "single_choice",
          "release.residual_risks": "multi_choice",
          "release.owner": "short_text",
          "release.rationale": "long_text",
          "release.confidence": "rating",
        },
        round_one_annotation_kinds: ["comment", "suggest_replacement"],
        round_one_frozen_answer_count: 6,
        round_one_frozen_annotation_count: 2,
        round_two_answers: 0,
        round_two_annotations: 0,
        round_two_submission: null,
        material_revision: true,
      },
    });
    expect(manifest.rounds).toHaveLength(2);
    const types = ["verdict", "single_choice", "multi_choice", "short_text", "long_text", "rating"];
    expect(manifest.rounds.map((round: any) => round.directive_types)).toEqual([types, types]);
    expect(manifest.rounds.map((round: any) => [round.directive_count, round.answer_count, round.annotation_count, round.submitted]))
      .toEqual([[6, 6, 2, true], [6, 0, 0, false]]);
    expect(manifest.rounds[0].artifact_version_id).not.toBe(manifest.rounds[1].artifact_version_id);
    expect(manifest.rounds[0].document_digest).not.toBe(manifest.rounds[1].document_digest);
    expect(result.stdout).not.toContain("Mina Chen");
    expect(result.stdout).not.toContain("Proceed with guarded monitoring");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(`${target}.artifacts`)).toBe(true);
    const db = new SqliteDatabase(target, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefings").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get()).toEqual({ n: 1 });
    const definitions = db.prepare(
      `SELECT r.ordinal, d.response_type, d.prompt, d.options_json, d.definition_digest
         FROM briefing_rounds r
         JOIN briefing_directive_instances i ON i.round_id = r.id
         JOIN briefing_directive_definitions d ON d.id = i.definition_id
        ORDER BY r.ordinal, i.position`,
    ).all() as Array<{ ordinal: number; response_type: string; prompt: string; options_json: string; definition_digest: string }>;
    expect(definitions.map((row) => row.response_type)).toEqual([...types, ...types]);
    expect(definitions.slice(0, 6).every((row, index) => row.prompt !== definitions[index + 6].prompt)).toBe(true);
    expect(definitions[1].options_json).toBe(JSON.stringify([
      { key: "guarded", label: "Guarded release with incident lead present" },
      { key: "normal", label: "Normal release monitoring" },
      { key: "hold", label: "Hold for another rehearsal" },
    ]));
    expect(definitions[7].options_json).not.toBe(definitions[1].options_json);
    expect(definitions[2].options_json).not.toBe(definitions[8].options_json);
    expect(definitions.every((row) => /^[0-9a-f]{64}$/.test(row.definition_digest))).toBe(true);
    const answerValues = (db.prepare(
      `SELECT e.value_json FROM briefing_response_events e
         JOIN briefing_directive_instances i ON i.id = e.directive_instance_id
         JOIN briefing_rounds r ON r.id = e.round_id
        WHERE r.ordinal = 1 AND e.operation = 'set' ORDER BY i.position`,
    ).all() as Array<{ value_json: string }>).map((row) => JSON.parse(row.value_json));
    expect(answerValues).toEqual([
      { verdict: "keep" },
      { option_key: "guarded" },
      { option_keys: ["alert-calibration", "rollback-handoff"] },
      { text: "Mina Chen — open the guarded window after the incident lead joins." },
      { text: "Proceed with guarded monitoring because the signed candidate, migration replay, and rollback rehearsal passed. Stop if paging misses the incident lead or rollback exceeds 15 minutes." },
      { rating: 4 },
    ]);
    const submission = db.prepare("SELECT id, round_id FROM briefing_submissions").get() as { id: string; round_id: string };
    const frozenAnswers = db.prepare(
      "SELECT response_event_id FROM briefing_submission_answers WHERE submission_id = ? ORDER BY position",
    ).all(submission.id) as Array<{ response_event_id: string }>;
    const frozenAnnotations = db.prepare(
      "SELECT annotation_event_id FROM briefing_submission_annotations WHERE submission_id = ? ORDER BY position",
    ).all(submission.id) as Array<{ annotation_event_id: string }>;
    expect(frozenAnswers).toHaveLength(6);
    expect(frozenAnnotations).toHaveLength(2);
    expect(frozenAnswers.map((row) => row.response_event_id).sort()).toEqual(
      (db.prepare("SELECT id FROM briefing_response_events WHERE round_id = ? AND operation = 'set'").all(submission.round_id) as Array<{ id: string }>)
        .map((row) => row.id).sort(),
    );
    expect(frozenAnnotations.map((row) => row.annotation_event_id).sort()).toEqual(
      (db.prepare("SELECT id FROM briefing_annotation_events WHERE round_id = ? AND operation = 'set'").all(submission.round_id) as Array<{ id: string }>)
        .map((row) => row.id).sort(),
    );
    const roundTwoId = manifest.rounds[1].id;
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM briefing_response_events WHERE round_id = ?) AS answers,
         (SELECT COUNT(*) FROM briefing_annotation_events WHERE round_id = ?) AS annotations,
         (SELECT COUNT(*) FROM briefing_submissions WHERE round_id = ?) AS submissions`,
    ).get(roundTwoId, roundTwoId, roundTwoId)).toEqual({ answers: 0, annotations: 0, submissions: 0 });
    const versionHashes = db.prepare("SELECT id, content_hash FROM artifact_version ORDER BY version_no").all() as Array<{ id: string; content_hash: string }>;
    expect(versionHashes).toEqual(manifest.rounds.map((round: any) => ({ id: round.artifact_version_id, content_hash: round.document_digest })));
    db.close();
  });
});
