import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { getArtifactContent } from "../src/artifact-content.js";
import { type Db } from "../src/db.js";
import {
  getArtifact,
  ingestArtifact,
  listArtifacts,
  listArtifactSeries,
  registerArtifactLink,
  snapshotArtifactBytes,
} from "../src/provider-artifacts.js";
import {
  recordArtifactVersion,
  resolveArtifactRef,
  resolveArtifactRefReadonlyFull,
} from "./helpers/artifact-http-write-fixtures.js";

let db: Db;
let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-canonical-consumers-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

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
});
