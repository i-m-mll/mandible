import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openArtifactExternally } from "../../src/artifact-open.js";
import { openDb, type Db } from "../../src/db.js";
import { recordArtifactVersion } from "../../src/provider-artifacts.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-open-"));
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(tempDir, "managed");
  db = openDb(path.join(tempDir, "mandible.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.MANDIBLE_ARTIFACT_DIR;
});

/** Seed one linked canonical blob and return its compatibility artifact id. */
function insertLinkedArtifact(targetPath: string): string {
  const bytes = fs.statSync(targetPath).isFile() ? fs.readFileSync(targetPath) : Buffer.from("directory");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  db.prepare(
    `INSERT INTO artifact_blob (
       id, content_hash, storage_uri, size_bytes, custody_mode, availability, created_at
     ) VALUES (?, ?, ?, ?, 'link', 'present', 1)`,
  ).run(`artifact-blob:${hash}`, hash, `file://${targetPath}`, bytes.length);
  return `artifact:sha256:${hash}`;
}

describe("artifact external open", () => {
  it("opens managed artifact custody through the injected default-app seam", async () => {
    const recorded = recordArtifactVersion(db, {
      source_kind: "managed",
      series_key: "managed:test-report",
      logical_name: "report.txt",
      content: "managed material\n",
      media_type: "text/plain",
    });
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, recorded.artifact.id, opener)).resolves.toEqual({
      ok: true,
      artifact_id: recorded.artifact.id,
    });
    expect(opener).toHaveBeenCalledOnce();
    expect(fs.readFileSync(opener.mock.calls[0][0], "utf8")).toBe("managed material\n");
  });

  it("opens a registered linked file and never accepts a caller path", async () => {
    const linkedPath = path.join(tempDir, "linked.txt");
    fs.writeFileSync(linkedPath, "linked material\n");
    const linkedId = insertLinkedArtifact(linkedPath);
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, linkedId, opener)).resolves.toEqual({
      ok: true,
      artifact_id: linkedId,
    });
    expect(opener).toHaveBeenCalledWith(fs.realpathSync(linkedPath));
  });

  it("opens tracked repo material only through its registered checkout locator", async () => {
    const repoRoot = path.join(tempDir, "checkout");
    const trackedPath = path.join(repoRoot, "results", "report.md");
    fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
    fs.writeFileSync(trackedPath, "tracked material\n");
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, created_at, updated_at)
       VALUES ('prj_repo', 'repo', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO ledger_project_checkouts (id, project_id, work_repo_id, root, name, created_at, updated_at)
       VALUES ('checkout_repo', 'prj_repo', 'repo', ?, 'repo', 1, 1)`,
    ).run(repoRoot);
    const hash = crypto.createHash("sha256").update("tracked material\n").digest("hex");
    db.prepare(
      `INSERT INTO artifact_blob (
         id, content_hash, storage_uri, size_bytes, custody_mode,
         metadata_json, availability, created_at
       ) VALUES (?, ?, 'repo://repo/results/report.md', 17, 'link', ?, 'present', 1)`,
    ).run(`artifact-blob:${hash}`, hash, JSON.stringify({
      home_repo_id: "repo",
      repo_locator: { repo_id: "repo", path: "results/report.md" },
    }));
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, `artifact:sha256:${hash}`, opener))
      .resolves.toMatchObject({ ok: true });
    expect(opener).toHaveBeenCalledWith(fs.realpathSync(trackedPath));
  });

  it("rejects unavailable and non-file material without invoking the OS", async () => {
    const missingPath = path.join(tempDir, "missing.txt");
    const missingHash = "0".repeat(64);
    db.prepare(
      `INSERT INTO artifact_blob (id, content_hash, storage_uri, custody_mode, availability, created_at)
       VALUES (?, ?, ?, 'link', 'missing', 1)`,
    ).run(`artifact-blob:${missingHash}`, missingHash, `file://${missingPath}`);
    const directoryPath = path.join(tempDir, "directory");
    fs.mkdirSync(directoryPath);
    const directoryId = insertLinkedArtifact(directoryPath);
    const opener = vi.fn(async () => undefined);

    await expect(openArtifactExternally(db, `artifact:sha256:${missingHash}`, opener))
      .resolves.toMatchObject({ ok: false, status: 409 });
    await expect(openArtifactExternally(db, directoryId, opener)).resolves.toMatchObject({
      ok: false,
      status: 409,
      reason: "artifact locator does not point to a regular file",
    });
    expect(opener).not.toHaveBeenCalled();
  });
});
