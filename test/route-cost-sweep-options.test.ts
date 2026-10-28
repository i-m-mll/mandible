import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseSweepOptions, planRoute, representativeResponse, selectRepresentatives } from "../scripts/route-cost-sweep.ts";
import { acceptanceOwnedOutputs, routeCostSweepArgs } from "../scripts/candidate-acceptance.mjs";
import { acceptanceDeadline } from "../scripts/acceptance-deadline.mjs";
import { runSupervisedCommand } from "../scripts/process-group-supervisor.mjs";
import { createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from "../scripts/owned-run.mjs";


it("reclaims interrupted sweep data and authority through acceptance ownership", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-sweep-"));
  const run = path.join(base, "run");
  fs.mkdirSync(run);
  try {
    const args = routeCostSweepArgs(run);
    const options = parseSweepOptions(args.slice(2));
    expect(options.representative).toBe(true);
    expect(options["budget-ms"]).toBe("20000");
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

it("finalizes failed source evidence without claiming a package pass and preserves the receipt after cleanup", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-finalization-"));
  const run = path.join(cache, "run");
  fs.mkdirSync(run);
  fs.mkdirSync(path.join(run, "home"));
  fs.writeFileSync(path.join(run, "home", "fixture"), "generated fixture");
  const ownership = createOwnedRun({ root: run, instanceId: "finalization-test", project: "project", workUnit: "unit", disposable: true, outputs: acceptanceOwnedOutputs });
  const metadataFile = path.join(run, "metadata.json");
  saveOwnedMetadata(metadataFile, { ownership });
  const budget = acceptanceDeadline({});
  try {
    const input = path.join(run, "finalization.json");
    saveOwnedMetadata(input, { metadataFile, run, cache, ownership, deadlineEnv: budget.env,
      result: { status: "failed", candidate: "candidate", error: "request failed", checks: {}, phases: { finalization: { status: "running", started_at: Date.now() } }, budget: { ...budget.reading(), scope: "candidate-script" } },
    });
    const completed = await runSupervisedCommand(process.execPath, [path.resolve("scripts/candidate-acceptance.mjs"), "--finalize-owned-run", input], {
      capture: true, maxBuffer: 1024 * 1024, timeout: 2000, graceMs: 250, deadline: Date.now() + 3000,
    });
    const result = JSON.parse(completed.stdout);
    expect(result.status).toBe("failed");
    expect(result.checks.cleanup).toMatchObject({ action: "delete-owned", remaining: [] });
    expect(fs.existsSync(path.join(run, "home", "fixture"))).toBe(false);
    const receipt = JSON.parse(fs.readFileSync(result.receipt, "utf8"));
    expect(receipt.acceptance).toMatchObject({ status: "failed", budget: { scope: "candidate-script" }, phases: { finalization: { status: "passed" } } });
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});

it("requires the whole catalog to be classified and every release family to be available", () => {
  const fixtures = { bigConversation: "large", conversations: ["large"], projectKey: "project", umbrella: "umbrella", session: "session", briefing: "briefing", searchWord: "daemon", project: "project" } as any;
  const routes = [
    "POST /api/timeline/project", "GET /api/graph", "GET /api/artifacts", "GET /api/artifacts/series", "GET /api/auth/queue",
    "GET /api/ledger/issues/:issueId/umbrella-status", "GET /api/sessions/:id/overview", "GET /api/briefings/:briefingId",
    "GET /api/conversations/sidebar", "GET /api/conversations/:id/structure", "GET /api/conversations/:id/blocks", "GET /api/work-units",
  ].map(key => {
    const [method, routePath] = key.split(" ");
    const route = { method, path: routePath, operationId: key, operationalMutationCategory: null, effects: [] };
    return { route, plan: planRoute(route, new Set(), fixtures), measured: [] };
  });
  const chosen = selectRepresentatives(routes, fixtures).filter(entry => entry.plan.kind === "exercise");
  expect(chosen.flatMap(entry => entry.plan.kind === "exercise" ? entry.plan.requests : []).map(request => request.url)).toContain("/api/conversations/large/blocks?limit=200");
  expect(() => selectRepresentatives(routes.slice(1), fixtures)).toThrow("Required families absent");
  expect(() => selectRepresentatives([{ ...routes[0], plan: { kind: "skip", reason: "missing data" } }, ...routes.slice(1)], fixtures)).toThrow("Required family unavailable");
  expect(() => selectRepresentatives([...routes, { ...routes[0], plan: { kind: "unclassified", reason: "new mutation" } }], fixtures)).toThrow("Unclassified catalog");
});

it("uses real paging metadata for one advancing continuation and records selected counts", () => {
  const request = { label: "blocks", url: "/api/conversations/large/blocks?limit=200" };
  const page = representativeResponse(request, { blocks: [{}, {}], total: 3, offset: 0, limit: 2, truncated: true });
  expect(page.evidence).toMatchObject({ returned: { blocks: 2 }, total: 3, offset: 0 });
  expect(page.continuation?.url).toBe("/api/conversations/large/blocks?limit=200&offset=2");
  const timeline = { label: "closed", url: "/api/timeline/project", body: { include_closed: true } };
  expect(representativeResponse(timeline, { rows: [{}, {}], events: [], page: { row_offset: 0, next_row_offset: 1 } }).continuation?.body)
    .toEqual({ include_closed: true, row_offset: 1 });
  expect(representativeResponse(timeline, { rows: [], page: { row_offset: 0, next_row_offset: null } }).continuation).toBeUndefined();
  expect(() => representativeResponse(timeline, { page: { row_offset: 1, next_row_offset: 1 } })).toThrow("did not advance");
  expect(representativeResponse({ label: "sidebar", url: "/api/conversations/sidebar?limit=50" }, {
    groups: [{ key: "project-a", conversations: [{}], total: 51, next_cursor: "next" }],
  }).continuation?.url).toBe("/api/conversations/sidebar?limit=50&group_key=project-a&cursor=next");
});
