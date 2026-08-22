import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sse.js", () => ({ broadcast: vi.fn() }));

import { setSetting } from "../src/client-auth/settings-kv.js";
import { migrate, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerBriefingRoutes } from "../src/routes/briefing.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { createUser } from "../src/users/store.js";
import { broadcast } from "../src/sse.js";
import { publishBriefingFromArtifactVersion } from "../src/feedback/briefings.js";
import { recordArtifactVersion } from "../src/provider-artifacts.js";

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
  it("creates, appends to, and shows a named bundle without changing its Briefings", async () => {
    const source = path.join(root, "bundle.md");
    fs.writeFileSync(source, "# Bundle member\n");
    const version = recordArtifactVersion(db, { source_kind: "local_only", path: source,
      logical_name: "bundle.md", role: "review-document", media_type: "text/markdown" }).version;
    const first = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: version.id, title: "First" } });
    const second = await router.invoke({ method: "POST", url: "/api/briefings", credential: "human",
      body: { artifact_version_ref: version.id, title: "Second" } });
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
    const briefingIds = ["Global", "Codex", "Claude"].map((title) => publishBriefingFromArtifactVersion(db, {
      briefing_key: `agent-bundle:${title}`,
      title,
      artifact_version_ref: version.id,
      profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
    }).briefing_id);
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
    expect(createdAgain).toMatchObject({ status: 201, body: { artifact_version_id: latestVersion.version.id } });
    expect((created.body as { briefing_id: string }).briefing_id)
      .not.toBe((createdAgain.body as { briefing_id: string }).briefing_id);
    expect(firstVersion.version.id).not.toBe(latestVersion.version.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefings").get()).toEqual({ n: 2 });
    expect(db.prepare(
      "SELECT briefing_id, user_id FROM briefing_members ORDER BY briefing_id",
    ).all()).toEqual([
      { briefing_id: (created.body as { briefing_id: string }).briefing_id, user_id: humanId },
      { briefing_id: (createdAgain.body as { briefing_id: string }).briefing_id, user_id: humanId },
    ].sort((left, right) => left.briefing_id.localeCompare(right.briefing_id)));
    expect(db.prepare("SELECT DISTINCT artifact_version_id, comparison_base_artifact_version_id FROM briefing_rounds").all())
      .toEqual([{ artifact_version_id: latestVersion.version.id,
        comparison_base_artifact_version_id: firstVersion.version.id }]);
    expect(vi.mocked(broadcast).mock.calls.filter(([event]) => event === "briefing:created")).toHaveLength(2);

    const ids = created.body as { briefing_id: string; round_id: string };
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
    const list = await router.invoke({ method: "GET", url: "/api/briefings", credential: "human" });
    expect(list.body).toMatchObject({ briefings: [{ id: ids.briefing_id, latest_round_id: ids.round_id, round_count: 1 }] });
    const detail = await router.invoke({ method: "GET", url: `/api/briefings/${ids.briefing_id}?round=${ids.round_id}`, credential: "human" });
    expect(detail.body).toMatchObject({ selected_round: { id: ids.round_id, binding: { status: "valid" }, items: [{ directive_key: "paper" }] } });
    const answer = await router.invoke({ method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/answers`,
      credential: "human", body: { answers: [{ directive_key: "paper", operation: "set",
        expected_response_event_id: null, value: { verdict: "keep" } }] } });
    expect(answer.status).toBe(200);
    const responseEventId = ((answer.body as { answers: Array<{ response_event_id: string }> }).answers[0]).response_event_id;
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

});
