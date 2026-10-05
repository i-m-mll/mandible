import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { Db } from "../src/db.js";
import type { ArtifactMaterializationTarget } from "../src/contracts.js";
import { readArtifactMaterial } from "../src/artifact-materialization.js";

it("reads managed custody without source discovery and distinguishes storage failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-material-"));
  try {
    const filename = path.join(root, "bytes");
    const bytes = Buffer.from("saved\n");
    fs.writeFileSync(filename, bytes);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const target: ArtifactMaterializationTarget = {
      id: "artifact-version:fixture", version_id: "artifact-version:fixture", metadata: {},
      custody: { kind: "managed", storage_uri: pathToFileURL(filename).href, hash },
      blob: { id: `artifact-blob:${hash}`, algorithm: "sha256", content_hash: hash, storage_uri: pathToFileURL(filename).href,
        media_type: "text/plain", role: null, size_bytes: bytes.length, provider_id: null, manifest_id: null, metadata: {}, created_at: 1 },
    };
    const db = { prepare: () => { throw new Error("Managed material must not discover current source"); } } as unknown as Db;
    expect(readArtifactMaterial(db, target, 1024)).toMatchObject({ ok: true, value: { bytes } });
    expect(readArtifactMaterial(db, target, 1)).toMatchObject({ ok: false, error: { code: "size_limit" } });
    fs.writeFileSync(filename, "corrupt\n");
    expect(readArtifactMaterial(db, target, 1024)).toMatchObject({ ok: false, error: { code: "hash_mismatch" } });
    fs.rmSync(filename);
    expect(readArtifactMaterial(db, target, 1024)).toMatchObject({ ok: false, error: { code: "unavailable_material" } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
