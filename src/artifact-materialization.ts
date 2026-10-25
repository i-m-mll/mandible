import crypto from "node:crypto";
import fs from "node:fs";
import {
  fileURLToPath
} from "node:url";
import type { Db } from "./db.js";
import type { ArtifactMaterializationResult, ArtifactMaterializationTarget } from "./contracts.js";
import {
  readCommittedArtifactFiles, readCommittedArtifactFilesAsync
} from "./artifact-commit-source.js";

export function readArtifactMaterial(db: Db, target: ArtifactMaterializationTarget, maxBytes: number):
  ArtifactMaterializationResult<{ bytes: Buffer; source: string }> {
  try {
    const custody = target.custody;
    let bytes: Buffer;
    let source: string;
    switch (custody.kind) {
      case "git":
        bytes = readCommittedArtifactFiles(db, { project: custody.project_id, commit: custody.commit, paths: [custody.path] })[0].bytes;
        source = `repo://${custody.project_id}@${custody.commit}/${custody.path}`;
        break;
      case "managed": {
        const filename = fileURLToPath(custody.storage_uri);
        const stat = fs.statSync(filename);
        if (!stat.isFile()) return { ok: false, error: { code: "unavailable_material", message: "stored artifact is not a regular file" } };
        if (stat.size > maxBytes) return { ok: false, error: { code: "size_limit", message: "Artifact exceeds size limit" } };
        bytes = fs.readFileSync(filename);
        source = custody.storage_uri;
        break;
      }
    }
    return verifyMaterial(target, bytes, source, maxBytes);
  } catch (error) {
    return { ok: false, error: { code: "unavailable_material", message: error instanceof Error ? error.message : String(error) } };
  }
}

function verifyMaterial(target: ArtifactMaterializationTarget, bytes: Buffer, source: string, maxBytes: number):
  ArtifactMaterializationResult<{ bytes: Buffer; source: string }> {
  const custody = target.custody;
  if (bytes.length > maxBytes) return { ok: false, error: { code: "size_limit", message: "Artifact exceeds size limit" } };
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== custody.hash) return {
    ok: false, error: { code: "hash_mismatch", message: "Artifact bytes do not match registered sha256" },
  };
  return { ok: true, value: { bytes, source } };
}

export async function readArtifactMaterialAsync(db: Db, target: ArtifactMaterializationTarget, maxBytes: number):
  Promise<ArtifactMaterializationResult<{ bytes: Buffer; source: string }>> {
  try {
    const custody = target.custody;
    if (custody.kind === 'git') {
      const [file] = await readCommittedArtifactFilesAsync(db, { project: custody.project_id, commit: custody.commit, paths: [custody.path] });
      return verifyMaterial(target, file.bytes, `repo://${custody.project_id}@${custody.commit}/${custody.path}`, maxBytes);
    }
    const filename = fileURLToPath(custody.storage_uri);
    const stat = await fs.promises.stat(filename);
    if (!stat.isFile()) return { ok: false, error: { code: 'unavailable_material', message: 'stored artifact is not a regular file' } };
    if (stat.size > maxBytes) return { ok: false, error: { code: 'size_limit', message: 'Artifact exceeds size limit' } };
    return verifyMaterial(target, await fs.promises.readFile(filename), custody.storage_uri, maxBytes);
  } catch (error) {
    return { ok: false, error: { code: 'unavailable_material', message: error instanceof Error ? error.message : String(error) } };
  }
}
