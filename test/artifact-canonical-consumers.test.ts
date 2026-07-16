import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getArtifactContent } from "../src/artifact-content.js";
import { openDb, type Db } from "../src/db.js";
import {
  getArtifact,
  getArtifactDraft,
  ingestArtifact,
  listArtifacts,
  publishArtifactDraft,
  rebaseArtifactDraft,
  recordArtifactVersion,
  registerArtifactAlias,
  registerArtifactLink,
  resolveAndLinkArtifact,
  resolveArtifactRefReadonlyFull,
  saveArtifactDraft,
} from "../src/provider-artifacts.js";
import {
  appendSessionInstructionArtifacts,
  computePresetUnion,
  listSessionInstructionArtifacts,
  removeSessionInstructionArtifact,
  replaceSessionInstructionArtifacts,
} from "../src/presets.js";

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

function deleteLegacyArtifacts(): void {
  db.prepare("DELETE FROM artifact_versions").run();
  db.prepare("DELETE FROM artifact_series").run();
  db.prepare("DELETE FROM artifacts").run();
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
  it("projects canonical-only blobs through legacy get, alias, list, link, and content contracts", () => {
    const artifact = ingestArtifact(db, {
      content: "canonical bytes\n",
      media_type: "text/plain",
      filename: "canonical.txt",
      custody_mode: "copy",
    }, 1000, tempDir);
    const fileRef = artifact.uri;
    const link = registerArtifactLink(db, artifact.id, {
      entity_type: "issue",
      entity_id: "issue-canonical",
      link_type: "evidence",
    }, 1001);
    const association = db.prepare(
      "SELECT artifact_id, blob_id, target_type, target_id FROM artifact_links WHERE id = ?",
    ).get(link?.id) as Record<string, unknown>;

    expect(association).toMatchObject({
      artifact_id: artifact.id,
      blob_id: `artifact-blob:${artifact.content_hash}`,
      target_type: "artifact_blob",
      target_id: `artifact-blob:${artifact.content_hash}`,
    });

    db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifact.id);

    expect(db.prepare(
      "SELECT artifact_id, blob_id FROM artifact_aliases WHERE normalized_ref = ?",
    ).get(fileRef)).toEqual({ artifact_id: null, blob_id: `artifact-blob:${artifact.content_hash}` });
    expect(db.prepare(
      "SELECT artifact_id, blob_id FROM artifact_links WHERE id = ?",
    ).get(link?.id)).toEqual({ artifact_id: null, blob_id: `artifact-blob:${artifact.content_hash}` });

    const projected = getArtifact(db, `artifact-blob:${artifact.content_hash}`);
    expect(projected).toMatchObject({
      id: artifact.id,
      content_hash: artifact.content_hash,
      custody_mode: "copy",
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

  it("reads canonical-only session attachments and drafts through stable preset fields", () => {
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "presets",
      role: "instructions",
      logical_name: "canonical-preset",
      title: "Canonical preset",
      content: "# Canonical\n\nUse canonical targets.\n",
      series_key: "managed:presets:instructions:canonical-preset",
    }, 2000, tempDir);
    replaceSessionInstructionArtifacts(db, "session-canonical", [recorded.version.id]);
    saveArtifactDraft(db, {
      ref: recorded.series.id,
      content: "# Draft\n",
    }, 2001);

    db.prepare(
      `UPDATE session_instruction_artifacts
          SET artifact_series_id = NULL, artifact_version_id = NULL`,
    ).run();
    db.prepare("UPDATE artifact_drafts SET series_id = NULL, base_version_id = NULL").run();
    db.prepare("DELETE FROM artifact_versions").run();
    db.prepare("DELETE FROM artifact_series").run();
    db.prepare("DELETE FROM artifacts").run();

    expect(listSessionInstructionArtifacts(db, "session-canonical")).toEqual([
      expect.objectContaining({
        artifact_series_id: recorded.series.id,
        artifact_version_id: recorded.version.id,
        preset_id: recorded.series.id,
        name: "Canonical preset",
        version: 1,
        current_version: 1,
      }),
    ]);
    expect(computePresetUnion([recorded.version.id], db)).toMatchObject({
      text: "# Canonical\n\nUse canonical targets.\n",
    });
    expect(getArtifactDraft(db, recorded.version.id)).toMatchObject({
      series_id: recorded.series.id,
      base_version_id: recorded.version.id,
      base_version_no: 1,
      content: "# Draft\n",
      stale: false,
    });
  });

  it("writes, lists, unions, and removes canonical-only instruction refs without legacy FK targets", () => {
    const logicalRecord = recordManaged("logical-ref", "# Logical\n", 3000);
    const versionRecord = recordManaged("version-ref", "# Version\n", 3001);
    const blobRecord = recordManaged("blob-ref", "# Blob\n", 3002);
    const logical = canonicalRefs(logicalRecord);
    const version = canonicalRefs(versionRecord);
    const blob = canonicalRefs(blobRecord);
    deleteLegacyArtifacts();

    replaceSessionInstructionArtifacts(db, "session-projection", [logical.logical]);
    appendSessionInstructionArtifacts(db, "session-projection", [version.version, blob.blob]);

    expect(db.prepare(
      `SELECT artifact_id, version_id, artifact_series_id, artifact_version_id
         FROM session_instruction_artifacts
        WHERE session_id = ? ORDER BY position`,
    ).all("session-projection")).toEqual([
      { artifact_id: logical.logical, version_id: logical.version, artifact_series_id: null, artifact_version_id: null },
      { artifact_id: version.logical, version_id: version.version, artifact_series_id: null, artifact_version_id: null },
      { artifact_id: blob.logical, version_id: blob.version, artifact_series_id: null, artifact_version_id: null },
    ]);
    expect(listSessionInstructionArtifacts(db, "session-projection").map((row) => row.artifact_version_id))
      .toEqual([logical.version, version.version, blob.version]);
    expect(computePresetUnion([logical.logical, version.version, blob.blob], db).text)
      .toBe("# Logical\n\n\n---\n\n# Version\n\n\n---\n\n# Blob\n");

    removeSessionInstructionArtifact(db, "session-projection", version.version);
    removeSessionInstructionArtifact(db, "session-projection", blob.blob);
    removeSessionInstructionArtifact(db, "session-projection", logical.logical);
    expect(listSessionInstructionArtifacts(db, "session-projection")).toEqual([]);
  });

  it("fails closed when a canonical blob is shared by more than one logical instruction artifact", () => {
    const first = recordManaged("shared-a", "# Shared\n", 3100);
    const sharedBlob = canonicalRefs(first).blob;
    replaceSessionInstructionArtifacts(db, "session-shared", [canonicalRefs(first).logical]);
    recordManaged("shared-b", "# Shared\n", 3101);
    deleteLegacyArtifacts();

    expect(() => replaceSessionInstructionArtifacts(db, "session-shared", [sharedBlob]))
      .toThrow("instruction artifact blob has multiple logical owners");
    expect(listSessionInstructionArtifacts(db, "session-shared")).toEqual([
      expect.objectContaining({ artifact_version_id: canonicalRefs(first).version }),
    ]);
    expect(computePresetUnion([sharedBlob], db)).toEqual({ text: "", tokenEstimate: 0 });
  });

  it("creates canonical-only living and pinned-version links with complete typed targets", () => {
    const first = recordManaged("linked", "linked v1\n", 3200);
    const second = recordManaged("linked", "linked v2\n", 3201);
    const firstRefs = canonicalRefs(first);
    const secondRefs = canonicalRefs(second);
    deleteLegacyArtifacts();

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
      `SELECT artifact_id, blob_id, target_type, target_id, fallback_version_id
         FROM artifact_links WHERE id = ?`,
    ).get(living.id)).toEqual({
      artifact_id: null,
      blob_id: secondRefs.blob,
      target_type: "artifact",
      target_id: secondRefs.logical,
      fallback_version_id: secondRefs.version,
    });
    expect(db.prepare(
      `SELECT artifact_id, blob_id, target_type, target_id, fallback_version_id
         FROM artifact_links WHERE id = ?`,
    ).get(pinned.id)).toEqual({
      artifact_id: null,
      blob_id: firstRefs.blob,
      target_type: "artifact_version",
      target_id: firstRefs.version,
      fallback_version_id: null,
    });
  });

  it("saves, rebases, and publishes a stale draft after all legacy artifact rows are removed", () => {
    const first = recordManaged("draft-flow", "base\n", 3300);
    const second = recordManaged("draft-flow", "base\nupstream\n", 3301);
    const firstRefs = canonicalRefs(first);
    const secondRefs = canonicalRefs(second);
    deleteLegacyArtifacts();

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
      "SELECT artifact_id, version_id, series_id, base_version_id FROM artifact_drafts",
    ).get()).toEqual({
      artifact_id: firstRefs.logical,
      version_id: firstRefs.version,
      series_id: null,
      base_version_id: null,
    });

    const rebased = rebaseArtifactDraft(db, firstRefs.logical, 3303);
    expect(rebased).toMatchObject({ base_version_id: secondRefs.version, stale: false });
    const published = publishArtifactDraft(db, { ref: firstRefs.logical }, 3304);
    expect(published.result.series.id).toBe(first.series.id);
    expect(published.result.version.version_no).toBe(3);
    expect(getArtifactDraft(db, firstRefs.logical)).toBeNull();
  });

  it("prefers canonical retention and association targets over divergent optional legacy ids", () => {
    const canonical = ingestArtifact(db, {
      content: "canonical association\n",
      custody_mode: "copy",
      retention: { pinned: true, policy: "canonical" },
    }, 3400, tempDir);
    const unrelated = ingestArtifact(db, {
      content: "unrelated legacy pointer\n",
      custody_mode: "copy",
    }, 3401, tempDir);
    const alias = registerArtifactAlias(db, {
      artifactId: canonical.id,
      ref: "file:///canonical-association.txt",
      now: 3402,
    });
    const link = registerArtifactLink(db, canonical.id, {
      entity_type: "session",
      entity_id: "association-session",
    }, 3403)!;
    db.prepare("UPDATE artifacts SET pinned = 0, retention_json = '{\"policy\":\"legacy\"}' WHERE id = ?")
      .run(canonical.id);
    db.prepare("UPDATE artifact_aliases SET artifact_id = ? WHERE id = ?").run(unrelated.id, alias.id);
    db.prepare("UPDATE artifact_links SET artifact_id = ? WHERE id = ?").run(unrelated.id, link.id);

    const projected = getArtifact(db, canonical.id)!;
    expect(projected.pinned).toBe(true);
    expect(projected.retention).toMatchObject({ pinned: true, policy: "canonical" });
    expect(projected.aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alias.id, artifact_id: canonical.id }),
    ]));
    expect(projected.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: link.id, artifact_id: canonical.id }),
    ]));
  });

  it("isolates logical projections for a shared blob and applies q, repo, location, and same-row link filters", () => {
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
          SET repo_path = '/docs/a.md', source_repo_id = 'repo-a',
              source_locator_json = '{"path":"/docs/a.md"}'
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

    deleteLegacyArtifacts();
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

  it("merges canonical and unmatched legacy rows beyond the 500-row scan boundary", () => {
    const canonical = ingestArtifact(db, {
      content: "canonical pagination\n",
      custody_mode: "copy",
    }, 10_000, tempDir);
    const insert = db.prepare(
      `INSERT INTO artifacts (
        id, algorithm, content_hash, uri, media_type, size_bytes, metadata_json,
        pinned, created_at, custody_mode, repo_locator_json, availability,
        retention_json, reference_json
      ) VALUES (?, 'sha256', ?, ?, 'text/plain', 0, '{}', 0, ?, 'external', '{}',
        'remote_only', '{}', '{}')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 505; i += 1) {
        const hash = i.toString(16).padStart(64, "0");
        insert.run(`legacy-pagination-${i}`, hash, `external://legacy/${i}`, i);
      }
    })();

    expect(listArtifacts(db, { limit: 2 }).map((artifact) => artifact.id)).toEqual([
      canonical.id,
      "legacy-pagination-504",
    ]);
    expect(listArtifacts(db, { offset: 500, limit: 3 }).map((artifact) => artifact.id)).toEqual([
      "legacy-pagination-5",
      "legacy-pagination-4",
      "legacy-pagination-3",
    ]);
  });

  it("uses legacy-only draft and session attachment SQL against pre-v104 association tables", () => {
    const recorded = recordManaged("pre-v104", "# Pre v104\n", 3600);
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE session_instruction_artifacts;
      DROP TABLE artifact_drafts;
      CREATE TABLE session_instruction_artifacts (
        session_id TEXT NOT NULL,
        artifact_series_id TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
        artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
        legacy_preset_id TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, artifact_series_id)
      );
      CREATE TABLE artifact_drafts (
        id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL REFERENCES artifact_series(id) ON DELETE CASCADE,
        base_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
        content TEXT NOT NULL,
        media_type TEXT,
        label TEXT,
        note TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(series_id)
      );
    `);
    db.pragma("foreign_keys = ON");

    replaceSessionInstructionArtifacts(db, "session-pre-v104", [recorded.version.id]);
    expect(listSessionInstructionArtifacts(db, "session-pre-v104")).toEqual([
      expect.objectContaining({
        artifact_series_id: recorded.series.id,
        artifact_version_id: recorded.version.id,
      }),
    ]);
    expect(saveArtifactDraft(db, {
      ref: recorded.series.id,
      content: "# Legacy draft\n",
    }, 3601)).toMatchObject({
      series_id: recorded.series.id,
      base_version_id: recorded.version.id,
    });
  });
});
