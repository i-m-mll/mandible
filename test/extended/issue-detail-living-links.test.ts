import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { systemAction } from "../../src/identity/resolver.js";
import { buildLedgerIssueDetailProjection } from "../../src/ledger/issue-detail.js";
import { resolveProjectForCheckout } from "../../src/ledger/projects.js";
import { LedgerStore } from "../../src/ledger/store.js";
import { resolveAndLinkArtifact } from "../../src/provider-artifacts.js";
import { recordArtifactVersion } from "../helpers/artifact-http-write-fixtures.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-issue-detail-living-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createIssue(body = ""): string {
  const root = path.join(tempDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  const checkout = resolveProjectForCheckout(db, {
    root,
    name: "repo",
    workRepoId: "repo",
    defaultBranch: "main",
    remoteUrl: "",
  });
  const store = new LedgerStore(db);
  return store.createIssue({
    attribution: systemAction(),
    project_id: checkout.project.id,
    title: "Artifacts",
    body,
    kind: "feature",
  }).id;
}

describe("issue detail living artifact links", () => {
  it("skips a pinned link whose stored artifact row is absent", () => {
    const issueId = createIssue();
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO artifact_links (
        id, blob_id, entity_type, entity_id, link_type, source,
        metadata_json, link_kind, target_type, target_id, created_at, updated_at
      ) VALUES (
        'missing_link', 'artifact-blob:${"0".repeat(64)}',
        'issue', ?, 'references', 'test', '{}', 'pinned',
        'artifact_blob', 'artifact-blob:${"0".repeat(64)}', 10, 10
      )`,
    ).run(issueId);
    db.pragma("foreign_keys = ON");

    const detail = buildLedgerIssueDetailProjection(db, issueId);

    expect(detail.associated_artifacts).toEqual([]);
  });

  it("keeps pinned links on stored bytes while living links re-resolve latest", () => {
    const issueId = createIssue();
    const v1 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      logical_name: "report",
      content: "v1\n",
      media_type: "text/plain",
      role: "report",
    }, 1000);
    resolveAndLinkArtifact(db, {
      ref: v1.version.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "pinned",
    }, 1100);
    resolveAndLinkArtifact(db, {
      ref: v1.series.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "living",
      link_kind: "living",
    }, 1200);
    const v2 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      logical_name: "report",
      content: "v2\n",
      media_type: "text/plain",
      role: "report",
    }, 2000);

    const artifacts = buildLedgerIssueDetailProjection(db, issueId).associated_artifacts;

    const pinned = artifacts.find((artifact) => artifact.content_hash === v1.artifact.content_hash);
    const living = artifacts.find((artifact) => artifact.content_hash === v2.artifact.content_hash);
    expect(pinned).toMatchObject({
      content_hash: v1.artifact.content_hash,
      pin_state: "pinned",
      resolved_version_no: null,
      is_latest: null,
    });
    expect(pinned?.links[0]).toMatchObject({
      link_kind: "pinned",
      resolved_version_no: null,
      target_type: "artifact_version",
      target_id: v1.version.id,
    });
    expect(living).toMatchObject({
      content_hash: v2.artifact.content_hash,
      pin_state: "living",
      series_id: v1.series.id,
      resolved_version_no: 2,
      is_latest: true,
    });
    expect(living?.warnings).toContain("series_latest_not_pinned");
    expect(living?.links[0]).toMatchObject({
      link_kind: "living",
      series_id: v1.series.id,
      resolved_version_no: 2,
      target_type: "artifact",
    });
  });

  it.each([
    { label: "living link newer", livingAt: 1200, pinnedAt: 1100 },
    { label: "pinned link newer", livingAt: 1100, pinnedAt: 1200 },
  ])("keeps living badge metadata when pinned and living links merge to the same artifact ($label)", (
    { livingAt, pinnedAt },
  ) => {
    const issueId = createIssue();
    const version = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      logical_name: "same-artifact",
      content: "only version\n",
      media_type: "text/plain",
      role: "report",
    }, 1000);
    const livingLink = resolveAndLinkArtifact(db, {
      ref: version.series.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "living",
      link_kind: "living",
    }, livingAt).link;
    const pinnedLink = resolveAndLinkArtifact(db, {
      ref: version.version.id,
      entity_type: "issue",
      entity_id: issueId,
      link_type: "references",
      role: "pinned",
    }, pinnedAt).link;

    const artifacts = buildLedgerIssueDetailProjection(db, issueId).associated_artifacts;

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: version.version.id,
      pin_state: "living",
      series_id: version.series.id,
      resolved_version_no: 1,
      is_latest: true,
    });
    expect(artifacts[0].links.map((link) => link.id).sort()).toEqual(
      [livingLink?.id, pinnedLink?.id].sort(),
    );
  });

  it("falls back to the stored artifact when a living series is unresolved", () => {
    const issueId = createIssue();
    const v1 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      logical_name: "fallback",
      content: "fallback\n",
      media_type: "text/plain",
    }, 1000);
    db.prepare(
      `INSERT INTO artifact_links (
        id, blob_id, entity_type, entity_id, link_type, source,
        metadata_json, link_kind, series_ref, target_type, target_id,
        created_at, updated_at
      ) VALUES (
        'living_missing', ?, 'issue', ?, 'references', 'test', '{}',
        'living', 'artifact-series:missing',
        'artifact', 'artifact:missing', 10, 10
      )`,
    ).run(`artifact-blob:${v1.artifact.content_hash}`, issueId);

    const artifacts = buildLedgerIssueDetailProjection(db, issueId).associated_artifacts;

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: `artifact-blob:${v1.artifact.content_hash}`,
      pin_state: "living",
      series_id: "artifact-series:missing",
      resolved_version_no: null,
      is_latest: null,
    });
    expect(artifacts[0].warnings).toContain("living_series_unresolved");
  });

  it("extracts artifact-series and artifact-version markdown refs", () => {
    const v1 = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      logical_name: "body-ref",
      content: "body-ref\n",
      media_type: "text/plain",
    }, 1000);
    const issueId = createIssue(`See [${v1.series.id}] and [${v1.version.id}].`);

    const artifacts = buildLedgerIssueDetailProjection(db, issueId).associated_artifacts;

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content_hash).toBe(v1.artifact.content_hash);
    expect(artifacts[0]).toMatchObject({
      title: null,
      logical_name: "body-ref",
    });
    expect(artifacts[0].refs.sort()).toEqual([v1.series.id, v1.version.id].sort());
  });
});
