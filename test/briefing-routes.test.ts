// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sse.js", () => ({ broadcast: vi.fn() }));

import { setSetting } from "../src/client-auth/settings-kv.js";
import { type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerBriefingRoutes } from "../src/routes/briefing.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { createUser } from "../src/users/store.js";
import { broadcast } from "../src/sse.js";
import { publishBriefingFromArtifactVersion } from "../src/feedback/briefings.js";
import { createBriefingBundle } from "../src/feedback/briefing-bundles.js";
import { bindBriefingDestinationOwner, createBriefingGroup } from "../src/feedback/briefing-groups.js";
import { registerBriefingDestinationRoute } from "../src/feedback/briefing-composer.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { addProject } from "../src/ledger/project-registry.js";
import { addGrant } from "../src/permissions/store.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";

class SlugGate implements ClientAuthGate {
  constructor(private readonly db: () => Db) {}
  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const ephemeral = credential.startsWith("session:");
    const slug = ephemeral ? credential.slice(8) : credential;
    const user = this.db().prepare("SELECT id, slug FROM users WHERE slug = ?")
      .get(slug) as { id: string; slug: string } | undefined;
    return user ? { user_id: user.id, slug: user.slug, method: ephemeral ? "ephemeral" : "api_token",
      credential_id: null, source: "in_process", effect_ceiling: PRODUCTION_EFFECTS } : null;
  }
  mode() { return "compat" as const; }
  recordUnattributedWrite() {}
}

let db: Db;
let router: Router;
let root: string;
let humanId: string;

function copiedPreviewInstance() {
  const previewRoot = path.join(root, "preview");
  const userPreferencesRoot = path.join(previewRoot, "settings", "users");
  fs.mkdirSync(userPreferencesRoot, { recursive: true });
  return resolveInstanceInfo({
    env: {
      MANDIBLE_INSTANCE_ROLE: "preview",
      MANDIBLE_INSTANCE_ID: "preview-briefing-routes",
      MANDIBLE_INSTALLATION_ID: "test-installation",
      MANDIBLE_PUBLIC_ORIGIN: "https://preview-briefing-routes.mandible.localhost:19421",
      MANDIBLE_BACKEND_GENERATION: "test-generation",
      MANDIBLE_PREVIEW_ROOT: previewRoot,
      MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(["ledger:read", "ledger:write", "files:preview"]),
      MANDIBLE_WRITABLE_ROOTS: JSON.stringify([previewRoot]),
      MANDIBLE_ARTIFACT_DIR: path.join(previewRoot, "artifacts"),
      MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR: path.join(root, "source", "artifacts"),
      MANDIBLE_USER_PREFERENCES_DIR: userPreferencesRoot,
    },
    dbPath: path.join(previewRoot, "preview.db"),
    sourceDbPath: path.join(root, "source", "source.db"),
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "mandible-briefing-run@1", briefing_key: "daily", title: "Daily",
    task_identity: "agent-schedule/daily-digest", run_id: "run-1", run_key: "key-1",
    responder_user_ids: [humanId],
    evidence: { series_ref: "artifact-series:digest", version: 1, digest: "a".repeat(64) },
    source_health: { source: "arxiv-scan", status: "healthy", detail: null, observed_at: 1 },
    document: { markdown: '# Daily\n\n:::spec-item{key="paper" type="verdict" required="true"}\nKeep it?\n:::\n' },
    quiet_reason: null,
    occurrences: [{ directive_key: "paper", evidence_digest: "b".repeat(64), occurred_at: 1, metadata: {} }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(broadcast).mockClear();
  root = fs.mkdtempSync(path.join(testRuntimeRoot, "briefing-routes-"));
  fs.mkdirSync(path.join(root, "source", "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(root, "preview", "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "source", "source.db"), "");
  fs.copyFileSync(path.join(root, "source", "source.db"), path.join(root, "preview", "preview.db"));
  db = migratedMemoryDb();
  setSetting(db, "artifact_root", path.join(root, "preview", "artifacts"));
  createUser(db, { slug: "agent-schedule", kind: "agent", display_name: "Publisher" });
  humanId = createUser(db, { slug: "human", kind: "human", display_name: "Human" }).id;
  router = new Router({ clientAuth: new SlugGate(() => db) });
  registerBriefingRoutes(router, db);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("plural Briefing routes", () => {
  it("places and moves a project-authorized report, then advances Current directly without disturbing review", async () => {
    setSetting(db, "user.operator_id", humanId);
    const project = addProject(db, { project_key: "reports", display_name: "Reports" });
    db.prepare("UPDATE ledger_projects SET restricted = 1 WHERE id = ?").run(project.id);
    const reviewed = recordArtifactVersion(db, { source_kind: "managed", content: "# Reviewed\n",
      series_key: "test:reviewed", logical_name: "Reviewed.md", role: "briefing-document",
      media_type: "text/markdown" });
    const report = recordArtifactVersion(db, { source_kind: "managed",
      content: "# Maintenance\n\n## Findings\n\nFirst.\n", series_key: "test:direct-report",
      logical_name: "Maintenance.md", role: "briefing-document", media_type: "text/markdown" });
    const reviewBriefing = publishBriefingFromArtifactVersion(db, { title: "Reviewed",
      artifact_version_ref: reviewed.version.id, profile: "mandible-briefing.v3", responder_user_ids: [humanId] });
    const reportBriefing = publishBriefingFromArtifactVersion(db, { title: "Maintenance",
      artifact_version_ref: report.version.id, profile: "mandible-briefing.v3", responder_user_ids: [humanId] });
    if (reviewBriefing.outcome === "active_candidates" || reportBriefing.outcome === "active_candidates") {
      throw new Error("fixture conflict");
    }
    const logical = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?")
      .get(report.version.id) as { artifact_id: string };
    const viewer = { userId: humanId, operator: true };
    const base = createBriefingBundle(db, { name: "Digest", briefingRefs: [reviewBriefing.briefing_id], viewer });
    const proposal = createBriefingBundle(db, { name: "Review proposal",
      briefingRefs: [reportBriefing.briefing_id], viewer });
    const digest = createBriefingGroup(db, { key: "digest", name: "Digest", currentBundleRef: base.id,
      bundleRefs: [proposal.id], viewer });
    const otherBase = createBriefingBundle(db, { name: "Other", briefingRefs: [], viewer });
    const other = createBriefingGroup(db, { key: "other", name: "Other", currentBundleRef: otherBase.id,
      bundleRefs: [], viewer });
    const route = { route_key: "digest.repository-maintenance", logical_artifact_ref: logical.artifact_id,
      publication_mode: "published-report", heading: "Findings", composer_kind: "agentic",
      template: { version: 1, contribution_template: "", slots: {} },
      limits: { max_contributions: 10, max_document_bytes: 100_000, max_directives: 0 } };
    const endpoint = `/api/briefing-groups/${digest.id}/report-placement`;
    const placement = { operation_key: "place-1", logical_artifact_ref: logical.artifact_id,
      briefing_ref: reportBriefing.briefing_id, expected_owner_group_ref: null,
      expected_target_base_ref: base.id, expected_source_base_ref: null, route };
    expect(await router.invoke({ method: "POST", url: endpoint, credential: "agent-schedule", body: placement }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_project_unresolved" } });
    db.prepare(`INSERT INTO project_artifact_associations
      (id, project_id, target_type, target_id, association_kind, role, created_at, updated_at)
      VALUES ('report-association', ?, 'artifact', ?, 'canonical', '', 1, 1)`)
      .run(project.id, logical.artifact_id);
    expect(await router.invoke({ method: "POST", url: endpoint, credential: "agent-schedule", body: placement }))
      .toMatchObject({ status: 403, body: { code: "project_permission_required" } });
    addGrant(db, { subject_type: "user", subject: "agent-schedule", resource_type: "project",
      resource: "reports", permission: "write" });
    expect(await router.invoke({ method: "POST", url: endpoint, credential: "agent-schedule",
      body: { ...placement, operation_key: "failed-route", route: { ...route, composer_kind: "deterministic" } } }))
      .toMatchObject({ status: 400 });
    expect(db.prepare("SELECT group_id FROM briefing_destination_owners WHERE logical_artifact_id = ?")
      .get(logical.artifact_id)).toBeUndefined();
    expect(db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?")
      .get(digest.id)).toEqual({ current_bundle_id: base.id });
    const placed = await router.invoke({ method: "POST", url: endpoint, credential: "agent-schedule", body: placement });
    expect(placed).toMatchObject({ status: 200, body: { changed: true, route_changed: true, group_id: digest.id } });
    expect(await router.invoke({ method: "POST", url: endpoint, credential: "agent-schedule", body: placement }))
      .toMatchObject({ status: 200, body: { changed: false } });
    expect(await router.invoke({ method: "POST", url: endpoint, credential: "agent-schedule",
      body: { ...placement, route: { ...route, heading: "Other" } } }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_replay_conflict" } });
    const placedBase = (placed.body as { target_base_bundle_id: string }).target_base_bundle_id;
    expect(db.prepare("SELECT bundle_id FROM briefing_group_updates WHERE group_id = ?")
      .get(digest.id)).toEqual({ bundle_id: proposal.id });
    expect(db.prepare("SELECT briefing_id FROM briefing_bundle_members WHERE bundle_id = ? ORDER BY layout_position")
      .all(placedBase)).toEqual([{ briefing_id: reviewBriefing.briefing_id },
        { briefing_id: reportBriefing.briefing_id }]);
    const roundUrl = `/api/briefings/${reportBriefing.briefing_id}/report-rounds`;
    let previousRound = reportBriefing.round_id;
    let previousVersion = report.version.id;
    for (let index = 1; index <= 2; index++) {
      const next = recordArtifactVersion(db, { source_kind: "managed",
        content: `# Maintenance\n\n## Findings\n\nUpdate ${index}.\n`, series_key: "test:direct-report",
        logical_name: "Maintenance.md", role: "briefing-document", media_type: "text/markdown" });
      const body = { operation_key: `update-${index}`, artifact_version_ref: next.version.id,
        expected_current_round_id: previousRound, expected_current_artifact_version_ref: previousVersion };
      const published = await router.invoke({ method: "POST", url: roundUrl,
        credential: "agent-schedule", body });
      expect(published).toMatchObject({ status: 200, body: { changed: true,
        briefing_id: reportBriefing.briefing_id, previous_round_id: previousRound } });
      expect(await router.invoke({ method: "POST", url: roundUrl, credential: "agent-schedule", body }))
        .toMatchObject({ status: 200, body: { changed: false } });
      previousRound = (published.body as { round_id: string }).round_id;
      previousVersion = next.version.id;
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds WHERE briefing_id = ?")
      .get(reportBriefing.briefing_id)).toEqual({ n: 3 });
    expect(db.prepare("SELECT latest_round_id FROM briefings WHERE id = ?").get(reviewBriefing.briefing_id))
      .toEqual({ latest_round_id: reviewBriefing.round_id });
    expect(await router.invoke({ method: "POST", url: roundUrl, credential: "agent-schedule",
      body: { operation_key: "stale-round", artifact_version_ref: previousVersion,
        expected_current_round_id: reportBriefing.round_id,
        expected_current_artifact_version_ref: report.version.id } }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_current_drift" } });
    expect(await router.invoke({ method: "PUT", url: `/api/briefing-groups/${digest.id}/configuration`,
      credential: "agent-schedule", body: { current_bundle_ref: placedBase, bundle_refs: [] } }))
      .toMatchObject({ status: 200, body: { changed: true } });
    const moved = await router.invoke({ method: "POST", url: `/api/briefing-groups/${other.id}/report-placement`,
      credential: "agent-schedule", body: { operation_key: "move-1", logical_artifact_ref: logical.artifact_id,
        briefing_ref: reportBriefing.briefing_id, expected_owner_group_ref: digest.id,
        expected_target_base_ref: otherBase.id, expected_source_base_ref: placedBase } });
    expect(moved).toMatchObject({ status: 200, body: { changed: true, group_id: other.id } });
    expect(db.prepare("SELECT group_id, bound_by_user_id FROM briefing_destination_owners WHERE logical_artifact_id = ?")
      .get(logical.artifact_id)).toEqual({ group_id: other.id,
        bound_by_user_id: db.prepare("SELECT id FROM users WHERE slug = 'agent-schedule'").get()?.id });
    expect(await router.invoke({ method: "POST", url: endpoint, credential: "agent-schedule",
      body: { ...placement, operation_key: "stale" } }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_owner_drift" } });
    const routePlan = await router.invoke({ method: "POST", url: "/api/briefing-destination-routes/plan",
      credential: "agent-schedule", body: { schema: "mandible-briefing-destination-routes@3", routes: [route] } });
    expect(routePlan).toMatchObject({ status: 200, body: {
      routes: [{ group_id: other.id, action: "unchanged", current_revision: expect.any(String) }] } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes",
      credential: "agent-schedule", body: { schema: "mandible-briefing-destination-routes@3",
        routes: [{ ...route, heading: "Elsewhere" }] } }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_route_conflict" } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes",
      credential: "agent-schedule", body: { schema: "mandible-briefing-destination-routes@3",
        routes: [{ ...route, template: { ...route.template, contribution_template: "different" } }] } }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_template_conflict" } });
    const updatedRoute = { ...route, expected_revision: (routePlan.body as {
      routes: Array<{ current_revision: string }> }).routes[0].current_revision,
      limits: { ...route.limits, max_contributions: 12 } };
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes",
      credential: "agent-schedule", body: { schema: "mandible-briefing-destination-routes@3",
        routes: [updatedRoute] } })).toMatchObject({ status: 200, body: {
      changed: true, routes: [{ action: "update" }] } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes",
      credential: "agent-schedule", body: { schema: "mandible-briefing-destination-routes@3",
        routes: [{ ...updatedRoute, limits: { ...route.limits, max_contributions: 13 } }] } }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_route_revision_drift" } });
    db.prepare(`DELETE FROM permission_grants WHERE resource_id = ? AND permission = 'write'`).run(project.id);
    expect(await router.invoke({ method: "POST", url: roundUrl, credential: "agent-schedule",
      body: { operation_key: "denied", artifact_version_ref: previousVersion,
        expected_current_round_id: previousRound, expected_current_artifact_version_ref: previousVersion } }))
      .toMatchObject({ status: 403, body: { code: "project_permission_required" } });
    addGrant(db, { subject_type: "user", subject: "agent-schedule", resource_type: "project",
      resource: "reports", permission: "write" });
    const conflictingProject = addProject(db, { project_key: "other-reports", display_name: "Other reports" });
    db.prepare(`INSERT INTO project_artifact_associations
      (id, project_id, target_type, target_id, association_kind, role, created_at, updated_at)
      VALUES ('other-report-association', ?, 'artifact', ?, 'associated', '', 1, 1)`)
      .run(conflictingProject.id, logical.artifact_id);
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes/plan",
      credential: "agent-schedule", body: { schema: "mandible-briefing-destination-routes@3", routes: [route] } }))
      .toMatchObject({ status: 409, body: { code: "briefing_destination_project_unresolved" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_destination_mutations WHERE actor_user_id = ?")
      .get(db.prepare("SELECT id FROM users WHERE slug = 'agent-schedule'").get()?.id)).toEqual({ n: 5 });
  });
  it("guards deterministic destination-route plan, apply, replay, and inspect behind the operator token", async () => {
    setSetting(db, "user.operator_id", humanId);
    const source = path.join(root, "destination.md");
    fs.writeFileSync(source, "# Digest\n\n## Since last review\n");
    const recorded = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "destination.md", role: "briefing-document", media_type: "text/markdown" });
    const published = publishBriefingFromArtifactVersion(db, {
      briefing_key: "destination-base", artifact_version_ref: recorded.version.id, title: "Digest",
      profile: "mandible-briefing.v3", responder_user_ids: [humanId],
    }, 100);
    if (published.outcome === "active_candidates") throw new Error("destination fixture conflicted");
    const logical = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?").get(recorded.version.id) as
      { artifact_id: string };
    const project = addProject(db, { project_key: "destination", display_name: "Destination" });
    db.prepare(`INSERT INTO project_artifact_associations
      (id, project_id, target_type, target_id, association_kind, role, created_at, updated_at)
      VALUES ('destination-association', ?, 'artifact', ?, 'canonical', '', 1, 1)`)
      .run(project.id, logical.artifact_id);
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Digest Base", briefingRefs: [published.briefing_id], viewer }, 110);
    const group = createBriefingGroup(db, { key: "digest", name: "Digest", currentBundleRef: bundle.id,
      bundleRefs: [], viewer }, 120);
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${group.id}/destinations`,
      credential: "human", body: { logical_artifact_ref: logical.artifact_id } })).toMatchObject({
      status: 201, body: { group: { destinations: [{ logical_artifact_id: logical.artifact_id }] } },
    });
    const manifest = {
      schema: "mandible-briefing-destination-routes@3",
      routes: [{ route_key: "digest.since-last-review",
        logical_artifact_ref: logical.artifact_id, publication_mode: "reviewed-document", heading: "Since last review",
        composer_kind: "agentic", template: { version: 1, contribution_template: "", slots: {} },
        limits: { max_contributions: 10, max_document_bytes: 100_000, max_directives: 0 } }],
    };

    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes/plan",
      body: manifest })).toMatchObject({ status: 401, body: { code: "authentication_required" } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes/plan",
      credential: "session:human", body: manifest })).toMatchObject({ status: 403,
      body: { code: "briefing_destination_route_credential_required" } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes/plan",
      credential: "agent-schedule", body: manifest })).toMatchObject({ status: 200,
      body: { changed: true } });
    const rejectMode = new Router({
      clientAuth: new SlugGate(() => db),
      instance: copiedPreviewInstance(),
    });
    registerBriefingRoutes(rejectMode, db);
    expect(await rejectMode.invoke({ method: "POST", url: "/api/briefing-destination-routes/plan",
      credential: "human", body: manifest })).toMatchObject({ status: 200, body: { changed: true } });
    expect(await rejectMode.invoke({ method: "POST", url: "/api/briefing-destination-routes",
      credential: "human", body: manifest })).toMatchObject({ status: 200,
      body: { changed: true, routes: [{ action: "create" }] } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes/plan",
      credential: "human", body: manifest })).toMatchObject({ status: 200, body: { changed: false,
      routes: [{ action: "unchanged", group_id: group.id, logical_artifact_id: logical.artifact_id }] } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_destination_routes").get()).toEqual({ n: 1 });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes",
      credential: "human", body: manifest })).toMatchObject({ status: 200, body: { changed: false,
      routes: [{ action: "unchanged" }] } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-destination-routes",
      credential: "human", body: manifest })).toMatchObject({ status: 200, body: { changed: false,
      routes: [{ action: "unchanged" }] } });
    expect(await router.invoke({ method: "GET", url: "/api/briefing-destination-routes/digest.since-last-review",
      credential: "human" })).toMatchObject({ status: 200, body: { routes: [{
      route_key: "digest.since-last-review", active_template_version: 1, templates: [{ version: 1 }],
    }] } });
  });

  it("archives and restores a group through durable authorization without cascading member lifecycle", async () => {
    setSetting(db, "user.operator_id", humanId);
    const source = path.join(root, "group.md");
    fs.writeFileSync(source, "# Group\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "group.md", role: "review-document", media_type: "text/markdown" }).version;
    const published = publishBriefingFromArtifactVersion(db, {
      briefing_key: "group-member", artifact_version_ref: version.id, title: "Group member",
      profile: "mandible-briefing.v3", responder_user_ids: [humanId],
    }, 100);
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Base", briefingRefs: [published.briefing_id], viewer }, 110);
    const group = createBriefingGroup(db, { key: "archive-me", name: "Archive me", currentBundleRef: bundle.id,
      bundleRefs: [], viewer }, 120);
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${group.id}/archive`,
      credential: "session:agent-schedule", body: {} })).toMatchObject({ status: 403 });
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${group.id}/archive`,
      credential: "agent-schedule", body: {} })).toMatchObject({ status: 200, body: {
      changed: true, group: { id: group.id, archived_at: expect.any(Number), current: { id: bundle.id } },
    } });
    expect(db.prepare("SELECT archived_at FROM briefings WHERE id = ?").get(published.briefing_id))
      .toEqual({ archived_at: null });
    expect(await router.invoke({ method: "GET", url: `/api/briefing-groups/${group.id}`, credential: "human" }))
      .toMatchObject({ status: 200, body: { group: { id: group.id, archived_at: expect.any(Number) } } });
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${group.id}/restore`,
      credential: "agent-schedule", body: {} })).toMatchObject({ status: 200, body: {
      changed: true, group: { id: group.id, archived_at: null },
    } });
  });

  it("lets only the configured human operator update a title and removes transient proposed-update prose", async () => {
    const source = path.join(root, "policy.md");
    fs.writeFileSync(source, "# Policy\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "policy.md", role: "review-document", media_type: "text/markdown" }).version;
    setSetting(db, "user.operator_id", humanId);
    const created = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: version.id, title: "Sparse engineering policy — proposed update",
        description: "  Explains why this policy review exists. It represents an approval-ready fixture.  " } });
    const briefingId = (created.body as { briefing_id: string }).briefing_id;
    expect(db.prepare("SELECT title, description FROM briefings WHERE id = ?").get(briefingId))
      .toEqual({ title: "Sparse engineering policy",
        description: "Explains why this policy review exists. It represents an approval-ready fixture." });

    createUser(db, { slug: "reviewer", kind: "human", display_name: "Reviewer" });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`,
      body: { title: "Updated policy" } })).toMatchObject({ status: 401 });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`, credential: "reviewer",
      body: { title: "Updated policy" } })).toMatchObject({
      status: 403, body: { code: "briefing_title_operator_required" },
    });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`,
      credential: "session:agent-schedule", body: { title: "Updated policy" } })).toMatchObject({
      status: 403, body: { code: "briefing_title_publisher_credential_required" },
    });
    setSetting(db, "user.operator_id", "");
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`,
      credential: "agent-schedule", body: { title: "Updated policy" } })).toMatchObject({
      status: 403, body: { code: "briefing_title_operator_required" },
    });
    setSetting(db, "user.operator_id", humanId);
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`,
      credential: "agent-schedule", body: { title: "Updated policy", actor_user_id: humanId } })).toMatchObject({
      status: 400, body: { error: expect.stringContaining("unsupported field") },
    });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`,
      credential: "agent-schedule", body: { title: "  " } })).toMatchObject({ status: 400 });
    const updated = await router.invoke({ method: "PATCH",
      url: `/api/briefings/briefing:${briefingId.slice(0, 8)}`, credential: "agent-schedule",
      body: { title: "Durable policy — proposed update" } });
    expect(updated).toMatchObject({ status: 200, body: {
      briefing_id: briefingId, title: "Durable policy", changed: true,
    } });
    expect(db.prepare("SELECT title FROM briefings WHERE id = ?").get(briefingId))
      .toEqual({ title: "Durable policy" });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:title-updated", { briefing_id: briefingId });
    const roundRowsBeforeDescription = db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ?").all(briefingId);
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`, credential: "human",
      body: { description: "  Durable source snapshot for future comparison.  " } })).toMatchObject({
      status: 200, body: { briefing_id: briefingId,
        description: "Durable source snapshot for future comparison.", changed: true },
    });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:description-updated", { briefing_id: briefingId });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`, credential: "human",
      body: { description: "   " } })).toMatchObject({ status: 400 });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`, credential: "human",
      body: { description: null } })).toMatchObject({ status: 200, body: { description: null, changed: true } });
    expect(db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ?").all(briefingId))
      .toEqual(roundRowsBeforeDescription);
    expect(await router.invoke({ method: "PATCH", url: `/api/briefings/${briefingId}`, credential: "human",
      body: { title: "Durable policy", actor_user_id: humanId } })).toMatchObject({
      status: 400, body: { error: expect.stringContaining("unsupported field") },
    });
  });

  it("deletes only empty standalone bundles without cascading retained state", async () => {
    const source = path.join(root, "delete-bundle.md");
    fs.writeFileSync(source, "# Retained member\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "delete-bundle.md", role: "review-document", media_type: "text/markdown" }).version;
    const briefing = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: version.id, title: "Retained member" } });
    const briefingId = (briefing.body as { briefing_id: string }).briefing_id;

    const empty = await router.invoke({ method: "POST", url: "/api/briefing-bundles", credential: "human",
      body: { name: "Empty standalone", briefing_refs: [] } });
    const emptyId = (empty.body as { bundle: { id: string } }).bundle.id;
    expect(await router.invoke({ method: "DELETE", url: `/api/briefing-bundles/${emptyId}` }))
      .toMatchObject({ status: 401 });
    setSetting(db, "user.operator_id", humanId);
    expect(await router.invoke({ method: "DELETE", url: `/api/briefing-bundles/${emptyId}`,
      credential: "human", body: { cascade: true } })).toMatchObject({
      status: 400, body: { error: expect.stringContaining("unsupported field") },
    });
    expect(await router.invoke({ method: "DELETE", url: `/api/briefing-bundles/${emptyId}`,
      credential: "human" })).toMatchObject({ status: 200, body: {
      bundle_id: emptyId, name: "Empty standalone", deleted: true,
    } });
    expect(db.prepare("SELECT 1 FROM briefing_bundles WHERE id = ?").get(emptyId)).toBeUndefined();
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:bundle-deleted", { bundle_id: emptyId });

    const populated = await router.invoke({ method: "POST", url: "/api/briefing-bundles", credential: "human",
      body: { name: "Populated", briefing_refs: [] } });
    const populatedId = (populated.body as { bundle: { id: string } }).bundle.id;
    expect(await router.invoke({ method: "POST", url: `/api/briefing-bundles/${populatedId}/briefings`,
      credential: "human", body: { briefing_ref: briefingId } })).toMatchObject({ status: 200 });
    expect(await router.invoke({ method: "DELETE", url: `/api/briefing-bundles/${populatedId}`,
      credential: "human" })).toMatchObject({
      status: 409, body: { code: "briefing_bundle_not_empty" },
    });

    const grouped = await router.invoke({ method: "POST", url: "/api/briefing-bundles", credential: "human",
      body: { name: "Configured empty", briefing_refs: [] } });
    const groupedId = (grouped.body as { bundle: { id: string } }).bundle.id;
    expect(await router.invoke({ method: "POST", url: "/api/briefing-groups", credential: "human",
      body: { key: "keeps-bundle", name: "Keeps bundle", current_bundle_ref: groupedId, bundle_refs: [] } })).toMatchObject({ status: 201 });
    expect(await router.invoke({ method: "DELETE", url: `/api/briefing-bundles/${groupedId}`,
      credential: "human" })).toMatchObject({
      status: 409, body: { code: "briefing_bundle_referenced", reference_kind: "group configuration" },
    });
  });

  it("publishes an exact-version Briefing from a durable agent for the configured human operator", async () => {
    const source = path.join(root, "AGENTS.review.md");
    fs.writeFileSync(source, "# Version one\n");
    const firstVersion = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "AGENTS.review.md", role: "review-document", media_type: "text/markdown" }, 100);
    fs.writeFileSync(source, "# Version two\n");
    const latestVersion = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "AGENTS.review.md", role: "review-document", media_type: "text/markdown" }, 200);
    const request = { artifact_version_ref: latestVersion.version.id,
      comparison_base_artifact_version_ref: firstVersion.version.id, title: "AGENTS review" };

    expect(await router.invoke({ method: "POST", url: "/api/briefings", body: request }))
      .toMatchObject({ status: 401 });
    expect(await router.invoke({ method: "POST", url: "/api/briefings", body: request,
      credential: "session:agent-schedule" })).toMatchObject({
      status: 403, body: { code: "briefing_publisher_credential_required" },
    });
    expect(await router.invoke({ method: "POST", url: "/api/briefings", body: request,
      credential: "agent-schedule" })).toMatchObject({
      status: 403, body: { code: "briefing_publication_operator_required" },
    });

    const agentId = (db.prepare("SELECT id FROM users WHERE slug = 'agent-schedule'").get() as { id: string }).id;
    setSetting(db, "user.operator_id", agentId);
    expect(await router.invoke({ method: "POST", url: "/api/briefings", body: request,
      credential: "agent-schedule" })).toMatchObject({
      status: 403, body: { code: "briefing_publication_operator_required" },
    });

    setSetting(db, "user.operator_id", humanId);
    expect(await router.invoke({ method: "POST", url: "/api/briefings", credential: "agent-schedule",
      body: { ...request, responder_user_ids: ["spoofed"] } })).toMatchObject({
      status: 400, body: { error: expect.stringContaining("unsupported field") },
    });

    expect(await router.invoke({ method: "POST", url: "/api/briefings", body: request,
      credential: "agent-schedule" })).toMatchObject({ status: 409,
      body: { code: "briefing_destination_project_unresolved" } });
    const logical = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?")
      .get(latestVersion.version.id) as { artifact_id: string };
    const project = addProject(db, { project_key: "agent-briefing", display_name: "Agent Briefing" });
    db.prepare(`INSERT INTO project_artifact_associations
      (id, project_id, target_type, target_id, association_kind, role, created_at, updated_at)
      VALUES ('agent-briefing-association', ?, 'artifact', ?, 'canonical', '', 1, 1)`)
      .run(project.id, logical.artifact_id);

    const created = await router.invoke({ method: "POST", url: "/api/briefings", body: request,
      credential: "agent-schedule" });
    const createdAgain = await router.invoke({ method: "POST", url: "/api/briefings", body: request,
      credential: "human" });
    expect(created).toMatchObject({ status: 201, body: { artifact_version_id: latestVersion.version.id } });
    const createdIds = created.body as { briefing_id: string; round_id: string };
    expect(createdAgain).toMatchObject({ status: 409, body: {
      code: "briefing_active_candidates",
      outcome: "active_candidates",
      active_candidates: [{ briefing_id: createdIds.briefing_id,
        matching_round_id: createdIds.round_id, guidance: "reuse_round" }],
    } });
    expect(await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { ...request, target_briefing_ref: createdIds.briefing_id } })).toMatchObject({
      status: 200, body: { outcome: "round_reused", briefing_id: createdIds.briefing_id,
        round_id: createdIds.round_id },
    });
    const distinct = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { ...request, distinct_reason: "Independent approval boundary." } });
    expect(distinct).toMatchObject({ status: 201, body: {
      outcome: "created_distinct", override_receipt_id: expect.any(String),
    } });
    expect(firstVersion.version.id).not.toBe(latestVersion.version.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefings").get()).toEqual({ n: 2 });
    expect(db.prepare(
      "SELECT briefing_id, user_id FROM briefing_members ORDER BY briefing_id",
    ).all()).toEqual([
      { briefing_id: createdIds.briefing_id, user_id: humanId },
      { briefing_id: (distinct.body as { briefing_id: string }).briefing_id, user_id: humanId },
    ].sort((left, right) => left.briefing_id.localeCompare(right.briefing_id)));
    expect(db.prepare("SELECT DISTINCT artifact_version_id, comparison_base_artifact_version_id FROM briefing_rounds").all())
      .toEqual([{ artifact_version_id: latestVersion.version.id,
        comparison_base_artifact_version_id: firstVersion.version.id }]);
    expect(vi.mocked(broadcast).mock.calls.filter(([event]) => event === "briefing:created")).toHaveLength(2);

    const ids = createdIds;
    expect(await router.invoke({ method: "GET", url: `/api/briefings/${ids.briefing_id}`,
      credential: "agent-schedule" })).toMatchObject({
      status: 403, body: { code: "human_responder_required" },
    });
    expect(await router.invoke({ method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/answers`,
      credential: "agent-schedule", body: { answers: [] } })).toMatchObject({
      status: 403, body: { code: "human_responder_required" },
    });
    expect(await router.invoke({ method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/annotations`,
      credential: "agent-schedule", body: { annotations: [] } })).toMatchObject({
      status: 403, body: { code: "human_responder_required" },
    });
    expect(await router.invoke({ method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submit`,
      credential: "agent-schedule", body: {} })).toMatchObject({
      status: 403, body: { code: "human_responder_required" },
    });
    expect(await router.invoke({ method: "GET",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submissions/unknown/export`,
      credential: "agent-schedule" })).toMatchObject({
      status: 403, body: { code: "human_responder_required" },
    });

    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(humanId);
    expect(await router.invoke({ method: "POST", url: "/api/briefings", body: request,
      credential: "agent-schedule" })).toMatchObject({
      status: 403, body: { code: "briefing_publication_operator_required" },
    });
  });

  it("rejects logical artifact refs instead of silently selecting their latest version", async () => {
    const source = path.join(root, "review.md");
    fs.writeFileSync(source, "# Review\n");
    const artifact = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "review.md", role: "review-document", media_type: "text/markdown" });
    expect(await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: artifact.artifact.reference.canonical_artifact_id, title: "Review" } })).toMatchObject({
      status: 404, body: { code: "artifact_version_not_found" },
    });
    expect(await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: artifact.version.id,
        comparison_base_artifact_version_ref: artifact.artifact.reference.canonical_artifact_id, title: "Review" } })).toMatchObject({
      status: 404, body: { code: "artifact_version_not_found" },
    });
  });

  it("exports one exact actor-owned frozen v3 submission through authenticated GET", async () => {
    const markdown = `# Policy\n\n:::spec-item{key="wording" type="text_variant" required="true"}\n::alternative[One]{key="one"}\nOne.\n::alternative[Two]{key="two"}\nTwo.\n:::`;
    const file = path.join(root, "review.md"); fs.writeFileSync(file, markdown);
    const artifact = recordArtifactVersion(db, { source_kind: "local_only", path: file,
      logical_name: "review.md", role: "review-document", media_type: "text/markdown" });
    const ids = publishBriefingFromArtifactVersion(db, { briefing_key: "review", title: "Review",
      artifact_version_ref: artifact.version.id, profile: "mandible-briefing.v3", responder_user_ids: [humanId] });
    const answer = await router.invoke({ method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/answers`,
      credential: "human", body: { answers: [{ directive_key: "wording", operation: "set",
        expected_response_event_id: null, value: { option_key: "two" } }] } });
    const eventId = (answer.body as { answers: Array<{ response_event_id: string }> }).answers[0].response_event_id;
    const submission = await router.invoke({ method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submit`,
      credential: "human", body: { answers: [{ directive_key: "wording", response_event_id: eventId }],
        annotation_event_ids: [], supersedes_submission_id: null } });
    const submissionId = (submission.body as { submission_id: string }).submission_id;
    const url = `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submissions/${submissionId}/export`;
    expect(await router.invoke({ method: "GET", url })).toMatchObject({ status: 401 });
    expect(await router.invoke({ method: "GET", url, credential: "human" })).toMatchObject({
      status: 200, body: { content: "# Policy\n\nTwo.", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });
  it("authenticates publishers, returns stable run identity, and rejects old compatibility routes", async () => {
    expect((await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload() })).status).toBe(401);
    expect((await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "session:agent-schedule" })).status).toBe(403);
    const first = await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ quiet: false, run_id: "run-1" });
    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    expect(await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule" }))
      .toEqual(first);
    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    expect((await router.invoke({ method: "POST", url: "/api/briefing/ingest", body: payload(), credential: "agent-schedule" })).status).toBe(404);
    expect((await router.invoke({ method: "GET", url: "/api/asks/anything", credential: "human" })).status).toBe(404);
  });

  it.each(["accepted", "rejected"] as const)("reviews a manual addition with exact destination ownership (%s)", async (decision) => {
    setSetting(db, "user.operator_id", humanId);
    const artifact = recordArtifactVersion(db, { source_kind: "managed", content: "# Maintenance\n\nReport.\n",
      series_key: "test:manual-review", logical_name: "Maintenance.md", role: "briefing-document",
      media_type: "text/markdown" });
    const published = publishBriefingFromArtifactVersion(db, {
      title: "Maintenance", artifact_version_ref: artifact.version.id, profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
    });
    if (published.outcome === "active_candidates") throw new Error("unexpected publication conflict");
    const viewer = { userId: humanId, operator: true };
    const base = createBriefingBundle(db, { name: "Base", briefingRefs: [], viewer });
    const proposal = createBriefingBundle(db, { name: "Addition", briefingRefs: [published.briefing_id], viewer });
    const group = createBriefingGroup(db, { key: "digest", name: "Digest", currentBundleRef: base.id,
      bundleRefs: [proposal.id], viewer });
    const logical = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?")
      .get(artifact.version.id) as { artifact_id: string };
    const changes = [{ logical_artifact_ref: logical.artifact_id, expected_group_ref: null }];
    const previewBody = { expected_base_bundle_ref: base.id, proposal_bundle_ref: proposal.id,
      destination_changes: changes };
    const preview = () => router.invoke({ method: "POST",
      url: `/api/briefing-groups/${group.id}/review-candidates`, credential: "human", body: previewBody });
    expect(await preview()).toMatchObject({ status: 200, body: { candidate: {
      ready: false, blocker_code: "briefing_review_submission_required",
    } } });
    const annotation = await router.invoke({ method: "POST",
      url: `/api/briefings/${published.briefing_id}/rounds/${published.round_id}/annotations`, credential: "human",
      body: { annotations: [{ operation: "set", kind: "comment", start_offset: 2, end_offset: 13,
        quote: "Maintenance", body: "Reviewed placement", replacement_text: null }] },
    });
    expect(annotation.status).toBe(200);
    const annotationIds = (annotation.body as { annotation_event_ids: string[] }).annotation_event_ids;
    expect(await router.invoke({ method: "POST",
      url: `/api/briefings/${published.briefing_id}/rounds/${published.round_id}/submit`,
      credential: "human", body: { answers: [], annotation_event_ids: annotationIds, supersedes_submission_id: null },
    })).toMatchObject({ status: 200 });
    const reviewed = await preview();
    expect(reviewed).toMatchObject({ status: 200, body: { candidate: {
      ready: true, composition_run_id: null, destination_changes: [{ expected_group_id: null }],
    } } });
    const binding = (reviewed.body as { candidate: { binding_digest: string } }).candidate.binding_digest;
    const dispositionBody = { ...previewBody, decision, binding_digest: binding };
    const url = `/api/briefing-groups/${group.id}/review-dispositions`;
    for (const credential of ["agent-schedule", "session:human"]) {
      expect(await router.invoke({ method: "POST", url, credential, body: dispositionBody }))
        .toMatchObject({ status: 403 });
    }
    expect(await router.invoke({ method: "POST", url, credential: "human",
      body: { ...dispositionBody, destination_changes: [] } }))
      .toMatchObject({ status: 409, body: { code: "briefing_review_binding_drift" } });
    expect(await router.invoke({ method: "POST", url, credential: "human", body: dispositionBody }))
      .toMatchObject({ status: 200, body: { changed: true, group: {
        current: { id: decision === "accepted" ? proposal.id : base.id }, updates: [],
      }, disposition: { composition_run_id: null, kind: decision } } });
    expect(db.prepare("SELECT group_id FROM briefing_destination_owners WHERE logical_artifact_id = ?")
      .get(logical.artifact_id)).toEqual(decision === "accepted" ? { group_id: group.id } : undefined);
    expect(await router.invoke({ method: "POST", url, credential: "human", body: dispositionBody }))
      .toMatchObject({ status: 200, body: { changed: false } });
    expect(await router.invoke({ method: "POST", url, credential: "human",
      body: { ...dispositionBody, destination_changes: [] } }))
      .toMatchObject({ status: 409, body: { code: "briefing_review_replay_drift" } });
  });

  it("dispatches normalized composition runs through the idempotent plural run endpoint", async () => {
    setSetting(db, "user.operator_id", humanId);
    const source = "# Project\n\n## Maintenance\n\nExisting.\n";
    const artifact = recordArtifactVersion(db, { source_kind: "managed", content: source,
      series_key: "test:route-composer", logical_name: "Project.md", role: "briefing-document",
      media_type: "text/markdown" });
    const published = publishBriefingFromArtifactVersion(db, { briefing_key: "route-composer-base",
      title: "Project", artifact_version_ref: artifact.version.id, profile: "mandible-briefing.v3",
      responder_user_ids: [humanId] });
    if (published.outcome === "active_candidates") throw new Error("base publication unexpectedly conflicted");
    const logical = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?").get(artifact.version.id) as
      { artifact_id: string };
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Project Base",
      briefingRefs: [published.briefing_id], viewer });
    const group = createBriefingGroup(db, { key: "project", name: "Project", currentBundleRef: bundle.id,
      bundleRefs: [], viewer });
    bindBriefingDestinationOwner(db, { logicalArtifactRef: logical.artifact_id, groupRef: group.id },
      { userId: humanId, evidenceMethod: "api_token", credentialId: null }, viewer);
    registerBriefingDestinationRoute(db, { route_key: "projects.example.maintenance",
      logical_artifact_id: logical.artifact_id, heading: "Maintenance", composer_kind: "deterministic",
      publication_mode: "reviewed-document",
      template_version: 1, contribution_template: "- {{summary}} ([evidence]({{evidence_ref}}))",
      slots: { summary: { type: "string", required: true, max_length: 200 } },
      limits: { max_contributions: 10, max_document_bytes: 10_000, max_directives: 0 } });
    const body = {
      schema: "mandible-briefing-composition@2", task_identity: "agent-schedule/daily-digest",
      run_id: "composition-run", run_key: "composition-key",
      source: { key: "repo-maintenance", cursor: "cursor-1" },
      source_health: { source: "arxiv-scan", status: "healthy", detail: null, observed_at: 1 },
      responder_user_ids: [humanId], quiet_reason: null,
      inputs: [{ route_key: "projects.example.maintenance",
        expected_artifact_version_ref: artifact.version.id, agentic_markdown: null }],
      contributions: [{ route_key: "projects.example.maintenance", change_id: "change-1",
        evidence_ref: "issue:abc1234", evidence_digest: "a".repeat(64), occurred_at: 1,
        slots: { summary: "Prune stale branches" } }],
    };
    const first = await router.invoke({ method: "POST", url: "/api/briefings/runs",
      body, credential: "agent-schedule" });
    expect(first).toMatchObject({ status: 200, body: { run_id: "composition-run", quiet: false,
      targets: [{ group_id: group.id, outcome: "proposed", proposal_bundle_id: expect.any(String) }] } });
    expect(await router.invoke({ method: "POST", url: "/api/briefings/runs",
      body, credential: "agent-schedule" })).toEqual(first);
    const proposalBundleId = (first.body as { targets: Array<{ proposal_bundle_id: string }> })
      .targets[0].proposal_bundle_id;
    const review = db.prepare(`SELECT b.id AS briefing_id, b.latest_round_id AS round_id
      FROM briefing_bundle_members bm JOIN briefings b ON b.id = bm.briefing_id
      JOIN briefing_rounds r ON r.id = b.latest_round_id
      WHERE bm.bundle_id = ? AND r.artifact_version_id != ?`).get(proposalBundleId, artifact.version.id) as
      { briefing_id: string; round_id: string };
    db.prepare(`INSERT INTO briefing_submissions
      (id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at)
      VALUES ('route-review-submission', ?, ?, 1, NULL, ?, 2)`)
      .run(review.round_id, review.briefing_id, humanId);
    const shown = await router.invoke({ method: "GET", url: `/api/briefing-groups/${group.id}`,
      credential: "human" });
    const candidate = (shown.body as { group: { review_candidates: Array<{ binding_digest: string }> } })
      .group.review_candidates[0];
    expect(await router.invoke({ method: "GET", url: `/api/briefing-groups/${group.id}`,
      credential: "agent-schedule" })).toMatchObject({ status: 200, body: { group: { review_candidates: [] } } });
    const dispositionBody = {
      decision: "accepted",
      expected_base_bundle_ref: bundle.id,
      proposal_bundle_ref: proposalBundleId,
      binding_digest: candidate.binding_digest,
    };
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${group.id}/review-dispositions`,
      credential: "session:human", body: dispositionBody })).toMatchObject({
      status: 403, body: { code: "briefing_group_review_credential_required" },
    });
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${group.id}/review-dispositions`,
      credential: "agent-schedule", body: dispositionBody })).toMatchObject({
      status: 403, body: { code: "briefing_group_review_operator_required" },
    });
    const accepted = await router.invoke({ method: "POST",
      url: `/api/briefing-groups/${group.id}/review-dispositions`, credential: "human", body: dispositionBody });
    expect(accepted).toMatchObject({ status: 200, body: {
      changed: true,
      group: { current: { id: proposalBundleId }, updates: [] },
      disposition: { kind: "accepted", review_items: [{ submission_id: "route-review-submission" }] },
    } });
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${group.id}/review-dispositions`,
      credential: "human", body: dispositionBody })).toMatchObject({ status: 200, body: { changed: false } });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:group-proposal-accepted", {
      group_id: group.id,
      proposal_bundle_id: proposalBundleId,
      prior_base_bundle_id: bundle.id,
      review_binding_digest: candidate.binding_digest,
    });
  });

  it("lists logical identities, selects rounds, and executes the actor-scoped answer/submit family", async () => {
    const published = await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule" });
    const ids = published.body as { briefing_id: string; round_id: string };
    expect(await router.invoke({ method: "GET", url: "/api/briefings" })).toMatchObject({ status: 401 });
    expect(await router.invoke({ method: "GET", url: "/api/briefings", credential: "agent-schedule" }))
      .toMatchObject({ status: 403, body: { code: "human_responder_required" } });
    const list = await router.invoke({ method: "GET", url: "/api/briefings", credential: "human" });
    expect(list.body).toMatchObject({ briefings: [{
      id: ids.briefing_id, latest_round_id: ids.round_id, round_count: 1, unanswered_directive_count: 1,
    }] });
    const detail = await router.invoke({ method: "GET", url: `/api/briefings/${ids.briefing_id}?round=${ids.round_id}`, credential: "human" });
    expect(detail.body).toMatchObject({ selected_round: { id: ids.round_id, binding: { status: "valid" }, items: [{ directive_key: "paper" }] } });
    const answer = await router.invoke({ method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/answers`,
      credential: "human", body: { answers: [{ directive_key: "paper", operation: "set",
        expected_response_event_id: null, value: { verdict: "keep" } }] } });
    expect(answer.status).toBe(200);
    const responseEventId = ((answer.body as { answers: Array<{ response_event_id: string }> }).answers[0]).response_event_id;
    expect((await router.invoke({ method: "GET", url: "/api/briefings", credential: "human" })).body)
      .toMatchObject({ briefings: [{ id: ids.briefing_id, unanswered_directive_count: 0 }] });
    const annotation = await router.invoke({
      method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/annotations`, credential: "human",
      body: { annotations: [{ operation: "set", kind: "comment", start_offset: 2, end_offset: 7,
        quote: "Daily", body: "Reviewed", replacement_text: null }] },
    });
    expect(annotation.status).toBe(200);
    const annotationEventId = ((annotation.body as { annotation_event_ids: string[] }).annotation_event_ids[0]);
    const submitted = await router.invoke({ method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submit`,
      credential: "human", body: { answers: [{ directive_key: "paper", response_event_id: responseEventId }],
        annotation_event_ids: [annotationEventId], supersedes_submission_id: null } });
    expect(submitted).toMatchObject({ status: 200, body: { ordinal: 1, actor_user_id: humanId } });
    const submissionId = (submitted.body as { submission_id: string }).submission_id;
    expect(await router.invoke({
      method: "GET",
      url: `/api/briefings/${ids.briefing_id}?round=${ids.round_id}&submission=${submissionId}`,
      credential: "human",
    })).toMatchObject({
      status: 200,
      body: { selected_round: {
        id: ids.round_id,
        submission_overlays: [{ id: submissionId, annotation_count: 1, answer_count: 1 }],
        selected_submission_overlay: {
          id: submissionId,
          actor_user_id: humanId,
          answers: [{ response_event_id: responseEventId }],
          annotations: [{ annotation_event_id: annotationEventId }],
        },
      } },
    });
    expect(vi.mocked(broadcast).mock.calls).toEqual(expect.arrayContaining([
      ["briefing:created", { briefing_id: ids.briefing_id }],
      ["briefing:round-published", { briefing_id: ids.briefing_id, round_id: ids.round_id }],
      ["briefing:answered", { briefing_id: ids.briefing_id, round_id: ids.round_id }],
      ["briefing:annotated", { briefing_id: ids.briefing_id, round_id: ids.round_id }],
      ["briefing:submitted", { briefing_id: ids.briefing_id, round_id: ids.round_id }],
    ]));
    for (const [, eventPayload] of vi.mocked(broadcast).mock.calls) {
      expect(eventPayload).not.toHaveProperty("value");
      expect(eventPayload).not.toHaveProperty("actor_user_id");
    }
  });

  it("allows local Briefing writes on an isolated preview copy", async () => {
    const published = await router.invoke({
      method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule",
    });
    const ids = published.body as { briefing_id: string; round_id: string };
    const preview = new Router({
      clientAuth: new SlugGate(() => db),
      instance: copiedPreviewInstance(),
    });
    registerBriefingRoutes(preview, db);

    const answer = await preview.invoke({
      method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/answers`,
      credential: "human",
      body: { actor_user_id: "payload-cannot-select-an-actor", answers: [{ directive_key: "paper", operation: "set",
        expected_response_event_id: null, value: { verdict: "keep" } }] },
    });
    expect(answer.status).toBe(200);
    const responseEventId = (answer.body as { answers: Array<{ response_event_id: string }> })
      .answers[0].response_event_id;
    const annotation = await preview.invoke({
      method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/annotations`,
      credential: "human",
      body: { actor_user_id: "payload-cannot-select-an-actor", annotations: [{ operation: "set", kind: "comment", start_offset: 2, end_offset: 7,
        quote: "Daily", body: "Reviewed", replacement_text: null }] },
    });
    expect(annotation.status).toBe(200);
    const annotationEventId = (annotation.body as { annotation_event_ids: string[] }).annotation_event_ids[0];
    const spoofedSubmission = await preview.invoke({
      method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submit`,
      credential: "human",
      body: { actor_user_id: "payload-cannot-select-an-actor",
        answers: [{ directive_key: "paper", response_event_id: responseEventId }],
        annotation_event_ids: [annotationEventId], supersedes_submission_id: null },
    });
    expect(spoofedSubmission).toMatchObject({
      status: 400,
      body: { code: "invalid_briefing", error: expect.stringContaining("actor_user_id") },
    });
    const submitted = await preview.invoke({
      method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submit`,
      credential: "human",
      body: { answers: [{ directive_key: "paper", response_event_id: responseEventId }],
        annotation_event_ids: [annotationEventId], supersedes_submission_id: null },
    });
    expect(submitted).toMatchObject({ status: 200, body: { actor_user_id: humanId } });
    const submissionId = (submitted.body as { submission_id: string }).submission_id;
    expect(db.prepare(
      `SELECT actor_user_id, response_event_id FROM briefing_submission_answers WHERE submission_id = ?`,
    ).all(submissionId)).toEqual([{ actor_user_id: humanId, response_event_id: responseEventId }]);
    expect(db.prepare(
      `SELECT actor_user_id, annotation_event_id FROM briefing_submission_annotations WHERE submission_id = ?`,
    ).all(submissionId)).toEqual([{ actor_user_id: humanId, annotation_event_id: annotationEventId }]);

    expect(await preview.invoke({
      method: "POST", url: "/api/briefings/runs", credential: "agent-schedule", body: payload({ run_key: "blocked" }),
    })).toMatchObject({ status: 200, body: { quiet: false } });
  });

  it("keeps operator response authority aligned with the exact selected copied-preview round", async () => {
    const published = await router.invoke({
      method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule",
    });
    const ids = published.body as { briefing_id: string; round_id: string };
    const operator = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" });
    setSetting(db, "user.operator_id", operator.id);
    const preview = new Router({
      clientAuth: new SlugGate(() => db),
      instance: copiedPreviewInstance(),
    });
    registerBriefingRoutes(preview, db);

    const selected = await preview.invoke({
      method: "GET", url: `/api/briefings/${ids.briefing_id}?round=${ids.round_id}`, credential: "operator",
    });
    expect(selected).toMatchObject({
      status: 200,
      body: { briefing: { id: ids.briefing_id }, selected_round: { id: ids.round_id } },
    });
    const annotation = await preview.invoke({
      method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/annotations`, credential: "operator",
      body: { annotations: [{ operation: "set", kind: "comment", start_offset: 2, end_offset: 7,
        quote: "Daily", body: "Final IAB acceptance annotation.", replacement_text: null }] },
    });
    expect(annotation).toMatchObject({ status: 200, body: { annotation_event_ids: [expect.any(String)] } });
  });

  it("keeps isolated-copy response authority bound to an authenticated active human", async () => {
    const published = await router.invoke({
      method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule",
    });
    const ids = published.body as { briefing_id: string; round_id: string };
    createUser(db, { slug: "other-agent", kind: "agent", display_name: "Other agent" });
    const inactive = createUser(db, { slug: "inactive-human", kind: "human", display_name: "Inactive" });
    db.prepare("UPDATE users SET status = 'retired' WHERE id = ?").run(inactive.id);
    const preview = new Router({
      clientAuth: new SlugGate(() => db),
      instance: copiedPreviewInstance(),
    });
    registerBriefingRoutes(preview, db);
    const request = (credential?: string) => preview.invoke({
      method: "POST",
      url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/answers`,
      ...(credential ? { credential } : {}),
      body: { answers: [] },
    });
    expect(await request()).toMatchObject({ status: 401, body: { code: "authentication_required" } });
    expect(await request("other-agent")).toMatchObject({ status: 403, body: { code: "human_responder_required" } });
    expect(await request("inactive-human")).toMatchObject({ status: 403, body: { code: "human_responder_required" } });
  });

  it("resolves round refs only inside the authorized Briefing and rejects ambiguous prefixes", async () => {
    const published = await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule" });
    const ids = published.body as { briefing_id: string; round_id: string };
    const seed = db.prepare(
      "SELECT artifact_version_id, profile, binding_digest FROM briefing_rounds WHERE id = ?",
    ).get(ids.round_id) as { artifact_version_id: string; profile: string; binding_digest: string };
    const insert = db.prepare(
      `INSERT INTO briefing_rounds
         (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const firstCollision = "aaaaaaaa-1111-4111-8111-111111111111";
    const secondCollision = "aaaaaaaa-2222-4222-8222-222222222222";
    insert.run(firstCollision, ids.briefing_id, 2, seed.artifact_version_id, ids.round_id, seed.profile, seed.binding_digest, 2);
    insert.run(secondCollision, ids.briefing_id, 3, seed.artifact_version_id, firstCollision, seed.profile, seed.binding_digest, 3);

    const exact = await router.invoke({
      method: "GET", url: `/api/briefings/${ids.briefing_id}?round=${firstCollision}`, credential: "human",
    });
    expect(exact).toMatchObject({ status: 200, body: { selected_round: { id: firstCollision } } });

    const ambiguous = await router.invoke({
      method: "GET", url: `/api/briefings/${ids.briefing_id}?round=aaaaaaaa`, credential: "human",
    });
    expect(ambiguous).toMatchObject({
      status: 409,
      body: { code: "ambiguous_round", error: expect.stringContaining("ambiguous") },
    });
  });
});
