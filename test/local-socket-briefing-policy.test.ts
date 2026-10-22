// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { addGrant } from "../src/permissions/store.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { registerBriefingRoutes } from "../src/routes/briefing.js";
import type { RequestLike, ResolvedClientIdentity, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";
import { createUser, setupOperator } from "../src/users/store.js";

let db: Db;
let root: string;
const routes = new Map<string, RouteHandler>();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(testRuntimeRoot, "socket-briefing-"));
  db = migratedMemoryDb();
  setSetting(db, "artifact_root", root);
  routes.clear();
  const add = (method: string) => (route: string, handler: RouteHandler) => {
    routes.set(`${method} ${route}`, handler);
  };
  registerBriefingRoutes({ get: add("GET"), post: add("POST"), put: add("PUT"),
    patch: add("PATCH"), delete: add("DELETE") } as RouteRegistrar, db);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function invoke(method: string, route: string, user: { id: string; slug: string },
  body: unknown = {}, params: Record<string, string> = {}) {
  const handler = routes.get(`${method} ${route}`)!;
  const req = {
    method, url: route, body, params, query: {}, managed_client: true,
    local_managed_identity: { app_name: "codex", session_id: "managed-session" },
    client_identity: { user_id: user.id, slug: user.slug, method: "local_socket",
      source: "local_socket", credential_id: null, effect_ceiling: [] } as ResolvedClientIdentity,
  } as RequestLike;
  let status = 200;
  let result: unknown;
  const res = { status(code: number) { status = code; return this; },
    json(value: unknown) { result = value; }, empty() { result = null; } } as ResponseLike;
  await handler(req, res);
  return { status, body: result as Record<string, unknown> };
}

it("allows managed app/session agents to create, rename and read ordinary Briefings while rejecting protected review", async () => {
  setupOperator(db, { slug: "operator", display_name: "Operator" });
  const agent = createUser(db, { slug: "codex", kind: "agent", display_name: "Codex" });
  const project = addProject(db, { project_key: "briefing-test", display_name: "Briefing test" });
  db.prepare("UPDATE ledger_projects SET restricted = 1 WHERE id = ?").run(project.id);
  addGrant(db, { subject_type: "user", subject: agent.id, resource_type: "project",
    resource: project.id, permission: "write" });
  const artifact = recordArtifactVersion(db, { source_kind: "managed", content: "# Report\n",
    series_key: "socket-report", logical_name: "report.md", role: "review-document", media_type: "text/markdown" });
  db.prepare(`INSERT INTO project_artifact_associations
    (id, project_id, target_type, target_id, association_kind, role, created_at, updated_at)
    VALUES ('socket-briefing-artifact', ?, 'artifact', ?, 'canonical', '', 1, 1)`)
    .run(project.id, artifact.artifact.reference.canonical_artifact_id);

  const created = await invoke("POST", "/api/briefings", agent,
    { artifact_version_ref: artifact.version.id, title: "Report" });
  expect(created.status).toBe(201);
  const id = created.body.briefing_id as string;
  const renamed = await invoke("PATCH", "/api/briefings/:briefingId", agent,
    { title: "Updated report" }, { briefingId: id });
  expect(renamed).toMatchObject({ status: 200, body: { title: "Updated report" } });
  const listed = await invoke("GET", "/api/briefings", agent);
  expect(listed.status).toBe(200);
  expect((listed.body.briefings as Array<{ id: string }>).map((item) => item.id)).toContain(id);
  const detail = await invoke("GET", "/api/briefings/:briefingId", agent, {}, { briefingId: id });
  expect(detail.status).toBe(200);
  const protectedReview = await invoke("POST", "/api/briefing-groups/:groupId/review-candidates", agent,
    {}, { groupId: "missing" });
  expect(protectedReview).toMatchObject({ status: 403,
    body: { code: "briefing_group_review_credential_required" } });
});
