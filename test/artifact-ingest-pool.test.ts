import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import {
  materializeArtifactFileIntoCas,
  readAndHashArtifactFile,
  shutdownArtifactIngestPool,
} from "../src/artifact-ingest-pool.js";
import {
  getArtifactRoot,
  ingestArtifactAsync,
} from "../src/provider-artifacts.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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
  db = migratedMemoryDb();
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
});

describe("off-thread artifact ingest routes", () => {

  it("ingestArtifactAsync rejects a content_path whose sha256 does not match", async () => {
    const bytes = Buffer.from("real bytes\n");
    const src = path.join(tempDir, "mismatch.txt");
    fs.writeFileSync(src, bytes);

    await expect(ingestArtifactAsync(db, {
      content_path: src,
      sha256: sha256("different bytes"),
    }, 5000)).rejects.toThrow(/sha256 does not match/);
  });
});
