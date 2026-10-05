import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertRawLedgerProject } from "../helpers/ledger-fixtures.js";
import { getArtifactContent } from "../../src/artifact-content.js";
import { openDb, type Db } from "../../src/db.js";
import {
  getArtifact,
  getArtifactDraft,
  ingestArtifact,
  listArtifacts,
  listArtifactSeries,
  rebaseArtifactDraft,
  registerArtifactAlias,
  registerArtifactLink,
  resolveAndLinkArtifact,
  saveArtifactDraft,
  snapshotArtifactBytes,
} from "../../src/provider-artifacts.js";
import {
  publishArtifactDraft,
  recordArtifactVersion,
  resolveArtifactRef,
  resolveArtifactRefReadonlyFull,
} from "../helpers/artifact-http-write-fixtures.js";

let db: Db;
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-canonical-consumers-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function canonicalRefs(recorded: ReturnType<typeof recordArtifactVersion>): {
  logical: string;
  version: string;
  blob: string;
} {
  return {
    logical: recorded.series.id.replace(/^artifact-series:/, "artifact:"),
    version: recorded.version.id,
    blob: `artifact-blob:${recorded.artifact.content_hash}`,
  };
}

function recordManaged(name: string, content: string, now: number, repoId?: string) {
  return recordArtifactVersion(db, {
    source_kind: "managed",
    provider_id: "canonical-consumer-test",
    role: "instructions",
    logical_name: name,
    title: name,
    content,
    series_key: `managed:canonical-consumer-test:${name}`,
    repo_id: repoId,
    metadata: { logical_marker: name },
  }, now, tempDir);
}

describe("canonical artifact compatibility consumers", () => {
  it("searches public artifact identity prefixes across complete version history", () => {
    const first = recordManaged("searchable-identity", "v1\n", 1000);
    recordManaged("searchable-identity", "v2\n", 1001);
    recordManaged("unrelated-identity", "other\n", 1002);

    const refs = canonicalRefs(first);
    const publicRefs = [
      refs.logical,
      first.series.id,
      refs.version,
      refs.blob,
    ];

    for (const ref of publicRefs) {
      const separator = ref.indexOf(":");
      const type = ref.slice(0, separator);
      const prefix = ref.slice(separator + 1, separator + 5);
      expect(prefix).toHaveLength(4);

      expect(listArtifactSeries(db, { q: prefix.toUpperCase() }).map((item) => item.id))
        .toContain(first.series.id);
      expect(listArtifactSeries(db, { q: `${type.toUpperCase()}:${prefix.toUpperCase()}` })
        .map((item) => item.id)).toContain(first.series.id);
    }

    // Identity prefix matching extends the existing human-readable substring
    // search; it does not turn title/name matching into prefix-only matching.
    expect(listArtifactSeries(db, { q: "ABLE-IDENT" }).map((item) => item.id))
      .toContain(first.series.id);
  });

  it("paginates canonical series and filtered matches beyond the first 500 blobs", () => {
    const insertBlob = db.prepare(
      `INSERT INTO artifact_blob (id, content_hash, role, storage_uri, created_at)
       VALUES (?, ?, 'bulk-filter', 'file:///fixture-list-only', ?)`,
    );
    const insertArtifact = db.prepare(
      `INSERT INTO artifact (
        id, identity_key, source_kind, latest_version_id, version_count, created_at, updated_at
      ) VALUES (?, ?, 'managed', ?, 1, ?, ?)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO artifact_version (
        id, artifact_id, version_no, blob_id, source_kind, content_hash, custody_mode, created_at
      ) VALUES (?, ?, 1, ?, 'managed', ?, 'managed', ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 505; index += 1) {
        const suffix = index.toString().padStart(3, "0");
        const hash = index.toString(16).padStart(64, "0");
        const blobId = `artifact-blob:${hash}`;
        const artifactId = `artifact:bulk-${suffix}`;
        const versionId = `artifact-version:bulk-${suffix}`;
        insertBlob.run(blobId, hash, index);
        insertArtifact.run(artifactId, `bulk:${suffix}`, versionId, index, index);
        insertVersion.run(versionId, artifactId, blobId, hash, index);
      }
    })();

    const expected = [4, 3, 2, 1, 0].map((index) =>
      `artifact-series:bulk-${index.toString().padStart(3, "0")}`
    );
    expect(listArtifactSeries(db, { offset: 500, limit: 5 }).map((series) => series.id)).toEqual(expected);
    expect(listArtifactSeries(db, { role: "bulk-filter", offset: 500, limit: 5 })
      .map((series) => series.id)).toEqual(expected);
  });

  it("keeps new ingest, reference, snapshot, and version writes canonical-only", () => {
    const ingested = ingestArtifact(db, {
      content: "canonical ingest\n",
      custody_mode: "managed",
      media_type: "text/plain",
    }, 900, tempDir);
    const reference = resolveArtifactRef(db, "https://example.invalid/report.md", 901);
    expect(reference.status).toBe("unresolved");

    const promotableBytes = Buffer.from("promote me\n", "utf8");
    const promotableHash = crypto.createHash("sha256").update(promotableBytes).digest("hex");
    ingestArtifact(db, {
      content_buffer: promotableBytes,
      custody_mode: "managed",
    }, 902, tempDir);
    const promoted = snapshotArtifactBytes(db, {
      ref: `artifact-blob:${promotableHash}`,
      content_buffer: promotableBytes,
      custody_mode: "managed",
    }, 903, tempDir);
    expect(promoted).toMatchObject({
      id: `artifact-blob:${promotableHash}`,
      custody_mode: "managed",
      availability: "present",
    });

    const first = recordManaged("writer-authority", "v1\n", 904);
    const repeated = recordManaged("writer-authority", "v1\n", 905);
    const second = recordManaged("writer-authority", "v2\n", 906);
    expect(repeated).toMatchObject({ created: false, version: { id: first.version.id, version_no: 1 } });
    expect(second).toMatchObject({ created: true, version: { version_no: 2 } });
    expect(second.series.version_count).toBe(2);

    for (const table of ["artifacts", "artifact_series", "artifact_versions"]) {
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)).toEqual({ n: 0 });
    }
    expect(getArtifact(db, ingested.id)).toMatchObject({ id: ingested.id, content_hash: ingested.content_hash });
    expect(resolveArtifactRefReadonlyFull(db, second.version.id)).toMatchObject({
      status: "resolved",
      artifact: { id: second.artifact.id },
      artifact_version: { version_no: 2 },
    });
  });

  it("projects canonical-only blobs through legacy get, alias, list, link, and content contracts", () => {
    const artifact = ingestArtifact(db, {
      content: "canonical bytes\n",
      media_type: "text/plain",
      filename: "canonical.txt",
      custody_mode: "managed",
    }, 1000, tempDir);
    const fileRef = artifact.uri;
    const link = registerArtifactLink(db, artifact.id, {
      entity_type: "issue",
      entity_id: "issue-canonical",
      link_type: "evidence",
    }, 1001);
    const association = db.prepare(
      "SELECT blob_id, target_type, target_id FROM artifact_links WHERE id = ?",
    ).get(link?.id) as Record<string, unknown>;

    expect(association).toMatchObject({
      blob_id: `artifact-blob:${artifact.content_hash}`,
      target_type: "artifact_blob",
      target_id: `artifact-blob:${artifact.content_hash}`,
    });

    expect(db.prepare(
      "SELECT blob_id FROM artifact_aliases WHERE normalized_ref = ?",
    ).get(fileRef)).toEqual({ blob_id: `artifact-blob:${artifact.content_hash}` });
    expect(db.prepare(
      "SELECT blob_id FROM artifact_links WHERE id = ?",
    ).get(link?.id)).toEqual({ blob_id: `artifact-blob:${artifact.content_hash}` });

    const projected = getArtifact(db, `artifact-blob:${artifact.content_hash}`);
    expect(projected).toMatchObject({
      id: artifact.id,
      content_hash: artifact.content_hash,
      custody_mode: "managed",
      availability: "present",
    });
    expect(resolveArtifactRefReadonlyFull(db, fileRef)).toMatchObject({
      status: "resolved",
      artifact: { id: artifact.id, content_hash: artifact.content_hash },
    });
    expect(listArtifacts(db, { linkedEntityId: "issue-canonical" })).toEqual([
      expect.objectContaining({ id: artifact.id, content_hash: artifact.content_hash }),
    ]);
    expect(getArtifactContent(db, `artifact-blob:${artifact.content_hash}`)).toMatchObject({
      artifact_id: artifact.id,
      status: "available",
      preview: { text: "canonical bytes\n" },
    });
  });

  it("reads canonical-only drafts through stable projection fields", () => {
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "instructions",
      role: "instructions",
      logical_name: "canonical-instructions",
      title: "Canonical instructions",
      content: "# Canonical\n\nUse canonical targets.\n",
      series_key: "managed:instructions:instructions:canonical-instructions",
    }, 2000, tempDir);
    saveArtifactDraft(db, {
      ref: recorded.series.id,
      content: "# Draft\n",
    }, 2001);

    expect(getArtifactDraft(db, recorded.version.id)).toMatchObject({
      series_id: recorded.series.id,
      base_version_id: recorded.version.id,
      base_version_no: 1,
      content: "# Draft\n",
      stale: false,
    });
  });

  it("creates canonical-only living and pinned-version links with complete typed targets", () => {
    const first = recordManaged("linked", "linked v1\n", 3200);
    const second = recordManaged("linked", "linked v2\n", 3201);
    const firstRefs = canonicalRefs(first);
    const secondRefs = canonicalRefs(second);

    const living = resolveAndLinkArtifact(db, {
      ref: secondRefs.logical,
      entity_type: "session",
      entity_id: "session-living",
      link_kind: "living",
    }, 3202).link!;
    const pinned = resolveAndLinkArtifact(db, {
      ref: firstRefs.version,
      entity_type: "session",
      entity_id: "session-pinned",
    }, 3203).link!;

    expect(db.prepare(
      `SELECT blob_id, target_type, target_id, fallback_version_id
         FROM artifact_links WHERE id = ?`,
    ).get(living.id)).toEqual({
      blob_id: secondRefs.blob,
      target_type: "artifact",
      target_id: secondRefs.logical,
      fallback_version_id: secondRefs.version,
    });
    expect(db.prepare(
      `SELECT blob_id, target_type, target_id, fallback_version_id
         FROM artifact_links WHERE id = ?`,
    ).get(pinned.id)).toEqual({
      blob_id: firstRefs.blob,
      target_type: "artifact_version",
      target_id: firstRefs.version,
      fallback_version_id: null,
    });
  });

  it("saves, rebases, and publishes a stale draft", () => {
    const first = recordManaged("draft-flow", "base\n", 3300);
    const second = recordManaged("draft-flow", "base\nupstream\n", 3301);
    const firstRefs = canonicalRefs(first);
    const secondRefs = canonicalRefs(second);

    const saved = saveArtifactDraft(db, {
      ref: firstRefs.logical,
      base_version_id: firstRefs.version,
      content: "base\ndraft\n",
    }, 3302);
    expect(saved).toMatchObject({
      base_version_id: firstRefs.version,
      latest_version_id: secondRefs.version,
      stale: true,
    });
    expect(db.prepare(
      "SELECT artifact_id, version_id FROM artifact_drafts",
    ).get()).toEqual({
      artifact_id: firstRefs.logical,
      version_id: firstRefs.version,
    });

    const rebased = rebaseArtifactDraft(db, firstRefs.logical, 3303);
    expect(rebased).toMatchObject({ base_version_id: secondRefs.version, stale: false });
    const published = publishArtifactDraft(db, { ref: firstRefs.logical }, 3304);
    expect(published.result.series.id).toBe(first.series.id);
    expect(published.result.version.version_no).toBe(3);
    expect(getArtifactDraft(db, firstRefs.logical)).toBeNull();
  });

  it("isolates logical projections for a shared blob and applies q, repo, location, and same-row link filters", () => {
    insertRawLedgerProject(db, { name: "repo-a", projectKey: "repo-a" });
    insertRawLedgerProject(db, { name: "repo-b", projectKey: "repo-b" });
    const first = recordManaged("projection-a", "shared projection\n", 3500, "repo-a");
    const second = recordManaged("projection-b", "shared projection\n", 3501, "repo-b");
    const firstRefs = canonicalRefs(first);
    const secondRefs = canonicalRefs(second);
    db.prepare("UPDATE artifact SET metadata_json = ? WHERE id = ?")
      .run('{"logical_only":"a"}', firstRefs.logical);
    db.prepare("UPDATE artifact SET metadata_json = ? WHERE id = ?")
      .run('{"logical_only":"b"}', secondRefs.logical);
    db.prepare(
      `UPDATE artifact_version
          SET observed_path = '/docs/a.md'
        WHERE id = ?`,
    ).run(firstRefs.version);
    const matching = resolveAndLinkArtifact(db, {
      ref: firstRefs.version,
      entity_type: "session",
      entity_id: "target-match",
    }, 3502).link!;
    const wrongType = resolveAndLinkArtifact(db, {
      ref: secondRefs.version,
      entity_type: "session",
      entity_id: "target-wrong-type",
    }, 3503).link!;
    registerArtifactLink(db, first.artifact.id, {
      entity_type: "issue",
      entity_id: "cross-row-id",
    }, 3504);
    db.prepare("UPDATE artifact_links SET target_type = 'artifact_blob', target_id = ? WHERE id = ?")
      .run(firstRefs.version, wrongType.id);

    expect(getArtifact(db, firstRefs.logical)?.metadata).toMatchObject({ logical_only: "a" });
    expect(getArtifact(db, secondRefs.logical)?.metadata).toMatchObject({ logical_only: "b" });
    expect(getArtifact(db, firstRefs.blob)?.metadata).not.toHaveProperty("logical_only");
    expect(listArtifacts(db, { q: `artifact:sha256:${first.artifact.content_hash}` })).toHaveLength(1);
    expect(listArtifacts(db, { repo: "repo-a" })).toHaveLength(1);
    expect(listArtifacts(db, { location: "/docs/a.md" })).toHaveLength(1);
    expect(listArtifacts(db, {
      linkedTargetType: "artifact_version",
      linkedTargetId: firstRefs.version,
    }).map((artifact) => artifact.content_hash)).toEqual([first.artifact.content_hash]);
    expect(listArtifacts(db, {
      linkedEntityType: "session",
      linkedEntityId: "cross-row-id",
    })).toEqual([]);
    expect(db.prepare("SELECT target_type, target_id FROM artifact_links WHERE id = ?")
      .get(matching.id)).toEqual({ target_type: "artifact_version", target_id: firstRefs.version });
  });
});
