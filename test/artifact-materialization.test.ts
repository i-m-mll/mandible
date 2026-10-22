import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import type { ArtifactMaterializationTarget } from "../src/contracts.js";
import { artifactMaterializationTarget } from "../src/artifact-identity.js";
import { readArtifactMaterial } from "../src/artifact-materialization.js";
import { recordArtifactVersion, resolveArtifactIdentity, registerArtifactAlias, projectArtifactResolution } from "../src/provider-artifacts.js";
import { planArtifactSourceMove, commitArtifactSourceMove } from "../src/artifact-source.js";
import { insertRawLedgerProject, insertRawLedgerCheckout, migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: Db;
let root: string;
let priorArtifactDir: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-target-"));
  priorArtifactDir = process.env.MANDIBLE_ARTIFACT_DIR;
  process.env.MANDIBLE_ARTIFACT_DIR = path.join(root, "cas");
  db = migratedMemoryDb();
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (priorArtifactDir === undefined) delete process.env.MANDIBLE_ARTIFACT_DIR;
  else process.env.MANDIBLE_ARTIFACT_DIR = priorArtifactDir;
});
function material(ref: string) {
  const result = artifactMaterializationTarget(resolveArtifactIdentity(db, ref, "surface"));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

it("pins living and aliased references once, while the HTTP projection preserves historical fields", () => {
  const first = recordArtifactVersion(db, { source_kind: "managed", content: "first\n", series_key: "report" });
  const logical = first.logical_artifact.id;
  const series = logical.replace(/^artifact:/, "artifact-series:");
  const pinned = material(series);
  registerArtifactAlias(db, {
    artifactId: first.artifact_blob.id, ref: "https://example.invalid/report.md", source: "test", resolutionStatus: "resolved",
  });
  const alias = resolveArtifactIdentity(db, "https://example.invalid/report.md", "surface");
  expect(alias).toMatchObject({ status: "resolved", kind: "blob", target_id: first.artifact_blob.id, alias: { scheme: "https" } });
  const second = recordArtifactVersion(db, { source_kind: "managed", content: "second\n", artifact_id: logical });
  expect(material(series).version_id).toBe(second.artifact_version.id);
  expect(material(`${series}@1`).version_id).toBe(first.artifact_version.id);
  expect(readArtifactMaterial(db, pinned, 1024)).toMatchObject({ ok: true, value: { bytes: Buffer.from("first\n") } });
  expect(material(first.artifact_version.id).version_id).toBe(first.artifact_version.id);
  expect(material(first.artifact_blob.id)).toMatchObject({ version_id: null, custody: { kind: "managed" } });
  for (const ref of [logical, first.artifact_version.id, series, `${series}@1`, first.artifact_blob.id, `artifact:sha256:${first.artifact_blob.content_hash}`]) {
    const canonical = resolveArtifactIdentity(db, ref, "surface");
    expect(canonical).not.toHaveProperty("series");
    expect(canonical).not.toHaveProperty("version");
    expect(canonical).not.toHaveProperty("artifact");
    const external = projectArtifactResolution(db, canonical);
    expect(external.artifact?.content_hash).toBe(canonical.artifact_blob?.content_hash);
    expect(external.version?.id ?? null).toBe(canonical.artifact_version?.id ?? null);
    expect(external.series?.id ?? null).toBe(canonical.logical_artifact?.id.replace(/^artifact:/, "artifact-series:") ?? null);
  }
});

it("distinguishes unknown and ambiguous references before materialization", () => {
  expect(artifactMaterializationTarget(resolveArtifactIdentity(db, "artifact-version:missing"))).toMatchObject({ ok: false, error: { code: "unknown_reference" } });
  for (const suffix of ["a", "b"]) {
    const hash = `1234567${suffix.repeat(57)}`;
    db.prepare("INSERT INTO artifact_blob(id,content_hash,created_at) VALUES (?,?,1)").run(`artifact-blob:${hash}`, hash);
  }
  expect(artifactMaterializationTarget(resolveArtifactIdentity(db, "artifact:1234567"))).toMatchObject({ ok: false, error: { code: "ambiguous_source" } });
});

it("keeps a Git version's verified locator after current source registration moves", () => {
  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
      env: { ...process.env, GIT_CONFIG_COUNT: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  const checkout = path.join(root, "repo"); fs.mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.name", "Fixture"); git(checkout, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(checkout, "report.md"), "committed\n");
  git(checkout, "add", "."); git(checkout, "-c", "commit.gpgsign=false", "commit", "-m", "Fixture");
  const project = insertRawLedgerProject(db, { name: "target-fixture", projectKey: "target-fixture" });
  insertRawLedgerCheckout(db, { projectId: project, name: "target-fixture", root: checkout });
  const version = recordArtifactVersion(db, { source_kind: "tracked_repo", path: path.join(checkout, "report.md") });
  const target = material(version.artifact_version.id);
  expect(target.custody).toEqual({ kind: "git", project_id: project, commit: git(checkout, "rev-parse", "HEAD"), path: "report.md",
    hash: crypto.createHash("sha256").update("committed\n").digest("hex") });
  const move = planArtifactSourceMove(db, { artifact_id: version.logical_artifact.id, expected_revision: 1,
    source: { kind: "managed", key: "new-source" }, actor: "test-agent" });
  if (!move.ok) throw new Error(move.error.message);
  expect(commitArtifactSourceMove(db, move.value).ok).toBe(true);
  fs.writeFileSync(path.join(checkout, "report.md"), "uncommitted\n");
  expect(material(version.artifact_version.id).custody).toEqual(target.custody);
  expect(readArtifactMaterial(db, target, 1024)).toMatchObject({ ok: true, value: { bytes: Buffer.from("committed\n") } });
});

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
    const noSourceDb = { prepare: () => { throw new Error("Managed material must not discover current source"); } } as unknown as Db;
    expect(readArtifactMaterial(noSourceDb, target, 1024)).toMatchObject({ ok: true, value: { bytes } });
    expect(readArtifactMaterial(noSourceDb, target, 1)).toMatchObject({ ok: false, error: { code: "size_limit" } });
    fs.writeFileSync(filename, "corrupt\n");
    expect(readArtifactMaterial(noSourceDb, target, 1024)).toMatchObject({ ok: false, error: { code: "hash_mismatch" } });
    fs.rmSync(filename);
    expect(readArtifactMaterial(noSourceDb, target, 1024)).toMatchObject({ ok: false, error: { code: "unavailable_material" } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
