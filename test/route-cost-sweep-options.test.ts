import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { planRoute, representativeResponse, selectRepresentatives } from "../scripts/route-cost-sweep.ts";
import { runSupervisedCommand } from "../scripts/process-group-supervisor.mjs";


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

it("starts measurement preparation under elevated historical load and still rejects incomplete source data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-load-context-"));
  const preload = path.join(root, "load.mjs");
  const report = path.join(root, "report.json");
  fs.writeFileSync(preload, "import os from 'node:os'; os.loadavg = () => [140, 140, 140]; os.availableParallelism = () => 14;\n");
  try {
    await expect(runSupervisedCommand(process.execPath, ["--preload", preload, path.resolve("scripts/route-cost-sweep.ts"),
      "--representative", "--budget-ms", "10000", "--work-root", root, "--report-file", report,
      "--source-db", path.join(root, "missing.db"), "--json"], {
      env: { ...process.env, MANDIBLE_SWEEP_WORKER: "1" }, capture: true, timeout: 3000, graceMs: 100,
    })).rejects.toMatchObject({ exitCode: 2, processGroupSettled: true });
    expect(JSON.parse(fs.readFileSync(report, "utf8"))).toMatchObject({ complete: false,
      error: expect.stringContaining("source ledger does not exist"), load: { start: 140, end: 140, cpus: 14 },
      progress: { phase_ms: { snapshot: expect.any(Number) } },
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('finalizes failed supervised measurement scratch and preserves its external report and cleanup receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-owned-failure-'));
  const report = path.join(root, 'report.json');
  try {
    await expect(runSupervisedCommand(process.execPath, [path.resolve('scripts/route-cost-sweep.ts'), '--representative', '--budget-ms', '10000',
      '--work-root', root, '--report-file', report, '--source-db', path.join(root, 'missing.db')], { capture: true, timeout: 4000, graceMs: 100 }))
      .rejects.toMatchObject({ exitCode: 2, processGroupSettled: true });
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toMatchObject({ complete: false, root: null, progress: { cleanup_complete: true } });
    expect(fs.readdirSync(root).filter(name => name.startsWith('owned-'))).toEqual([]);
    const receipts = fs.readdirSync(path.join(root, '.receipts'));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.receipts', receipts[0]), 'utf8'))).toMatchObject({ outcome: 'failed', cleanup: 'completed' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
