import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/sse.js", () => ({ broadcast: vi.fn() }));

import { setSetting } from "../../src/client-auth/settings-kv.js";
import { migrate, type Db } from "../../src/db.js";
import { resolveInstanceInfo } from "../../src/instance-policy.js";
import { registerBriefingRoutes } from "../../src/routes/briefing.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../../src/server.js";
import { createUser } from "../../src/users/store.js";
import { broadcast } from "../../src/sse.js";
import { publishBriefingFromArtifactVersion } from "../../src/feedback/briefings.js";
import { createBriefingBundle } from "../../src/feedback/briefing-bundles.js";
import { createBriefingGroup } from "../../src/feedback/briefing-groups.js";
import { recordArtifactVersion } from "../../src/provider-artifacts.js";

class SlugGate implements ClientAuthGate {
  constructor(private readonly db: () => Db) {}
  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const ephemeral = credential.startsWith("session:");
    const slug = ephemeral ? credential.slice(8) : credential;
    const user = this.db().prepare("SELECT id, slug FROM users WHERE slug = ?")
      .get(slug) as { id: string; slug: string } | undefined;
    return user ? { user_id: user.id, slug: user.slug, method: ephemeral ? "ephemeral" : "api_token",
      credential_id: null, source: "in_process" } : null;
  }
  mode() { return "compat" as const; }
  recordUnattributedWrite() {}
}

let db: Db;
let router: Router;
let root: string;
let humanId: string;

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-briefing-routes-"));
  fs.writeFileSync(path.join(root, "source.db"), "");
  fs.copyFileSync(path.join(root, "source.db"), path.join(root, "preview.db"));
  db = new Database(path.join(root, "preview.db"));
  migrate(db);
  setSetting(db, "artifact_root", root);
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
    const group = createBriefingGroup(db, { name: "Archive me", currentBundleRef: bundle.id,
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

  it("archives and restores exact Briefings with durable publisher authorization and preserved custody", async () => {
    const source = path.join(root, "archive.md");
    fs.writeFileSync(source, "# Archive\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "archive.md", role: "review-document", media_type: "text/markdown" }).version;
    setSetting(db, "user.operator_id", humanId);
    const created = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: version.id, title: "Obsolete" } });
    const briefingId = (created.body as { briefing_id: string }).briefing_id;
    const before = {
      briefing: db.prepare("SELECT * FROM briefings WHERE id = ?").get(briefingId) as Record<string, unknown>,
      rounds: db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ?").all(briefingId),
      members: db.prepare("SELECT * FROM briefing_members WHERE briefing_id = ?").all(briefingId),
    };
    expect(await router.invoke({ method: "POST", url: `/api/briefings/${briefingId}/archive`, body: {} }))
      .toMatchObject({ status: 401 });
    expect(await router.invoke({ method: "POST", url: `/api/briefings/${briefingId}/archive`,
      credential: "session:agent-schedule", body: {} })).toMatchObject({
      status: 403, body: { code: "briefing_organization_publisher_credential_required" },
    });
    const archived = await router.invoke({ method: "POST",
      url: `/api/briefings/briefing:${briefingId.slice(0, 8)}/archive`, credential: "agent-schedule", body: {} });
    expect(archived).toMatchObject({ status: 200, body: {
      briefing_id: briefingId, archived_at: expect.any(Number), changed: true,
    } });
    expect(await router.invoke({ method: "GET", url: "/api/briefings", credential: "human" }))
      .toMatchObject({ status: 200, body: { briefings: [] } });
    expect(await router.invoke({ method: "GET", url: `/api/briefings/${briefingId}`, credential: "human" }))
      .toMatchObject({ status: 200, body: { briefing: { id: briefingId, archived_at: expect.any(Number) } } });
    expect(db.prepare("SELECT * FROM briefing_rounds WHERE briefing_id = ?").all(briefingId)).toEqual(before.rounds);
    expect(db.prepare("SELECT * FROM briefing_members WHERE briefing_id = ?").all(briefingId)).toEqual(before.members);
    expect(db.prepare("SELECT * FROM briefings WHERE id = ?").get(briefingId)).toEqual({
      ...before.briefing, archived_at: expect.any(Number),
    });
    expect(await router.invoke({ method: "POST", url: `/api/briefings/${briefingId}/restore`,
      credential: "agent-schedule", body: {} })).toMatchObject({ status: 200, body: {
      briefing_id: briefingId, archived_at: null, changed: true,
    } });
    expect(db.prepare("SELECT * FROM briefings WHERE id = ?").get(briefingId)).toEqual(before.briefing);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:archived", { briefing_id: briefingId });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:restored", { briefing_id: briefingId });
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

  it("creates, appends to, and shows a named bundle without changing its Briefings", async () => {
    const source = path.join(root, "bundle.md");
    fs.writeFileSync(source, "# Bundle member\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "bundle.md", role: "review-document", media_type: "text/markdown" }).version;
    const first = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: version.id, title: "First" } });
    const second = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: version.id, title: "Second",
        distinct_reason: "Keep a separate bundle fixture." } });
    const firstId = (first.body as { briefing_id: string }).briefing_id;
    const secondId = (second.body as { briefing_id: string }).briefing_id;

    expect(await router.invoke({ method: "POST", url: "/api/briefing-bundles",
      body: { name: "Policy review", briefing_refs: [firstId] } })).toMatchObject({ status: 401 });
    const created = await router.invoke({ method: "POST", url: "/api/briefing-bundles", credential: "human",
      body: { name: "Policy review", briefing_refs: [firstId] } });
    expect(created).toMatchObject({ status: 201, body: { bundle: {
      name: "Policy review",
      members: [{ position: 0, briefing: { id: firstId, title: "First" } }],
    } } });
    const bundleId = (created.body as { bundle: { id: string } }).bundle.id;
    const added = await router.invoke({ method: "POST",
      url: `/api/briefing-bundles/${bundleId.slice(0, 8)}/briefings`, credential: "human",
      body: { briefing_ref: secondId.slice(0, 8) } });
    expect(added).toMatchObject({ status: 200, body: { added: true, bundle: { members: [
      { position: 0, briefing: { id: firstId } },
      { position: 1, briefing: { id: secondId } },
    ] } } });
    expect(await router.invoke({ method: "POST",
      url: `/api/briefing-bundles/${bundleId}/briefings`, credential: "human",
      body: { briefing_ref: secondId } })).toMatchObject({ status: 200, body: { added: false } });
    expect(await router.invoke({ method: "GET", url: `/api/briefing-bundles/${bundleId.slice(0, 8)}`,
      credential: "human" })).toMatchObject({ status: 200, body: { bundle: {
      id: bundleId,
      members: [
        { position: 0, briefing: { id: firstId } },
        { position: 1, briefing: { id: secondId } },
      ],
    } } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 2 });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:bundle-created", { bundle_id: bundleId });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:bundle-member-added", {
      bundle_id: bundleId, briefing_id: secondId,
    });
  });

  it("lets a durable agent publish an ordered bundle for the configured operator without changing members", async () => {
    const source = path.join(root, "agent-bundle.md");
    fs.writeFileSync(source, "# Bundle member\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "agent-bundle.md", role: "review-document", media_type: "text/markdown" }).version;
    const briefingIds = ["Global", "Codex", "Claude"].map((title, index) => publishBriefingFromArtifactVersion(db, {
      briefing_key: `agent-bundle:${title}`,
      title,
      artifact_version_ref: version.id,
      profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
      ...(index === 0 ? {} : {
        distinct_reason: `Keep ${title} as a separate review fixture.`,
        creation_provenance: { actor_user_id: humanId, evidence_method: "local_default" as const, credential_id: null },
      }),
    })).map((result) => {
      if (result.outcome === "active_candidates") throw new Error("explicit fixture publication conflicted");
      return result.briefing_id;
    });
    const briefingRowsBefore = db.prepare("SELECT * FROM briefings ORDER BY id").all();
    const roundRowsBefore = db.prepare("SELECT * FROM briefing_rounds ORDER BY id").all();
    const memberRowsBefore = db.prepare("SELECT * FROM briefing_members ORDER BY briefing_id, user_id").all();
    const request = { name: "Sparse engineering policy review", briefing_refs: briefingIds };

    expect(await router.invoke({ method: "POST", url: "/api/briefing-bundles", body: request }))
      .toMatchObject({ status: 401 });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-bundles", body: request,
      credential: "session:agent-schedule" })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_publisher_credential_required" },
    });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-bundles", body: request,
      credential: "agent-schedule" })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_publication_operator_required" },
    });

    setSetting(db, "user.operator_id", humanId);
    expect(await router.invoke({ method: "POST", url: "/api/briefing-bundles",
      credential: "agent-schedule", body: { ...request, actor_user_id: humanId } })).toMatchObject({
      status: 400, body: { error: expect.stringContaining("unsupported field") },
    });
    const created = await router.invoke({ method: "POST", url: "/api/briefing-bundles",
      credential: "agent-schedule", body: request });
    expect(created).toMatchObject({ status: 201, body: { bundle: {
      name: request.name,
      members: briefingIds.map((id, position) => ({ position, briefing: { id } })),
    } } });
    expect(db.prepare("SELECT * FROM briefings ORDER BY id").all()).toEqual(briefingRowsBefore);
    expect(db.prepare("SELECT * FROM briefing_rounds ORDER BY id").all()).toEqual(roundRowsBefore);
    expect(db.prepare("SELECT * FROM briefing_members ORDER BY briefing_id, user_id").all()).toEqual(memberRowsBefore);

    const bundleBefore = db.prepare("SELECT * FROM briefing_bundles").get() as Record<string, unknown>;
    const bundleId = String(bundleBefore.id);
    const bundleMembersBefore = db.prepare(
      "SELECT * FROM briefing_bundle_members ORDER BY layout_position, subgroup_position",
    ).all();
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "session:agent-schedule", body: { name: "Renamed" } })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_name_publisher_credential_required" },
    });
    setSetting(db, "user.operator_id", "");
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { name: "Renamed" } })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_name_operator_required" },
    });
    setSetting(db, "user.operator_id", humanId);
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { name: "Renamed", owner_user_id: humanId } })).toMatchObject({
      status: 400, body: { error: expect.stringContaining("unsupported field") },
    });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { name: "\t" } })).toMatchObject({ status: 400 });
    const renamed = await router.invoke({ method: "PATCH",
      url: `/api/briefing-bundles/briefing-bundle:${bundleId.slice(0, 8)}`,
      credential: "agent-schedule", body: { name: "  Sara’s skill, breakdown  " } });
    expect(renamed).toMatchObject({ status: 200, body: { changed: true, bundle: {
      id: bundleId, name: "Sara’s skill, breakdown",
      members: briefingIds.map((id, position) => ({ position, briefing: { id } })),
    } } });
    expect(db.prepare("SELECT * FROM briefing_bundles WHERE id = ?").get(bundleId)).toEqual({
      ...bundleBefore, name: "Sara’s skill, breakdown",
    });
    expect(db.prepare("SELECT * FROM briefing_bundle_members ORDER BY layout_position, subgroup_position").all())
      .toEqual(bundleMembersBefore);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:bundle-name-updated", { bundle_id: bundleId });

    const reviewerId = createUser(db, { slug: "reviewer", kind: "human", display_name: "Reviewer" }).id;
    const replacement = [...briefingIds].reverse();
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      body: { briefing_refs: replacement } })).toMatchObject({ status: 401 });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "session:agent-schedule", body: { briefing_refs: replacement } })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_membership_publisher_credential_required" },
    });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "session:human", body: { briefing_refs: replacement } })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_membership_publisher_credential_required" },
    });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "reviewer", body: { briefing_refs: replacement } })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_membership_operator_required" },
    });
    expect(reviewerId).toBeTruthy();
    setSetting(db, "user.operator_id", "");
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { briefing_refs: replacement } })).toMatchObject({
      status: 403, body: { code: "briefing_bundle_membership_operator_required" },
    });
    setSetting(db, "user.operator_id", humanId);
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { briefing_refs: replacement, actor_user_id: humanId } }))
      .toMatchObject({ status: 400, body: { error: expect.stringContaining("unsupported field") } });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { briefing_refs: [briefingIds[0], " "] } }))
      .toMatchObject({ status: 400, body: { error: expect.stringContaining("nonblank") } });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { briefing_refs: [briefingIds[0], briefingIds[0]] } }))
      .toMatchObject({ status: 400, body: { error: expect.stringContaining("duplicates") } });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule", body: { name: "Must roll back", briefing_refs: ["missing"] } }))
      .toMatchObject({ status: 404 });
    expect(db.prepare("SELECT name FROM briefing_bundles WHERE id = ?").get(bundleId))
      .toEqual({ name: "Sara’s skill, breakdown" });

    const replaced = await router.invoke({ method: "PATCH",
      url: `/api/briefing-bundles/briefing-bundle:${bundleId.slice(0, 8)}`,
      credential: "agent-schedule", body: { briefing_refs: replacement } });
    expect(replaced).toMatchObject({ status: 200, body: {
      changed: true, name_changed: false, membership_changed: true,
      bundle: {
        id: bundleId, name: "Sara’s skill, breakdown",
        members: replacement.map((id, position) => ({ position, briefing: { id } })),
      },
    } });
    expect(db.prepare("SELECT * FROM briefings ORDER BY id").all()).toEqual(briefingRowsBefore);
    expect(db.prepare("SELECT * FROM briefing_rounds ORDER BY id").all()).toEqual(roundRowsBefore);
    expect(db.prepare("SELECT * FROM briefing_members ORDER BY briefing_id, user_id").all()).toEqual(memberRowsBefore);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:bundle-members-replaced", {
      bundle_id: bundleId,
    });

    const humanCreated = await router.invoke({ method: "POST", url: "/api/briefing-bundles",
      credential: "human", body: { name: "Human bundle", briefing_refs: briefingIds } });
    expect(humanCreated).toMatchObject({ status: 201 });
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
      body: { artifact_version_ref: artifact.artifact.id, title: "Review" } })).toMatchObject({
      status: 404, body: { code: "artifact_version_not_found" },
    });
    expect(await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: artifact.version.id,
        comparison_base_artifact_version_ref: artifact.artifact.id, title: "Review" } })).toMatchObject({
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

  it("allows an authenticated active human to freeze responses on an isolated reject-mode copy", async () => {
    const published = await router.invoke({
      method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule",
    });
    const ids = published.body as { briefing_id: string; round_id: string };
    const preview = new Router({
      clientAuth: new SlugGate(() => db),
      instance: resolveInstanceInfo({
        env: { MANDIBLE_INSTANCE_ROLE: "preview", MANDIBLE_OPERATIONAL_MUTATIONS: "reject" },
        dbPath: path.join(root, "preview.db"),
        sourceDbPath: path.join(root, "source.db"),
      }),
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
    })).toMatchObject({ status: 403, body: { error: "instance_mutation_forbidden" } });
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
      instance: resolveInstanceInfo({
        env: { MANDIBLE_INSTANCE_ROLE: "preview", MANDIBLE_OPERATIONAL_MUTATIONS: "reject" },
        dbPath: path.join(root, "preview.db"),
        sourceDbPath: path.join(root, "source.db"),
      }),
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
      instance: resolveInstanceInfo({
        env: { MANDIBLE_INSTANCE_ROLE: "preview" },
        dbPath: path.join(root, "preview.db"),
        sourceDbPath: path.join(root, "source.db"),
      }),
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

  it("records quiet source-health receipts without creating a round", async () => {
    const quiet = await router.invoke({ method: "POST", url: "/api/briefings/runs", credential: "agent-schedule", body: payload({
      document: null, quiet_reason: "no changes", occurrences: [], run_key: "quiet-1", run_id: "quiet-1",
    }) });
    expect(quiet).toMatchObject({ status: 200, body: { quiet: true, round_id: null, artifact_version_id: null } });
    expect(db.prepare("SELECT source_health_json FROM briefing_runs WHERE id = ?")
      .get((quiet.body as { receipt_id: string }).receipt_id)).toMatchObject({ source_health_json: expect.stringContaining("healthy") });
  });

  it("models stable groups of proposed updates and a mixed direct-plus-Skills layout", async () => {
    const source = path.join(root, "policy-layout.md");
    fs.writeFileSync(source, "# Policy layout\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "policy-layout.md", role: "review-document", media_type: "text/markdown" }).version;
    const titles = ["Global", "Codex", "Claude", "Reliability design", "Performance", "Squeeze", "Strict engineering"];
    const ids = titles.map((title, index) => publishBriefingFromArtifactVersion(db, {
      briefing_key: `policy-layout:${title}`, title, artifact_version_ref: version.id,
      profile: "mandible-briefing.v3", responder_user_ids: [humanId],
      ...(index === 0 ? {} : {
        distinct_reason: `Keep ${title} as a separate layout fixture.`,
        creation_provenance: { actor_user_id: humanId, evidence_method: "local_default" as const, credential_id: null },
      }),
    })).map((result) => {
      if (result.outcome === "active_candidates") throw new Error("explicit layout fixture publication conflicted");
      return result.briefing_id;
    });
    setSetting(db, "user.operator_id", humanId);

    const firstBundle = await router.invoke({ method: "POST", url: "/api/briefing-bundles", credential: "human",
      body: { name: "Policy proposal one", briefing_refs: ids } });
    const bundleId = (firstBundle.body as { bundle: { id: string } }).bundle.id;
    const layout = [
      { kind: "briefing", briefing_ref: ids[0] },
      { kind: "briefing", briefing_ref: ids[1] },
      { kind: "briefing", briefing_ref: ids[2] },
      { kind: "subgroup", name: "Skills", briefing_refs: ids.slice(3) },
    ];
    const replaced = await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "human", body: { layout } });
    expect(replaced).toMatchObject({ status: 200, body: { layout_changed: true, bundle: { layout: [
      { kind: "briefing", position: 0, briefing: { id: ids[0], title: "Global" } },
      { kind: "briefing", position: 1, briefing: { id: ids[1], title: "Codex" } },
      { kind: "briefing", position: 2, briefing: { id: ids[2], title: "Claude" } },
      { kind: "subgroup", position: 3, name: "Skills", briefings: ids.slice(3)
        .map((id, position) => ({ position, briefing: { id } })) },
    ] } } });
    expect((replaced.body as { bundle: { layout: Array<{ name?: string }> } }).bundle.layout
      .some((entry) => entry.name === "Policy")).toBe(false);
    expect((replaced.body as { bundle: { members: unknown[] } }).bundle.members).toHaveLength(7);

    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "human", body: { layout: [{ kind: "subgroup", name: "Empty", briefing_refs: [] }] } }))
      .toMatchObject({ status: 400, body: { error: expect.stringContaining("nonempty") } });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "human", body: { layout: [
        { kind: "subgroup", name: "Skills", briefing_refs: [ids[3]] },
        { kind: "subgroup", name: "Skills", briefing_refs: [ids[4]] },
      ] } })).toMatchObject({ status: 400, body: { error: expect.stringContaining("duplicate subgroup") } });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "human", body: { layout: [
        { kind: "briefing", briefing_ref: ids[0] },
        { kind: "subgroup", name: "Skills", briefing_refs: [ids[0]] },
      ] } })).toMatchObject({ status: 400, body: { error: expect.stringContaining("duplicate Briefings") } });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-bundles/${bundleId}`,
      credential: "human", body: { layout: [
        { kind: "subgroup", name: "Outer", briefing_refs: [ids[0]], layout: [] },
      ] } })).toMatchObject({ status: 400, body: { error: expect.stringContaining("unsupported field") } });

    const secondBundle = await router.invoke({ method: "POST", url: "/api/briefing-bundles", credential: "human",
      body: { name: "Policy proposal two", briefing_refs: [ids[0]] } });
    const secondBundleId = (secondBundle.body as { bundle: { id: string } }).bundle.id;
    const ungrouped = await router.invoke({ method: "POST", url: "/api/briefing-bundles", credential: "human",
      body: { name: "Ungrouped", briefing_refs: [ids[1]] } });
    expect(ungrouped.status).toBe(201);

    expect(await router.invoke({ method: "POST", url: "/api/briefing-groups", credential: "session:agent-schedule",
      body: { name: "Rejected", bundle_refs: [] } })).toMatchObject({
      status: 403, body: { code: "briefing_group_publisher_credential_required" },
    });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-groups", credential: "agent-schedule",
      body: { name: "Agent-created empty group", bundle_refs: [] } })).toMatchObject({ status: 201 });
    const createdGroup = await router.invoke({ method: "POST", url: "/api/briefing-groups", credential: "human",
      body: { name: "Sparse policy", bundle_refs: [bundleId] } });
    expect(createdGroup).toMatchObject({ status: 201, body: { group: { name: "Sparse policy",
      updates: [{ id: bundleId, layout: expect.any(Array) }] } } });
    const groupId = (createdGroup.body as { group: { id: string } }).group.id;
    expect(await router.invoke({ method: "GET", url: `/api/briefing-bundles/${bundleId}`,
      credential: "session:agent-schedule" })).toMatchObject({ status: 200, body: { bundle: { layout: [] } } });
    expect(await router.invoke({ method: "GET", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule" })).toMatchObject({ status: 200, body: { bundle: {
      layout: [
        { kind: "briefing", briefing: { id: ids[0] } },
        { kind: "briefing", briefing: { id: ids[1] } },
        { kind: "briefing", briefing: { id: ids[2] } },
        { kind: "subgroup", name: "Skills", briefings: ids.slice(3)
          .map((id) => ({ briefing: { id } })) },
      ],
    } } });
    setSetting(db, "user.operator_id", "");
    expect(await router.invoke({ method: "GET", url: `/api/briefing-bundles/${bundleId}`,
      credential: "agent-schedule" })).toMatchObject({
      status: 403, body: { code: "briefing_layout_operator_required" },
    });
    setSetting(db, "user.operator_id", humanId);
    const agentGroupRead = await router.invoke({ method: "GET", url: `/api/briefing-groups/${groupId}`,
      credential: "agent-schedule" });
    expect(agentGroupRead).toMatchObject({ status: 200, body: { group: {
      updates: [{ id: bundleId, members: ids.map((id) => ({ briefing: { id } })) }],
    } } });
    expect(await router.invoke({ method: "POST", url: `/api/briefing-groups/${groupId}/updates`,
      credential: "session:human", body: { bundle_ref: secondBundleId } })).toMatchObject({
      status: 403, body: { code: "briefing_group_update_publisher_credential_required" },
    });
    const added = await router.invoke({ method: "POST", url: `/api/briefing-groups/${groupId}/updates`,
      credential: "human", body: { bundle_ref: secondBundleId } });
    expect(added).toMatchObject({ status: 200, body: { added: true, group: { updates: [
      { id: bundleId }, { id: secondBundleId },
    ] } } });
    expect(await router.invoke({ method: "PUT", url: `/api/briefing-groups/${groupId}/configuration`,
      credential: "session:agent-schedule", body: {
        current_bundle_ref: bundleId, bundle_refs: [secondBundleId],
      } })).toMatchObject({
      status: 403, body: { code: "briefing_group_update_publisher_credential_required" },
    });
    expect(await router.invoke({ method: "PUT", url: `/api/briefing-groups/${groupId}/configuration`,
      credential: "human", body: { current_bundle_ref: bundleId, bundle_refs: [bundleId] } }))
      .toMatchObject({ status: 400, body: { error: expect.stringContaining("must not also appear") } });
    const configured = await router.invoke({ method: "PUT",
      url: `/api/briefing-groups/briefing-group:${groupId.slice(0, 8)}/configuration`,
      credential: "agent-schedule", body: { current_bundle_ref: bundleId, bundle_refs: [secondBundleId] } });
    expect(configured).toMatchObject({ status: 200, body: { changed: true, group: {
      current: { id: bundleId }, updates: [{ id: secondBundleId }],
    } } });
    const authId = "route-auth-0000000000000000000000000";
    const mergeHead = "d".repeat(40);
    db.prepare(`INSERT INTO auth_requests (
      id, command, title, status, created_at, updated_at, resolved_at, expires_at,
      exit_code, output, repo, base_branch, head_branch, type, merge_head_sha
    ) VALUES (?, 'git merge', 'Merge proposal', 'completed', 1, 2, 2, 999999,
      0, '', 'dotfiles', 'main', 'feature/policy', 'merge', ?)`)
      .run(authId, mergeHead);
    const promoted = await router.invoke({ method: "POST",
      url: `/api/briefing-groups/${groupId}/promotions/apply`, credential: "human", body: {
        expected_base_bundle_ref: bundleId,
        proposal_bundle_ref: secondBundleId,
        auth_request_ref: authId,
        merge_head_sha: mergeHead,
      } });
    expect(promoted).toMatchObject({ status: 200, body: {
      changed: true,
      group: { current: { id: secondBundleId }, updates: [], history: [{
        kind: "promoted", prior_base: { id: bundleId }, proposal: { id: secondBundleId },
      }] },
    } });
    expect(await router.invoke({ method: "POST",
      url: `/api/briefing-groups/${groupId}/promotions/apply`, credential: "human", body: {
        expected_base_bundle_ref: bundleId,
        proposal_bundle_ref: secondBundleId,
        auth_request_ref: authId,
        merge_head_sha: mergeHead,
      } })).toMatchObject({ status: 200, body: { changed: false } });
    expect(await router.invoke({ method: "POST", url: "/api/briefing-groups", credential: "human",
      body: { name: "Other", bundle_refs: [bundleId] } })).toMatchObject({
      status: 409, body: { code: "briefing_bundle_already_grouped" },
    });
    expect(await router.invoke({ method: "PATCH", url: `/api/briefing-groups/${groupId}`,
      credential: "session:agent-schedule", body: { name: "Rejected" } })).toMatchObject({
      status: 403, body: { code: "briefing_group_name_publisher_credential_required" },
    });
    const renamed = await router.invoke({ method: "PATCH", url: `/api/briefing-groups/briefing-group:${groupId.slice(0, 8)}`,
      credential: "agent-schedule", body: { name: "Sparse policy review" } });
    expect(renamed).toMatchObject({ status: 200, body: { changed: true,
      group: { id: groupId, name: "Sparse policy review" } } });
    const listedBundles = await router.invoke({ method: "GET", url: "/api/briefing-bundles", credential: "human" });
    expect(listedBundles.status).toBe(200);
    expect((listedBundles.body as { bundles: Array<{ name: string }> }).bundles.some((bundle) => bundle.name === "Ungrouped"))
      .toBe(true);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:group-created", { group_id: groupId });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:group-update-added", {
      group_id: groupId, bundle_id: secondBundleId,
    });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:group-configuration-updated", {
      group_id: groupId,
    });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:group-name-updated", { group_id: groupId });
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith("briefing:group-proposal-promoted", {
      group_id: groupId, proposal_bundle_id: secondBundleId, prior_base_bundle_id: bundleId,
    });
  });

});
