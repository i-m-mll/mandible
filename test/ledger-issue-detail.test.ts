import { registerArtifactAlias } from "../src/provider-artifacts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import {
  buildLedgerIssueDetailInitialProjection,
  buildLedgerIssueDetailProjection,
  buildLedgerIssueDetailProjectionWithProfile,
} from "../src/ledger/issue-detail.js";
import {
  getLedgerIssueDetailForRoute,
  resolveLedgerIssueIdForRoute,
} from "../src/ledger/issue-projection.js";
import {
  linkAuthRequestToLedgerIssue,
  linkSessionToLedgerIssue,
  linkWorkUnitToLedgerIssue,
} from "../src/ledger/operational-links.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { addAttributionEvidence, addCredential, createUser } from "../src/users/store.js";

let tempDir = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-detail-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject(name: string) {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name,
    workRepoId: name,
    defaultBranch: "main",
    remoteUrl: "",
  });
}

function insertSession(id: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (id, app, status, branch, task, created_at, updated_at, last_active)
     VALUES (?, 'codex', ?, 'feature/detail', 'Implement detail', ?, ?, ?)`,
  ).run(id, status, "2026-05-16T12:00:00.000Z", "2026-05-16T12:05:00.000Z", "2026-05-16T12:05:00.000Z");
}

function insertAuthRequest(id: string, repoRoot: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO auth_requests (
      id, type, command, title, repo, base_branch, head_branch,
      execution_mode, status, created_at, updated_at, resolved_at,
      expires_at, output, approval_source
    ) VALUES (?, 'merge', 'git merge feature/detail', 'Merge feature/detail',
      ?, 'main', 'feature/detail', 'daemon', 'completed', ?, ?, ?, ?, '', 'manual')`,
  ).run(id, repoRoot, now, now, now, now + 60_000);
}

function insertArtifact(id: string, hash: string, uri: string): void {
  db.prepare(
    `INSERT INTO artifact_blob (
       id, algorithm, content_hash, storage_uri, media_type, role, size_bytes,
       provider_id, manifest_id, created_at
     ) VALUES (
       ?, 'sha256', ?, ?, 'text/markdown', 'report', 42,
       'provider_1', 'manifest_1', 1000
     )`,
  ).run(`artifact-blob:${hash}`, hash, uri);
}

describe("ledger issue detail projection", () => {
  it("resolves attributed authors and preserves legacy display text verbatim", () => {
    const checkout = createProject("attribution-repo");
    const user = createUser(db, {
      slug: "read-agent",
      kind: "agent",
      display_name: "Read Surface Agent",
    });
    const credential = addCredential(db, user.id, {
      type: "ssh_key",
      fingerprint: `SHA256:${"R".repeat(43)}`,
      label: "Review signing key",
    });
    const evidence = addAttributionEvidence(db, {
      evidence_method: "credential_signature",
      credential_id: credential.id,
    });
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      project_id: checkout.project.id,
      title: "Attributed issue",
      body: "Attributed body",
      actor_type: "mandible_user",
      author_display: "Mandible",
      attribution: {
        user_id: user.id,
        evidence_method: "credential_signature",
        evidence_id: evidence.id,
      },
    });
    const attributedComment = store.addComment(issue.id, {
      body: "Attributed comment",
      actor_type: "mandible_user",
      author_display: "Mandible",
      source: "session",
      attribution: {
        user_id: user.id,
        evidence_method: "credential_signature",
        evidence_id: evidence.id,
      },
    });
    const legacyComment = store.addComment(issue.id, {
      ...SYSTEM_ACTOR,
      body: "Legacy comment",
      actor_type: "external_adapter",
      author_display: "Imported Author",
      source: "git_bug",
    });
    const legacyDisplay = "  Imported Author (historical)  ";
    db.prepare(
      `UPDATE ledger_comments
          SET author_user_id = NULL, evidence_method = NULL, evidence_id = NULL,
              author_display = ?
        WHERE id = ?`,
    ).run(legacyDisplay, legacyComment.id);

    const projection = JSON.parse(JSON.stringify(buildLedgerIssueDetailProjection(db, issue.id))) as import("../ui/src/api").LedgerIssueDetailProjection;
    const initial = JSON.parse(JSON.stringify(buildLedgerIssueDetailInitialProjection(db, issue.id, { commentLimit: 1 }))) as import("../ui/src/api").LedgerIssueDetailProjection;
    expect(initial).toMatchObject({ detail_stage: "initial", timeline_partial: true, author: projection.author, associated_artifacts: [] });
    expect(projection).toMatchObject({ detail_stage: "full", timeline_partial: false, worker_status: "none", work_notes: "", work_notes_revision: null, issue_branches: [], dependencies: [], dependency_warning: false });
    expect(projection.project).toHaveProperty("work_repo_id");
    expect(projection.author).toMatchObject({
      display: "Read Surface Agent",
      legacy_display: "Mandible",
      attribution: {
        user: { id: user.id, display_name: "Read Surface Agent", kind: "agent" },
        evidence_method: "credential_signature",
        credential: { id: credential.id, label: "Review signing key", type: "ssh_key" },
      },
    });
    expect(projection.comments.find((comment) => comment.id === attributedComment.id)?.author)
      .toMatchObject({ display: "Read Surface Agent", legacy_display: "Mandible" });
    expect(projection.comments.find((comment) => comment.id === legacyComment.id)?.author)
      .toEqual({
        id: null,
        type: "external_adapter",
        display: legacyDisplay,
        legacy_display: legacyDisplay,
        attribution: null,
      });

    const route = getLedgerIssueDetailForRoute(db, {
      getRepos: () => [],
      getRepoById: () => undefined,
    }, checkout.project.project_key, issue.short_id);
    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.detail.author).toBe("Read Surface Agent");
      expect(route.detail.author_legacy_display).toBe("Mandible");
      expect(route.detail.comments.find((comment) => comment.id === legacyComment.id)?.author)
        .toBe(legacyDisplay);
    }
  });

  it("projects comments, relationships, and operational evidence", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);
    const parent = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Umbrella",
      body: "Parent body",
      kind: "umbrella",
      labels: ["umbrella"],
      aliases: [{ alias_kind: "git_bug_human", alias: "par1234", is_primary: true }],
    });
    const child = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "chi1234", is_primary: true }],
    });
    store.addComment(child.id, {
      ...SYSTEM_ACTOR,
      body: "Implementation note",
      actor_type: "agent",
      author_display: "Codex",
      source: "session",
    });
    store.addIssueCheckpoint(child.id, {
      ...SYSTEM_ACTOR,
      kind: "delegation-manifest",
      payload: [{ issue: child.short_id, digest: "before", branch: "feature/detail", scope: "detail" }],
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
    });
    store.addIssueBranch(child.id, "feature/detail", "primary", SYSTEM_ACTOR);
    store.setIssueStatus(child.id, "closed", "delivered", SYSTEM_ACTOR);
    store.setIssueStatus(child.id, "open", null, SYSTEM_ACTOR);
    const relationship = store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: parent.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      metadata: { order: 2 },
    });
    db.prepare(
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_type, source,
        payload_json, occurred_at, observed_at
      ) VALUES (
        'relationship_event_1', 'issue_relationship', ?,
        'relationship.added', 'agent', 'mandible', ?, ?, ?
      )`,
    ).run(relationship.id, JSON.stringify({ source_issue_id: parent.id, target_issue_id: child.id }), Date.now(), Date.now());

    insertSession("sess_live", "active");
    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, kind, state, assigned_session_id,
        created_at, ledger_issue_id
      ) VALUES ('wu_1', 'chi1234', 'repo', 'feature/detail', 'solo', 'open', 'sess_live', ?, ?)`,
    ).run(Date.now(), child.id);
    linkWorkUnitToLedgerIssue(db, {
      work_unit_id: "wu_1",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
    });
    linkSessionToLedgerIssue(db, {
      session_id: "sess_live",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
    });
    insertAuthRequest("auth_1", checkout.checkout.root);
    linkAuthRequestToLedgerIssue(db, {
      auth_request_id: "auth_1",
      issue_ref: "chi1234",
      repo_ref: checkout.checkout.root,
      link_type: "resolves",
    });
    const projection = buildLedgerIssueDetailProjection(db, child.id);

    expect(projection).toMatchObject({
      id: child.id,
      display_id: child.short_id,
      // Issue 3d85f43: repo_id is the canonical project_key. A generic `repo`
      // basename is qualified with the parent directory (so it is never the bare
      // generic `repo`); the checkout name stays the basename.
      project: { repo_id: expect.stringMatching(/-repo$/), repo_name: "repo" },
      title: "Child",
      body: "Child body",
      worker_status: "in_progress",
    });
    expect(projection.labels).toEqual(["feature"]);
    expect(projection.issue_branches).toMatchObject([
      { branch: "feature/detail", role: "primary" },
    ]);
    expect(projection.comments).toMatchObject([
      {
        ordinal: 1,
        body: "Implementation note",
        author: { type: "agent", display: "System", legacy_display: "Codex" },
        source: "session",
      },
    ]);
    expect(projection.checkpoints).toMatchObject([
      {
        kind: "delegation-manifest",
        payload: [{ issue: child.short_id, digest: "before", branch: "feature/detail", scope: "detail" }],
        author: { type: "agent", display: "System", legacy_display: "Codex" },
      },
    ]);
    expect(projection.timeline.slice(0, 2)).toMatchObject([
      { kind: "body", ordinal: 0, body: "Child body" },
      { kind: "comment", ordinal: 1, body: "Implementation note" },
    ]);
    expect(projection.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "checkpoint", checkpoint_kind: "delegation-manifest" }),
      expect.objectContaining({
        kind: "state", event_type: "issue.closed", status: "closed", resolution: "delivered",
      }),
      expect.objectContaining({
        kind: "state", event_type: "issue.reopened", status: "open", resolution: null,
      }),
    ]));
    const lifecycleEvents = projection.timeline.filter((entry) => entry.kind === "state");
    expect(lifecycleEvents.map((entry) => entry.event_type)).toEqual([
      "issue.closed",
      "issue.reopened",
    ]);
    expect(projection.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", event_type: "relationship.added" }),
    ]));
    expect(projection.relationships).toMatchObject([
      {
        direction: "incoming",
        relationship_type: "parent_child",
        related_issue: { display_id: parent.short_id, title: "Umbrella" },
      },
    ]);
    expect(projection.work_units).toMatchObject([
      {
        id: "wu_1",
        branch: "feature/detail",
        liveness: { state: "live", agent_session_id: "sess_live" },
      },
    ]);
    expect(projection.sessions).toMatchObject([
      { id: "sess_live", liveness: "live", process: { status: "active" }, link_type: "worked_on" },
    ]);
    expect(projection.auth_requests).toMatchObject([
      { id: "auth_1", status: "completed", link_type: "resolves" },
    ]);
  });

  it("projects a lightweight initial detail with comments before secondary metadata", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);
    const parent = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Parent",
      body: "Parent body",
      kind: "umbrella",
      labels: ["umbrella"],
    });
    const child = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Child",
      body: "Child body",
      kind: "feature",
      labels: ["feature"],
    });
    store.addComment(child.id, {
      ...SYSTEM_ACTOR,
      body: "Early comment",
      actor_type: "agent",
      author_display: "Codex",
      source: "session",
    });
    store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: parent.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
    });
    insertSession("sess_live", "active");
    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, kind, state, assigned_session_id,
        created_at, ledger_issue_id
      ) VALUES ('wu_1', ?, 'repo', 'feature/detail', 'solo', 'open', 'sess_live', ?, ?)`,
    ).run(child.short_id, Date.now(), child.id);
    linkWorkUnitToLedgerIssue(db, {
      work_unit_id: "wu_1",
      issue_ref: child.short_id,
      repo_ref: checkout.checkout.root,
    });
    insertAuthRequest("auth_1", checkout.checkout.root);
    linkAuthRequestToLedgerIssue(db, {
      auth_request_id: "auth_1",
      issue_ref: child.short_id,
      repo_ref: checkout.checkout.root,
    });

    const projection = buildLedgerIssueDetailInitialProjection(db, child.id);

    expect(projection.detail_stage).toBe("initial");
    expect(projection.body).toBe("Child body");
    expect(projection.comments).toMatchObject([{ body: "Early comment" }]);
    expect(projection.timeline).toMatchObject([
      { kind: "body", body: "Child body" },
      { kind: "comment", body: "Early comment" },
    ]);
    expect(projection.relationships).toEqual([]);
    expect(projection.work_units).toEqual([]);
    expect(projection.sessions).toEqual([]);
    expect(projection.auth_requests).toEqual([]);
    expect(projection.associated_artifacts).toEqual([]);
  });

  it("projects deliberate relationship edges from both endpoint reports", () => {
    const sourceCheckout = createProject("source-repo");
    const targetCheckout = createProject("target-repo");
    const store = new LedgerStore(db);
    const source = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: sourceCheckout.project.id,
      title: "Source",
      body: "Source body",
      kind: "feature",
      aliases: [{ alias_kind: "git_bug_human", alias: "src1234", is_primary: true }],
    });
    const target = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: targetCheckout.project.id,
      title: "Target",
      body: "Target body",
      kind: "feature",
      aliases: [{ alias_kind: "git_bug_human", alias: "tgt1234", is_primary: true }],
    });
    const derived = store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: source.id,
      target_issue_id: target.id,
      relationship_type: "related",
      provenance: "derived",
    });
    const linked = store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
      link_type: "related",
      provenance: "manual",
      note: "manual coordination link",
      metadata: { reason: "handoff" },
    });
    const edge = linked.edges[0];

    const sourceProjection = buildLedgerIssueDetailProjection(db, source.id);
    const targetProjection = buildLedgerIssueDetailProjection(db, target.id);

    expect(sourceProjection.relationships.filter((relationship) =>
      relationship.direction === "outgoing"
      && relationship.relationship_type === "related"
      && relationship.related_issue?.id === target.id
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: derived.id,
        provenance: "derived",
        related_issue: expect.objectContaining({
          display_id: target.short_id,
          project_id: targetCheckout.project.id,
          title: "Target",
        }),
      }),
      expect.objectContaining({
        id: edge.id,
        link_type: "related",
        provenance: "manual",
        note: "manual coordination link",
        metadata: { reason: "handoff" },
        related_issue: expect.objectContaining({
          display_id: target.short_id,
          project_id: targetCheckout.project.id,
          title: "Target",
        }),
      }),
    ]));
    expect(targetProjection.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: edge.id,
        direction: "incoming",
        relationship_type: "related",
        link_type: "related",
        provenance: "manual",
        note: "manual coordination link",
        related_issue: expect.objectContaining({
          display_id: source.short_id,
          project_id: sourceCheckout.project.id,
          title: "Source",
        }),
      }),
    ]));

    store.unlinkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
      link_type: "related",
    });

    const sourceAfterUnlink = buildLedgerIssueDetailProjection(db, source.id);
    const targetAfterUnlink = buildLedgerIssueDetailProjection(db, target.id);
    expect(sourceAfterUnlink.relationships.map((relationship) => relationship.id)).not.toContain(edge.id);
    expect(targetAfterUnlink.relationships.map((relationship) => relationship.id)).not.toContain(edge.id);
    expect(sourceAfterUnlink.relationships.map((relationship) => relationship.id)).toContain(derived.id);
  });

  it("builds relationship timeline events from indexed relationship entities", () => {
    const sourceCheckout = createProject("source-repo");
    const targetCheckout = createProject("target-repo");
    const store = new LedgerStore(db);
    const source = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: sourceCheckout.project.id,
      title: "Source",
      body: "Source body",
      kind: "feature",
    });
    const target = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: targetCheckout.project.id,
      title: "Target",
      body: "Target body",
      kind: "feature",
    });
    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
      link_type: "related",
      provenance: "manual",
      occurred_at: 1000,
    });
    store.unlinkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
      link_type: "related",
      occurred_at: 2000,
    });

    const { projection, profile } = buildLedgerIssueDetailProjectionWithProfile(db, source.id, {
      includeProfile: true,
    });

    expect(projection.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "event", event_type: "relationship.added" }),
      expect.objectContaining({ kind: "event", event_type: "relationship.removed" }),
    ]));
    const phaseNames = profile?.phases.map((phase) => phase.name) ?? [];
    expect(phaseNames).toContain("timeline:relationship_event_keys");
    expect(phaseNames).toContain("timeline:relationship_events");
    expect(phaseNames).not.toContain("timeline:relationship_event_filter");
  });

  it("projects associated artifacts from explicit links and markdown refs", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);
    const linkedHash = "b".repeat(64);
    const linkedId = `artifact:sha256:${linkedHash}`;
    insertArtifact(linkedId, linkedHash, `artifact:${linkedHash}`);
    // URI references resolve through registered provenance; they do not fabricate artifact identities.
    for (const [hash, ref] of [["c".repeat(64), "repo://repo@main/results/summary.md"], ["d".repeat(64), "feedbax://runs/demo"]]) {
      insertArtifact(`artifact-blob:${hash}`, hash, ref);
      registerArtifactAlias(db, { artifactId: `artifact-blob:${hash}`, ref });
    }
    const issue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Artifacts",
      body: `See [artifact:repo://repo@main/results/summary.md] and [artifact:${linkedHash.slice(0, 12)}] for the generated report.`,
      kind: "feature",
      aliases: [{ alias_kind: "git_bug_human", alias: "art1234", is_primary: true }],
    });
    store.addComment(issue.id, {
      ...SYSTEM_ACTOR,
      body: "Follow-up [artifact:feedbax://runs/demo] is also relevant.",
      actor_type: "agent",
      author_display: "Codex",
      source: "session",
    });
    db.prepare(
      `INSERT INTO artifact_links (
        id, blob_id, entity_type, entity_id, link_type, role, repo_id,
        provider_id, source, metadata_json, target_type, target_id, created_at, updated_at
      ) VALUES (
        'link_1', ?, 'issue', ?, 'produced_by', 'report', 'repo',
        'provider_1', 'artifact_registry', '{"path":"results/report.md"}',
        'artifact_blob', ?, 2000, 2000
      )`,
    ).run(`artifact-blob:${linkedHash}`, issue.id, `artifact-blob:${linkedHash}`);

    const projection = JSON.parse(JSON.stringify(buildLedgerIssueDetailProjection(db, issue.id))) as import("../ui/src/api").LedgerIssueDetailProjection;
    const artifacts = projection.associated_artifacts;

    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]).toMatchObject({
      id: `artifact-blob:${linkedHash}`,
      uri: `artifact:${linkedHash}`,
      ref: `artifact-blob:${linkedHash.slice(0, 12)}`,
      pin_state: "pinned", is_latest: null, resolved_version_no: null, series_id: null, warnings: [],
      links: [{ id: "link_1", link_type: "produced_by", role: "report" }],
    });
    expect(artifacts.map((artifact) => artifact.refs).flat().sort()).toEqual([
      `artifact:${linkedHash.slice(0, 12)}`,
      "feedbax://runs/demo",
      "repo://repo@main/results/summary.md",
    ]);
  });

  it("omits no-op state events from the timeline", () => {
    const checkout = createProject("repo");
    const store = new LedgerStore(db);
    const issue = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Closed twice",
      aliases: [{ alias_kind: "git_bug_human", alias: "dup123", is_primary: true }],
    });

    store.setIssueStatus(issue.id, "closed", "delivered", SYSTEM_ACTOR);
    store.setIssueStatus(issue.id, "closed", "delivered", SYSTEM_ACTOR);

    const states = buildLedgerIssueDetailProjection(db, issue.id).timeline.filter(
      (entry) => entry.kind === "state",
    );

    expect(states).toMatchObject([
      { event_type: "issue.closed", status: "closed", resolution: "delivered" },
    ]);
  });

  it("resolves route issue ids without enumerating all scanner repos", () => {
    const checkout = createProject("repo");
    const issue = new LedgerStore(db).createIssue({
      ...SYSTEM_ACTOR,
      project_id: checkout.project.id,
      title: "Route detail",
      body: "Route detail body",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_human", alias: "rou1234", is_primary: true }],
    });
    const workScanner = {
      getRepoById: () => {
        throw new Error("route detail should not read scanner repo state");
      },
      getRepos: () => {
        throw new Error("route detail should not enumerate scanner repos");
      },
    };

    expect(resolveLedgerIssueIdForRoute(db, workScanner, "repo", "rou1234")).toMatchObject({
      ok: true,
      issue_id: issue.id,
      project_id: checkout.project.id,
      repo_id: checkout.project.project_key,
    });
  });
});
