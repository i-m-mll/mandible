import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyArtifactRef } from "../src/artifact-identity.js";
import { openDb, type Db } from "../src/db.js";
import {
  canonicalArtifactBlobShortRef,
  canonicalLogicalArtifactShortRef,
  canonicalArtifactShortRef,
  projectArtifactPublicValue,
  resolveArtifactIdentity,
} from "../src/provider-artifacts.js";
import { recordArtifactVersion, resolveArtifactRefReadonlyFull } from "./helpers/artifact-http-write-fixtures.js";

let db: Db;
let tempDir = "";

// Synthetic descriptor hashes isolate prefix ambiguity; no version or byte custody is claimed.
function seedDescriptor(hash:string) {
  db.prepare('INSERT INTO artifact_blob(id,content_hash,created_at) VALUES (?,?,1)').run(`artifact-blob:${hash}`,hash);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-identity-"));
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("artifact identity contract", () => {
  it("classifies the compact artifact id as immutable before logical prefixes", () => {
    expect(classifyArtifactRef("artifact:53f3c8c30295")).toEqual({
      kind: "blob",
      ref: "artifact:53f3c8c30295",
      compact: true,
    });
    expect(classifyArtifactRef("artifact:report")).toEqual({
      kind: "logical",
      ref: "artifact:report",
    });
  });

  it("resolves an unambiguous compact immutable id with a canonical blob target", () => {
    const hash = `53f3c8c30295${"0".repeat(52)}`;
    seedDescriptor(hash);

    const strict = resolveArtifactIdentity(db, "artifact:53f3c8c30295", "strict-read");
    expect(strict).toMatchObject({
      status: "resolved",
      kind: "blob",
      target_type: "artifact_blob",
      target_id: `artifact-blob:${hash}`,
      normalized_ref: `artifact-blob:${hash}`,
      artifact_blob: { content_hash: hash },
    });
    expect(resolveArtifactRefReadonlyFull(db, "artifact:53f3c8c30295")).toMatchObject({
      status: "resolved",
      target_type: "artifact_blob",
      target_id: `artifact-blob:${hash}`,
    });
  });

  it("fails closed for ambiguous compact ids", () => {
    const first = `abcdef0${"0".repeat(57)}`;
    const second = `abcdef0${"1".repeat(57)}`;
    seedDescriptor(first);
    seedDescriptor(second);

    expect(resolveArtifactIdentity(db, "artifact:abcdef0", "strict-read")).toMatchObject({
      status: "ambiguous",
      kind: "ambiguous",
      requested_kind: "blob",
      target_type: "artifact_blob",
      target_id: null,
    });
  });

  it("projects current API values to the shortest unambiguous compact id", () => {
    const first = `1234567890ab0${"0".repeat(51)}`;
    const second = `1234567890ab1${"1".repeat(51)}`;
    seedDescriptor(first);
    seedDescriptor(second);

    expect(canonicalArtifactShortRef(db, first)).toBe("artifact:1234567890ab0");
    expect(projectArtifactPublicValue(db, {
      artifact: { id: `artifact:sha256:${first}` },
      nested: [`artifact:sha256:${second}`],
    })).toEqual({
      artifact: { id: "artifact:1234567890ab0" },
      nested: ["artifact:1234567890ab1"],
    });
  });

  it("projects typed blob and logical identities to collision-safe short refs", () => {
    const hash = `89abcdef0123${"4".repeat(52)}`;
    seedDescriptor(hash);
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed",
      provider_id: "test",
      content: "logical\n",
      logical_name: "logical",
    }, 1001, tempDir);

    expect(canonicalArtifactBlobShortRef(db, `artifact-blob:${hash}`)).toBe(
      "artifact-blob:89abcdef0123",
    );
    expect(canonicalLogicalArtifactShortRef(db, recorded.series.id.replace(/^artifact-series:/, "artifact:")))
      .toMatch(/^artifact:[a-f0-9]{12,}$/);

    const projected = projectArtifactPublicValue(db, {
      blob: { id: `artifact-blob:${hash}`, content_hash: hash },
      compatibilityBlob: {
        id: `artifact:sha256:${hash}`,
        content_hash: hash,
        custody_mode: "managed",
      },
      logical: {
        id: recorded.series.id.replace(/^artifact-series:/, "artifact:"),
        identity_key: recorded.series.series_key,
      },
    }) as { blob: { ref: string }; compatibilityBlob: { ref: string }; logical: { ref: string } };
    expect(projected.blob.ref).toBe("artifact-blob:89abcdef0123");
    expect(projected.compatibilityBlob.ref).toBe("artifact-blob:89abcdef0123");
    expect(projected.logical.ref).toMatch(/^artifact:[a-f0-9]{12,}$/);
  });

  it("keeps strict reads non-materializing and isolates obsolete read compatibility", () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM artifact_aliases").get() as { n: number };
    const strict = resolveArtifactIdentity(db, "https://example.invalid/new.txt", "strict-read");
    const after = db.prepare("SELECT COUNT(*) AS n FROM artifact_aliases").get() as { n: number };
    expect(strict).toMatchObject({ status: "unresolved", kind: "unresolved", target_id: null });
    expect(after.n).toBe(before.n);

    expect(resolveArtifactIdentity(db, "https://example.invalid/new.txt", "link", 900)).toMatchObject({status:"unresolved",target_id:null});
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifact_aliases").get()).toEqual(before);

    const hash = `1234567${"a".repeat(57)}`;
    seedDescriptor(hash);
    expect(resolveArtifactIdentity(db, `artifact:sha256:${hash}`, "strict-read")).toMatchObject({
      status: "unsupported",
      kind: "unsupported",
      requested_kind: "blob",
      target_id: null,
      warnings: ["legacy_artifact_ref_unsupported", "repair_to_artifact_blob_ref"],
    });
  });

  it("keeps logical, pinned-version, and blob identities distinct", () => {
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "identity-contract",
      logical_name: "identity.md",
      content: "identity\n",
    }, 1000, tempDir);
    const logicalRef = recorded.series.id.replace(/^artifact-series:/, "artifact:");
    const blobRef = `artifact-blob:${recorded.artifact.content_hash}`;

    expect(resolveArtifactIdentity(db, logicalRef)).toMatchObject({
      status: "resolved",
      kind: "logical",
      target_type: "artifact",
      target_id: logicalRef,
    });
    expect(resolveArtifactIdentity(db, recorded.version.id)).toMatchObject({
      status: "resolved",
      kind: "pinned-version",
      target_type: "artifact_version",
      target_id: recorded.version.id,
    });
    expect(resolveArtifactIdentity(db, blobRef)).toMatchObject({
      status: "resolved",
      kind: "blob",
      target_type: "artifact_blob",
      target_id: blobRef,
    });
  });
});
