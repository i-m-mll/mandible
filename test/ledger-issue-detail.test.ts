import { registerArtifactAlias } from "../src/provider-artifacts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import {
  buildLedgerIssueDetailInitialProjection,
  buildLedgerIssueDetailProjection,
} from "../src/ledger/issue-detail.js";
import {
  getLedgerIssueDetailForRoute,
} from "../src/ledger/issue-projection.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { addAttributionEvidence, addCredential, createUser } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-detail-"));
  db = migratedMemoryDb();
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

});
