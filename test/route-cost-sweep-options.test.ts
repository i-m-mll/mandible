import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseSweepOptions } from "../scripts/route-cost-sweep.ts";
import { acceptanceOwnedOutputs, routeCostSweepArgs } from "../scripts/candidate-acceptance.mjs";
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from "../scripts/owned-run.mjs";

it("keeps the standalone default and parses an explicit working root", () => {
  expect(parseSweepOptions([])["work-root"]).toBeUndefined();
  expect(parseSweepOptions(["--work-root", "/tmp/sweep work", "--json"])).toMatchObject({ "work-root": "/tmp/sweep work", json: true });
  expect(() => parseSweepOptions(["--work-root"])).toThrow();
});

it("reclaims interrupted sweep data and authority through acceptance ownership", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-sweep-"));
  const run = path.join(base, "run");
  fs.mkdirSync(run);
  try {
    const args = routeCostSweepArgs(run);
    const options = parseSweepOptions(args.slice(2));
    const workRoot = options["work-root"]!;
    expect(acceptanceOwnedOutputs).toContainEqual({ path: path.relative(run, workRoot), kind: "generated" });
    const sweep = path.join(workRoot, "run-interrupted");
    fs.mkdirSync(path.join(sweep, "preview-authority", "client-auth"), { recursive: true });
    fs.writeFileSync(path.join(sweep, "mandible.db"), "copied ledger");
    fs.writeFileSync(path.join(sweep, "preview-authority", "client-auth", "secret"), "private credential");
    const ownership = createOwnedRun({ root: run, instanceId: "acceptance-test", project: "project", workUnit: "work-unit", disposable: true, outputs: acceptanceOwnedOutputs });
    const metadata = path.join(run, "metadata.json");
    const inspect = () => ({ idle: true });
    saveOwnedMetadata(metadata, { ownership });
    finalizeOwnedRun(metadata, { expectedRevision: ownership.revision, outcome: "failed", summary: "Sweep supervisor deadline" }, { inspect });
    expect(cleanupOwnedRun(metadata, { apply: true, inspect })).toMatchObject({ action: "delete-owned", remaining: [] });
    expect(fs.existsSync(sweep)).toBe(false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
