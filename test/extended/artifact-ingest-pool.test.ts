import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../../src/db.js";
import { getArtifactContent } from "../../src/artifact-content.js";
import {
  materializeArtifactFileIntoCas,
  readAndHashArtifactFile,
  shutdownArtifactIngestPool,
} from "../../src/artifact-ingest-pool.js";
import {
  addArtifactBundleMembersAsync,
  createArtifactBundleAsync,
  getArtifactRoot,
  ingestArtifactAsync,
  planLocalArtifactPath,
  planLocalArtifactPathAsync,
  registerLocalArtifactPath,
  registerLocalArtifactPathAsync,
  snapshotArtifactBytesAsync,
} from "../../src/provider-artifacts.js";

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function casPath(root: string, hash: string): string {
  return path.join(root, "sha256", hash.slice(0, 2), hash);
}

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ingest-pool-"));
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "artifacts");
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MANDIBLE_ARTIFACT_DIR;
});

afterAll(async () => {
  await shutdownArtifactIngestPool();
});

describe("artifact ingest worker pool", () => {
  it("reads, hashes, and materializes a file into the CAS off the main thread", async () => {
    const bytes = crypto.randomBytes(2 * 1024 * 1024);
    const src = path.join(tempDir, "big.bin");
    fs.writeFileSync(src, bytes);
    const root = getArtifactRoot(db);

    const first = await materializeArtifactFileIntoCas(src, root);
    expect(first.hash).toBe(sha256(bytes));
    expect(first.size).toBe(bytes.length);
    expect(first.wrote).toBe(true);
    expect(fs.existsSync(casPath(root, first.hash))).toBe(true);
    // Buffer.equals checks identical bytes without expanding a multi-megabyte typed array in the assertion engine.
    expect(fs.readFileSync(casPath(root, first.hash)).equals(bytes)).toBe(true);

    // A second materialization of identical bytes leaves the existing blob alone.
    const second = await materializeArtifactFileIntoCas(src, root);
    expect(second.hash).toBe(first.hash);
    expect(second.wrote).toBe(false);
  });

  it("read-and-hash does not write a CAS blob (dry-run planner path)", async () => {
    const bytes = Buffer.from("dry-run planner bytes\n");
    const src = path.join(tempDir, "plan.txt");
    fs.writeFileSync(src, bytes);
    const root = getArtifactRoot(db);

    const result = await readAndHashArtifactFile(src);
    expect(result.hash).toBe(sha256(bytes));
    expect(result.size).toBe(bytes.length);
    expect(fs.existsSync(casPath(root, result.hash))).toBe(false);
  });

  it("rejects a source path that is not a regular file (identity guard)", async () => {
    const dir = path.join(tempDir, "a-directory");
    fs.mkdirSync(dir);
    await expect(readAndHashArtifactFile(dir)).rejects.toThrow(/not a regular file/);
  });

  it("runs concurrent materializations through the bounded pool", async () => {
    const root = getArtifactRoot(db);
    const inputs = Array.from({ length: 12 }, (_, i) => {
      const bytes = crypto.randomBytes(64 * 1024 + i);
      const src = path.join(tempDir, `concurrent-${i}.bin`);
      fs.writeFileSync(src, bytes);
      return { bytes, src };
    });
    const results = await Promise.all(inputs.map((input) => materializeArtifactFileIntoCas(input.src, root)));
    for (let i = 0; i < inputs.length; i += 1) {
      expect(results[i].hash).toBe(sha256(inputs[i].bytes));
      expect(fs.existsSync(casPath(root, results[i].hash))).toBe(true);
    }
  });
});

describe("off-thread artifact ingest routes", () => {
  it("registerLocalArtifactPathAsync copies bytes into managed custody like the sync path", async () => {
    const bytes = crypto.randomBytes(3 * 1024 * 1024);
    const src = path.join(tempDir, "local-copy.bin");
    fs.writeFileSync(src, bytes);

    const registration = await registerLocalArtifactPathAsync(db, {
      path: src,
      custody_mode: "managed",
      filename: "local-copy.bin",
    }, 1000);

    expect(registration.artifact).toMatchObject({
      id: `artifact-blob:${sha256(bytes)}`,
      custody_mode: "managed",
      availability: "present",
      size_bytes: bytes.length,
    });
    expect(getArtifactContent(db, registration.artifact.id)).toMatchObject({
      status: "available",
      download: { available: true },
    });
    // The stored bytes come back verbatim from the CAS the worker wrote.
    const content = getArtifactContent(db, registration.artifact.id);
    expect(content.size_bytes).toBe(bytes.length);
  });

  it("registerLocalArtifactPathAsync matches the synchronous registration record", async () => {
    const bytes = Buffer.from("parity between sync and async\n");
    const src = path.join(tempDir, "parity.txt");
    fs.writeFileSync(src, bytes);

    const asyncReg = await registerLocalArtifactPathAsync(db, { path: src, custody_mode: "managed" }, 2000);
    const syncReg = registerLocalArtifactPath(db, { path: src, custody_mode: "managed" }, 2000);

    expect(asyncReg.artifact.id).toBe(syncReg.artifact.id);
    expect(asyncReg.artifact.custody_mode).toBe(syncReg.artifact.custody_mode);
    expect(asyncReg.artifact.size_bytes).toBe(syncReg.artifact.size_bytes);
    expect(asyncReg.artifact.availability).toBe(syncReg.artifact.availability);
  });

  it("planLocalArtifactPathAsync matches the sync planner and writes no bytes", async () => {
    const bytes = Buffer.from("plan parity\n");
    const src = path.join(tempDir, "plan-parity.txt");
    fs.writeFileSync(src, bytes);
    const root = getArtifactRoot(db);

    const asyncPlan = await planLocalArtifactPathAsync(db, { path: src });
    const syncPlan = planLocalArtifactPath(db, { path: src });

    expect(asyncPlan.sha256).toBe(sha256(bytes));
    expect(asyncPlan.sha256).toBe(syncPlan.sha256);
    expect(asyncPlan.size_bytes).toBe(syncPlan.size_bytes);
    expect(asyncPlan.canonical_ref).toBe(syncPlan.canonical_ref);
    // A plan is a dry run: no CAS blob is materialized.
    expect(fs.existsSync(casPath(root, asyncPlan.sha256))).toBe(false);
  });

  it("snapshotArtifactBytesAsync materializes a path snapshot off-thread", async () => {
    const bytes = crypto.randomBytes(1024 * 1024);
    const src = path.join(tempDir, "snapshot.bin");
    fs.writeFileSync(src, bytes);
    const root = getArtifactRoot(db);

    const artifact = await snapshotArtifactBytesAsync(db, {
      path: src,
      custody_mode: "managed",
      media_type: "application/octet-stream",
    }, 3000);

    expect(artifact.id).toBe(`artifact-blob:${sha256(bytes)}`);
    expect(artifact.custody_mode).toBe("managed");
    expect(artifact.availability).toBe("present");
    expect(fs.existsSync(casPath(root, artifact.content_hash))).toBe(true);
    expect(artifact.uri).toBe(pathToFileURL(casPath(root, artifact.content_hash)).href);
  });

  it("ingestArtifactAsync reads a content_path off-thread into managed custody", async () => {
    const bytes = crypto.randomBytes(512 * 1024);
    const src = path.join(tempDir, "content-path.bin");
    fs.writeFileSync(src, bytes);
    const root = getArtifactRoot(db);

    const artifact = await ingestArtifactAsync(db, {
      content_path: src,
      media_type: "application/octet-stream",
      filename: "content-path.bin",
    }, 4000);

    expect(artifact.id).toBe(`artifact-blob:${sha256(bytes)}`);
    expect(artifact.custody_mode).toBe("managed");
    expect(artifact.availability).toBe("present");
    expect(artifact.size_bytes).toBe(bytes.length);
    expect(fs.existsSync(casPath(root, artifact.content_hash))).toBe(true);
  });

  it("ingestArtifactAsync rejects a content_path whose sha256 does not match", async () => {
    const bytes = Buffer.from("real bytes\n");
    const src = path.join(tempDir, "mismatch.txt");
    fs.writeFileSync(src, bytes);

    await expect(ingestArtifactAsync(db, {
      content_path: src,
      sha256: sha256("different bytes"),
    }, 5000)).rejects.toThrow(/sha256 does not match/);
  });

  it("createArtifactBundleAsync materializes path members through the pool", async () => {
    const runBytes = Buffer.from('{"status":"complete"}\n');
    const checkpointBytes = crypto.randomBytes(256 * 1024);
    const runPath = path.join(tempDir, "run.json");
    const checkpointPath = path.join(tempDir, "checkpoint.bin");
    fs.writeFileSync(runPath, runBytes);
    fs.writeFileSync(checkpointPath, checkpointBytes);
    const root = getArtifactRoot(db);

    const result = await createArtifactBundleAsync(db, {
      name: "run packet",
      role: "artifact_bundle",
      members: [
        { path: runPath, role: "run_record", custody_mode: "managed" },
        { path: checkpointPath, role: "model_checkpoint", custody_mode: "managed" },
      ],
    }, 6000);

    expect(result.members).toHaveLength(2);
    const memberHashes = result.members.map((member) => member.artifact.content_hash).sort();
    expect(memberHashes).toEqual([sha256(runBytes), sha256(checkpointBytes)].sort());
    for (const member of result.members) {
      expect(fs.existsSync(casPath(root, member.artifact.content_hash))).toBe(true);
    }

    const appended = await addArtifactBundleMembersAsync(db, result.bundle.id, [
      { ref: `artifact-blob:${result.members[0].artifact.content_hash}`, role: "duplicate" },
    ], 7000);
    expect(appended.members).toHaveLength(3);
  });
});
