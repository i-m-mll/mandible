// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { readArtifactBytesFull } from "../src/artifact-content.js";
import { type Db } from "../src/db.js";
import {
  inspectBriefingDestinationRoutes,
  parseBriefingDestinationRouteManifest,
  parseBriefingCompositionRequest,
  planBriefingDestinationRoutes,
  publishBriefingCompositionRun,
  reconcileBriefingDestinationRoutes,
  registerBriefingDestinationRoute,
} from "../src/feedback/briefing-composer.js";
import { createBriefingBundle } from "../src/feedback/briefing-bundles.js";
import { bindBriefingDestinationOwner, createBriefingGroup } from "../src/feedback/briefing-groups.js";
import { publishBriefingFromArtifactVersion } from "../src/feedback/briefings.js";
import { recordArtifactVersion } from "./helpers/artifact-http-write-fixtures.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { createUser } from "../src/users/store.js";

let db: Db;
let root: string;
let publisherId: string;
let humanId: string;

const sha = (letter: string) => letter.repeat(64);

function recordDocument(name: string, source: string, seriesKey?: string, parentVersionId?: string) {
  const file = path.join(root, name);
  fs.writeFileSync(file, source);
  return recordArtifactVersion(db, {
    source_kind: "managed",
    content: source,
    series_key: seriesKey ?? `test:${name}`,
    logical_name: name,
    title: name,
    role: "briefing-document",
    media_type: "text/markdown",
    parent_version_id: parentVersionId ?? null,
  });
}

function publishBase(name: string, source: string) {
  const artifact = recordDocument(name, source);
  const published = publishBriefingFromArtifactVersion(db, {
    briefing_key: `base:${name}`,
    title: name,
    artifact_version_ref: artifact.version.id,
    profile: "mandible-briefing.v3",
    responder_user_ids: [humanId],
  });
  if (published.outcome === "active_candidates") throw new Error("base publication unexpectedly conflicted");
  const logical = db.prepare("SELECT artifact_id FROM artifact_version WHERE id = ?")
    .get(artifact.version.id) as { artifact_id: string };
  return { artifact, published, logicalArtifactId: logical.artifact_id };
}

function request(routeKey: string, baseVersionId: string, overrides: Record<string, unknown> = {}) {
  return parseBriefingCompositionRequest({
    schema: "mandible-briefing-composition@2",
    task_identity: "agent-schedule/daily-digest",
    run_id: "run-1",
    run_key: "run-key-1",
    source: { key: "repo-maintenance", cursor: "cursor-1" },
    source_health: { source: "arxiv-scan", status: "healthy", detail: null, observed_at: 10 },
    responder_user_ids: [humanId],
    quiet_reason: null,
    inputs: [{ route_key: routeKey, expected_artifact_version_ref: baseVersionId,
      agentic_markdown: null }],
    contributions: [{ route_key: routeKey, change_id: "change-1", evidence_ref: "issue:abc1234",
      evidence_digest: sha("a"), occurred_at: 9, slots: { summary: "Prune stale branches" } }],
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(testRuntimeRoot, "composer-"));
  db = migratedMemoryDb();
  setSetting(db, "artifact_root", root);
  publisherId = createUser(db, { slug: "publisher", kind: "agent", display_name: "Publisher" }).id;
  humanId = createUser(db, { slug: "human", kind: "human", display_name: "Human" }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Base-relative Briefing destination composer", () => {
  it("plans and atomically reconciles canonical route manifests with fail-closed template upgrades", () => {
    const destination = publishBase("Managed.md", "# Managed\n\n## Changes\n");
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Managed Base",
      briefingRefs: [destination.published.briefing_id], viewer }, 100);
    const group = createBriefingGroup(db, { key: "managed", name: "Managed", currentBundleRef: bundle.id,
      bundleRefs: [], viewer }, 110);
    bindBriefingDestinationOwner(db, { logicalArtifactRef: destination.logicalArtifactId, groupRef: group.id },
      { userId: humanId, evidenceMethod: "api_token", credentialId: null }, viewer, 115);
    const manifest = (version: number, contributionTemplate = "- {{summary}} ({{evidence_ref}})",
      expectedRevision?: string) =>
      parseBriefingDestinationRouteManifest({
        schema: "mandible-briefing-destination-routes@3",
        routes: [{
          route_key: "managed.changes",
          ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
          logical_artifact_ref: destination.logicalArtifactId,
          publication_mode: "reviewed-document",
          heading: "Changes",
          composer_kind: "deterministic",
          template: { version, contribution_template: contributionTemplate,
            slots: { summary: { type: "string", required: true, max_length: 200 } } },
          limits: { max_contributions: 10, max_document_bytes: 10_000, max_directives: 0 },
        }],
      });

    expect(() => parseBriefingDestinationRouteManifest({
      ...manifest(1), routes: [{ ...manifest(1).routes[0], group_ref: group.id }],
    })).toThrowError(/unsupported field 'group_ref'/);

    expect(planBriefingDestinationRoutes(db, manifest(1))).toMatchObject({ changed: true, routes: [{
      route_key: "managed.changes", action: "create", group_id: group.id,
      logical_artifact_id: destination.logicalArtifactId, template_action: "create",
    }] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_destination_routes").get()).toEqual({ n: 0 });
    expect(reconcileBriefingDestinationRoutes(db, manifest(1), 120)).toMatchObject({ changed: true,
      routes: [{ action: "create" }] });
    expect(reconcileBriefingDestinationRoutes(db, manifest(1), 130)).toMatchObject({ changed: false,
      routes: [{ action: "unchanged", template_action: "reuse" }] });
    const revision = planBriefingDestinationRoutes(db, manifest(2)).routes[0].current_revision;
    expect(planBriefingDestinationRoutes(db, manifest(2))).toMatchObject({ changed: true,
      routes: [{ action: "update", active_template_version: 2, template_action: "create" }] });
    expect(() => reconcileBriefingDestinationRoutes(db, manifest(2), 140)).toThrowError(expect.objectContaining({
      code: "briefing_destination_route_revision_drift",
    }));
    reconcileBriefingDestinationRoutes(db, manifest(2, undefined, revision!), 140);
    expect(inspectBriefingDestinationRoutes(db, "managed.changes")).toMatchObject({ routes: [{
      group_id: group.id, logical_artifact_id: destination.logicalArtifactId,
      active_template_version: 2, templates: [{ version: 1 }, { version: 2 }],
    }] });
    expect(() => planBriefingDestinationRoutes(db, manifest(1))).toThrowError(expect.objectContaining({
      code: "briefing_destination_template_regression",
    }));
    expect(() => planBriefingDestinationRoutes(db, manifest(2, "changed {{evidence_ref}}")))
      .toThrowError(expect.objectContaining({ code: "briefing_destination_template_conflict" }));
    expect(() => planBriefingDestinationRoutes(db, {
      ...manifest(2), routes: [{ ...manifest(2).routes[0], publication_mode: "published-report" }],
    })).toThrowError(expect.objectContaining({ code: "briefing_destination_policy_conflict" }));
  });

  it("routes normalized changes, clones Base layout, and queues behind the one active proposal", () => {
    const destination = publishBase("Project.md", "# Project\n\n## Maintenance\n\nExisting item.\n");
    const readme = publishBase("README.md", "# Project collection\n");
    const viewer = { userId: humanId, operator: true };
    const base = createBriefingBundle(db, {
      name: "Project Base", briefingRefs: [readme.published.briefing_id, destination.published.briefing_id], viewer,
    }, 100);
    const group = createBriefingGroup(db, {
      key: "project", name: "Project", currentBundleRef: base.id, bundleRefs: [], viewer,
    }, 110);
    bindBriefingDestinationOwner(db, { logicalArtifactRef: destination.logicalArtifactId, groupRef: group.id },
      { userId: humanId, evidenceMethod: "api_token", credentialId: null }, viewer, 115);
    registerBriefingDestinationRoute(db, {
      route_key: "projects.example.maintenance",
      logical_artifact_id: destination.logicalArtifactId,
      publication_mode: "reviewed-document",
      heading: "Maintenance",
      composer_kind: "deterministic",
      template_version: 1,
      contribution_template: "- {{summary}} ([evidence]({{evidence_ref}}))",
      slots: { summary: { type: "string", required: true, max_length: 200 } },
      limits: { max_contributions: 10, max_document_bytes: 10_000, max_directives: 0 },
    }, 120);

    const first = publishBriefingCompositionRun(db,
      request("projects.example.maintenance", destination.artifact.version.id), publisherId, 200);
    expect(first).toMatchObject({ quiet: false, targets: [{ group_id: group.id, outcome: "proposed",
      base_bundle_id: base.id, proposal_bundle_id: expect.any(String) }] });
    const proposalId = first.targets[0].proposal_bundle_id!;
    expect(db.prepare(`SELECT briefing_id, layout_position, entry_kind FROM briefing_bundle_members
      WHERE bundle_id = ? ORDER BY layout_position`).all(proposalId)).toMatchObject([
      { briefing_id: readme.published.briefing_id, layout_position: 0, entry_kind: "briefing" },
      { briefing_id: expect.not.stringMatching(destination.published.briefing_id), layout_position: 1, entry_kind: "briefing" },
    ]);
    const proposal = db.prepare(`SELECT b.id, b.logical_artifact_id, r.artifact_version_id,
        r.comparison_base_artifact_version_id
      FROM briefing_bundle_members bm JOIN briefings b ON b.id = bm.briefing_id
      JOIN briefing_rounds r ON r.id = b.latest_round_id
      WHERE bm.bundle_id = ? AND b.logical_artifact_id = ?`).get(proposalId, destination.logicalArtifactId) as {
        id: string; logical_artifact_id: string; artifact_version_id: string;
        comparison_base_artifact_version_id: string;
      };
    expect(proposal).toMatchObject({ logical_artifact_id: destination.logicalArtifactId,
      comparison_base_artifact_version_id: destination.artifact.version.id });
    const proposalBytes = readArtifactBytesFull(db, proposal.artifact_version_id);
    expect(proposalBytes.ok && proposalBytes.bytes.toString("utf8"))
      .toContain("Prune stale branches ([evidence](issue:abc1234))");
    expect(db.prepare("SELECT latest_round_id FROM briefings WHERE id = ?").get(destination.published.briefing_id))
      .toEqual({ latest_round_id: destination.published.round_id });

    const queued = publishBriefingCompositionRun(db, request("projects.example.maintenance",
      destination.artifact.version.id, {
        run_id: "run-2", run_key: "run-key-2", source: { key: "repo-maintenance", cursor: "cursor-2" },
        contributions: [{ route_key: "projects.example.maintenance", change_id: "change-2",
          evidence_ref: "issue:def5678", evidence_digest: sha("b"), occurred_at: 20,
          slots: { summary: "Remove obsolete worktree" } }],
      }), publisherId, 300);
    expect(queued.targets).toEqual([{ publication_mode: "reviewed-document",
      group_id: group.id, outcome: "queued", base_bundle_id: base.id,
      proposal_bundle_id: null }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_group_updates WHERE group_id = ?").get(group.id))
      .toEqual({ n: 1 });
  });

  it("stores deterministic quiet receipts without new versions and fails closed on Base drift", () => {
    const baseSource = "# Digest\n\n## Since last review\n\nEvidence evidence-abc1234 is already present.\n";
    const destination = publishBase("Digest.md", baseSource);
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Digest Base",
      briefingRefs: [destination.published.briefing_id], viewer }, 100);
    const group = createBriefingGroup(db, { key: "digest", name: "Digest", currentBundleRef: bundle.id,
      bundleRefs: [], viewer }, 110);
    bindBriefingDestinationOwner(db, { logicalArtifactRef: destination.logicalArtifactId, groupRef: group.id },
      { userId: humanId, evidenceMethod: "api_token", credentialId: null }, viewer, 115);
    registerBriefingDestinationRoute(db, {
      route_key: "digest.since-last-review",
      logical_artifact_id: destination.logicalArtifactId,
      publication_mode: "reviewed-document",
      heading: "Since last review",
      composer_kind: "agentic",
      template_version: 1,
      contribution_template: "",
      slots: {},
      limits: { max_contributions: 5, max_document_bytes: 5_000, max_directives: 0 },
    }, 120);
    const artifactCount = db.prepare("SELECT COUNT(*) AS n FROM artifact_version").get();
    const identical = request("digest.since-last-review", destination.artifact.version.id, {
      inputs: [{ route_key: "digest.since-last-review",
        expected_artifact_version_ref: destination.artifact.version.id, agentic_markdown: baseSource }],
      contributions: [{ route_key: "digest.since-last-review", change_id: "change-1",
        evidence_ref: "evidence-abc1234", evidence_digest: sha("a"), occurred_at: 9, slots: {} }],
    });
    const quiet = publishBriefingCompositionRun(db, identical, publisherId, 200);
    expect(quiet).toMatchObject({ quiet: true, targets: [{ outcome: "unchanged", proposal_bundle_id: null }] });
    expect(publishBriefingCompositionRun(db, identical, publisherId, 201)).toEqual(quiet);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_version").get()).toEqual(artifactCount);
    expect(db.prepare("SELECT quiet_reason FROM briefing_composition_runs WHERE id = ?").get(quiet.receipt_id))
      .toEqual({ quiet_reason: "identical output" });

    const changed = recordDocument("Digest.md", `${baseSource}\nNew Base material.\n`,
      destination.artifact.series.series_key, destination.artifact.version.id);
    const advanced = publishBriefingFromArtifactVersion(db, {
      target_briefing_ref: destination.published.briefing_id,
      viewer,
      title: "Digest.md",
      artifact_version_ref: changed.version.id,
      profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
    }, 300);
    if (advanced.outcome === "active_candidates") throw new Error("Base advance unexpectedly conflicted");
    expect(() => publishBriefingCompositionRun(db, request("digest.since-last-review",
      destination.artifact.version.id, {
        run_id: "run-2", run_key: "run-key-2",
        inputs: [{ route_key: "digest.since-last-review",
          expected_artifact_version_ref: destination.artifact.version.id,
          agentic_markdown: `${baseSource}\nStale candidate.\n` }],
        contributions: [{ route_key: "digest.since-last-review", change_id: "change-2",
          evidence_ref: "issue:def5678", evidence_digest: sha("b"), occurred_at: 20, slots: {} }],
      }), publisherId, 400)).toThrowError(expect.objectContaining({ code: "briefing_destination_base_drift" }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_composition_runs WHERE run_key = 'run-key-2'").get())
      .toEqual({ n: 0 });
  });

  it("publishes repository maintenance as stable Current report rounds without changing group Base", () => {
    const reportSource = "# Repository maintenance\n\n## Findings\n\nNo findings.\n";
    const destination = publishBase("Repository maintenance.md", reportSource);
    const viewer = { userId: humanId, operator: true };
    const bundle = createBriefingBundle(db, { name: "Digest Base",
      briefingRefs: [destination.published.briefing_id], viewer }, 100);
    const group = createBriefingGroup(db, { key: "digest", name: "Digest", currentBundleRef: bundle.id,
      bundleRefs: [], viewer }, 110);
    bindBriefingDestinationOwner(db, { logicalArtifactRef: destination.logicalArtifactId, groupRef: group.id },
      { userId: humanId, evidenceMethod: "api_token", credentialId: null }, viewer, 115);
    registerBriefingDestinationRoute(db, {
      route_key: "digest.repository-maintenance",
      logical_artifact_id: destination.logicalArtifactId,
      publication_mode: "published-report",
      heading: "Findings",
      composer_kind: "agentic",
      template_version: 1,
      contribution_template: "",
      slots: {},
      limits: { max_contributions: 20, max_document_bytes: 20_000, max_directives: 0 },
    }, 120);
    const agentScheduleId = createUser(db, {
      slug: "agent-schedule", kind: "agent", display_name: "Agent schedule",
    }).id;
    const genericAdvance = recordDocument("Generic advance.md", `${reportSource}\nBypass attempt.\n`,
      destination.artifact.series.series_key, destination.artifact.version.id);
    expect(() => publishBriefingFromArtifactVersion(db, {
      target_briefing_ref: destination.published.briefing_id,
      viewer,
      title: "Repository maintenance.md",
      artifact_version_ref: genericAdvance.version.id,
      profile: "mandible-briefing.v3",
      responder_user_ids: [humanId],
    }, 150)).toThrowError(expect.objectContaining({ code: "briefing_report_publication_required" }));

    const firstMarkdown = "# Repository maintenance\n\n## Findings\n\n- Stale branch (evidence-abc1234).\n";
    const missingRoundRequest = request("digest.repository-maintenance", destination.artifact.version.id, {
      task_identity: "agent-schedule/repo-janitor",
      source: { key: "repo-janitor", cursor: "cursor-1" },
      source_health: { source: "repo-janitor", status: "healthy", detail: null, observed_at: 10 },
      inputs: [{ route_key: "digest.repository-maintenance",
        expected_artifact_version_ref: destination.artifact.version.id, agentic_markdown: firstMarkdown }],
      contributions: [{ route_key: "digest.repository-maintenance", change_id: "finding-1",
        evidence_ref: "evidence-abc1234", evidence_digest: sha("a"), occurred_at: 9, slots: {} }],
    });
    expect(() => publishBriefingCompositionRun(db, missingRoundRequest, agentScheduleId, 190))
      .toThrowError(expect.objectContaining({ code: "briefing_destination_current_round_required" }));
    const firstRequest = parseBriefingCompositionRequest({ ...missingRoundRequest,
      inputs: [{ ...missingRoundRequest.inputs[0], expected_current_round_id: destination.published.round_id }],
    });
    const first = publishBriefingCompositionRun(db, firstRequest, agentScheduleId, 200);
    expect(first).toMatchObject({ quiet: false, targets: [{ publication_mode: "published-report",
      group_id: group.id, logical_artifact_id: destination.logicalArtifactId,
      briefing_id: destination.published.briefing_id, outcome: "published",
      previous_round_id: destination.published.round_id, current_round_id: expect.any(String),
      previous_artifact_version_id: destination.artifact.version.id,
      current_artifact_version_id: expect.any(String) }] });
    const firstTarget = first.targets[0];
    if (firstTarget.publication_mode !== "published-report") throw new Error("report target expected");
    expect(firstTarget.current_round_id).not.toBe(destination.published.round_id);
    expect(publishBriefingCompositionRun(db, firstRequest, agentScheduleId, 201)).toEqual(first);
    expect(db.prepare("SELECT current_bundle_id FROM briefing_groups WHERE id = ?").get(group.id))
      .toEqual({ current_bundle_id: bundle.id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_group_updates WHERE group_id = ?").get(group.id))
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT id, ordinal FROM briefing_rounds WHERE briefing_id = ? ORDER BY ordinal")
      .all(destination.published.briefing_id)).toMatchObject([
        { id: destination.published.round_id, ordinal: 1 },
        { id: firstTarget.current_round_id, ordinal: 2 },
      ]);

    const secondRequest = request("digest.repository-maintenance", firstTarget.current_artifact_version_id, {
      task_identity: "agent-schedule/repo-janitor", run_id: "run-2", run_key: "run-key-2",
      source: { key: "repo-janitor", cursor: "cursor-2" },
      source_health: { source: "repo-janitor", status: "healthy", detail: null, observed_at: 20 },
      inputs: [{ route_key: "digest.repository-maintenance",
        expected_artifact_version_ref: firstTarget.current_artifact_version_id,
        expected_current_round_id: firstTarget.current_round_id, agentic_markdown: firstMarkdown }],
      contributions: [{ route_key: "digest.repository-maintenance", change_id: "finding-2",
        evidence_ref: "evidence-abc1234", evidence_digest: sha("b"), occurred_at: 19, slots: {} }],
    });
    const second = publishBriefingCompositionRun(db, secondRequest, agentScheduleId, 300);
    const secondTarget = second.targets[0];
    if (secondTarget.publication_mode !== "published-report") throw new Error("report target expected");
    expect(secondTarget).toMatchObject({ outcome: "published", briefing_id: destination.published.briefing_id,
      previous_round_id: firstTarget.current_round_id, previous_artifact_version_id: firstTarget.current_artifact_version_id });
    expect(secondTarget.current_round_id).not.toBe(firstTarget.current_round_id);
    expect(secondTarget.current_artifact_version_id).toBe(firstTarget.current_artifact_version_id);
    expect(() => publishBriefingCompositionRun(db, { ...secondRequest, run_id: "changed" }, agentScheduleId, 301))
      .toThrowError(expect.objectContaining({ code: "run_replay_conflict" }));

    const returnToOriginal = request("digest.repository-maintenance", secondTarget.current_artifact_version_id, {
      task_identity: "agent-schedule/repo-janitor", run_id: "run-3", run_key: "run-key-3",
      source: { key: "repo-janitor", cursor: "cursor-3" },
      source_health: { source: "repo-janitor", status: "healthy", detail: null, observed_at: 30 },
      inputs: [{ route_key: "digest.repository-maintenance",
        expected_artifact_version_ref: secondTarget.current_artifact_version_id,
        expected_current_round_id: secondTarget.current_round_id, agentic_markdown: reportSource }],
      contributions: [{ route_key: "digest.repository-maintenance", change_id: "finding-3",
        evidence_ref: "No findings", evidence_digest: sha("c"), occurred_at: 29, slots: {} }],
    });
    const third = publishBriefingCompositionRun(db, returnToOriginal, agentScheduleId, 350);
    const thirdTarget = third.targets[0];
    if (thirdTarget.publication_mode !== "published-report") throw new Error("report target expected");
    expect(thirdTarget).toMatchObject({ previous_round_id: secondTarget.current_round_id,
      current_artifact_version_id: destination.artifact.version.id });

    expect(() => publishBriefingCompositionRun(db, request("digest.repository-maintenance",
      destination.artifact.version.id, {
        task_identity: "agent-schedule/repo-janitor", run_id: "run-stale", run_key: "run-key-stale",
        source: { key: "repo-janitor", cursor: "cursor-stale" },
        source_health: { source: "repo-janitor", status: "healthy", detail: null, observed_at: 40 },
        inputs: [{ route_key: "digest.repository-maintenance",
          expected_artifact_version_ref: destination.artifact.version.id,
          expected_current_round_id: destination.published.round_id, agentic_markdown: reportSource }],
        contributions: [{ route_key: "digest.repository-maintenance", change_id: "finding-stale",
          evidence_ref: "No findings", evidence_digest: sha("d"), occurred_at: 39, slots: {} }],
      }), agentScheduleId, 400)).toThrowError(expect.objectContaining({ code: "briefing_destination_current_drift" }));
    expect(db.prepare("SELECT latest_round_id FROM briefings WHERE id = ?").get(destination.published.briefing_id))
      .toEqual({ latest_round_id: thirdTarget.current_round_id });

    const quiet = parseBriefingCompositionRequest({
      schema: "mandible-briefing-composition@2", task_identity: "agent-schedule/repo-janitor",
      run_id: "run-quiet", run_key: "run-key-quiet",
      source: { key: "repo-janitor", cursor: "cursor-quiet" },
      source_health: { source: "repo-janitor", status: "healthy", detail: null, observed_at: 40 },
      responder_user_ids: [humanId], quiet_reason: "No findings changed",
      inputs: [{ route_key: "digest.repository-maintenance",
        expected_artifact_version_ref: thirdTarget.current_artifact_version_id,
        expected_current_round_id: thirdTarget.current_round_id, agentic_markdown: null }],
      contributions: [],
    });
    const quietReceipt = publishBriefingCompositionRun(db, quiet, agentScheduleId, 500);
    expect(quietReceipt).toMatchObject({ quiet: true, targets: [{ publication_mode: "published-report",
      outcome: "unchanged", previous_round_id: thirdTarget.current_round_id,
      current_round_id: thirdTarget.current_round_id }] });
    expect(db.prepare("SELECT round_count FROM briefings WHERE id = ?").get(destination.published.briefing_id))
      .toEqual({ round_count: 4 });

    expect(() => publishBriefingCompositionRun(db, firstRequest, publisherId, 600))
      .toThrowError(expect.objectContaining({ code: "briefing_destination_publisher_forbidden" }));
  });
});
