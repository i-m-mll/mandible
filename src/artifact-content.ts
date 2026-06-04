import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { getArtifact } from "./provider-artifacts.js";
import type { ArtifactMaterializationCheck, ArtifactRecord, ArtifactRecoverability } from "./types.js";

const DEFAULT_PREVIEW_BYTES = 128 * 1024;

export type ArtifactContentKind = "text" | "markdown" | "json" | "binary" | "unavailable";
export type ArtifactContentSourceKind = "managed_file" | "repo_locator";

export interface ArtifactContentPreview {
  encoding: "utf-8";
  text: string;
  truncated: boolean;
}

export interface ArtifactDownloadMetadata {
  available: boolean;
  media_type: string;
  size_bytes: number;
  filename: string | null;
  reason?: string;
}

export interface ArtifactContentResult {
  artifact_id: string;
  status: "available" | "unavailable";
  kind: ArtifactContentKind;
  media_type: string;
  size_bytes: number;
  source: {
    kind: ArtifactContentSourceKind;
    locator: string;
  } | null;
  preview: ArtifactContentPreview | null;
  download: ArtifactDownloadMetadata;
  reason?: string;
}

export function checkArtifactMaterialization(
  db: Db,
  id: string,
  options: { ref?: string } = {},
): ArtifactMaterializationCheck | null {
  const artifact = getArtifact(db, id);
  if (!artifact) return null;

  const recoverability = recoverabilityForArtifact(artifact);
  const expected = artifact.algorithm === "sha256" && /^[a-f0-9]{64}$/i.test(artifact.content_hash)
    ? artifact.content_hash.toLowerCase()
    : null;
  const warnings: string[] = [];
  const reasons: string[] = [];

  const managedPath = resolveManagedFileArtifact(db, artifact);
  if (managedPath.ok) {
    return checkResolvedFile(artifact, managedPath.path, "managed_file", expected, recoverability, options.ref);
  }
  if (artifact.custody_mode === "copy" || artifact.custody_mode === "managed") {
    reasons.push(reasonCode(managedPath.reason));
  }

  const repoBytes = readRepoArtifactBytes(db, artifact);
  if (repoBytes.ok) {
    const actual = crypto.createHash("sha256").update(repoBytes.bytes).digest("hex");
    return {
      artifact_id: artifact.id,
      ref: options.ref,
      materializable: true,
      hash_matches: expected ? actual === expected : null,
      expected_sha256: expected,
      actual_sha256: actual,
      source: repoBytes.source,
      recoverability,
      reasons: expected && actual !== expected ? ["hash_mismatch"] : [],
      warnings: repoBytes.warning ? [repoBytes.warning] : [],
    };
  }
  if (artifact.home_repo_id || Object.keys(artifact.repo_locator).length > 0) {
    reasons.push(repoBytes.reason);
  }

  if (artifact.availability === "remote_only") reasons.push("remote_only");
  if (artifact.availability === "missing") reasons.push("missing");
  if (recoverability === "local_only") warnings.push("local_only");
  if (recoverability === "provider_store") warnings.push("provider_store_not_materialized_locally");
  if (recoverability === "external_remote") warnings.push("external_remote_not_materialized_locally");
  if (reasons.length === 0) reasons.push("no_materializable_location");

  return {
    artifact_id: artifact.id,
    ref: options.ref,
    materializable: false,
    hash_matches: expected ? null : true,
    expected_sha256: expected,
    actual_sha256: null,
    source: null,
    recoverability,
    reasons: Array.from(new Set(reasons)),
    warnings: Array.from(new Set(warnings)),
  };
}

export function getArtifactContent(
  db: Db,
  id: string,
  options: { previewBytes?: number } = {},
): ArtifactContentResult | null {
  const artifact = getArtifact(db, id);
  if (!artifact) return null;

  const previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const mediaType = artifact.media_type ?? inferMediaType(artifact);
  const filename = artifactFilename(artifact);
  const unresolvedDownload = (reason: string): ArtifactContentResult => ({
    artifact_id: artifact.id,
    status: "unavailable",
    kind: "unavailable",
    media_type: mediaType,
    size_bytes: artifact.size_bytes,
    source: null,
    preview: null,
    download: {
      available: false,
      media_type: mediaType,
      size_bytes: artifact.size_bytes,
      filename,
      reason,
    },
    reason,
  });

  const resolved = resolveRegisteredArtifactPath(db, artifact);
  if (!resolved.ok) {
    return unresolvedDownload(resolved.reason);
  }

  const stat = safeStat(resolved.path);
  if (!stat) {
    return unresolvedDownload("artifact bytes are not available on disk");
  }
  if (!stat.isFile()) {
    return unresolvedDownload("artifact locator does not point to a regular file");
  }

  const hashProblem = validateContentHash(artifact, resolved.path);
  if (hashProblem) {
    return unresolvedDownload(hashProblem);
  }

  const sizeBytes = stat.size;
  const base = {
    artifact_id: artifact.id,
    status: "available" as const,
    media_type: mediaType,
    size_bytes: sizeBytes,
    source: resolved.source,
    download: {
      available: true,
      media_type: mediaType,
      size_bytes: sizeBytes,
      filename,
    },
  };

  const kind = previewKind(mediaType, filename);
  if (kind === "binary") {
    return {
      ...base,
      kind,
      preview: null,
    };
  }

  const preview = readTextPreview(resolved.path, previewBytes);
  if (kind === "json") {
    return {
      ...base,
      kind,
      preview: {
        ...preview,
        text: preview.truncated ? preview.text : prettyJson(preview.text),
      },
    };
  }

  return {
    ...base,
    kind,
    preview,
  };
}

function resolveRegisteredArtifactPath(
  db: Db,
  artifact: ArtifactRecord,
): { ok: true; path: string; source: ArtifactContentResult["source"] } | { ok: false; reason: string } {
  const managedPath = resolveManagedFileArtifact(db, artifact);
  if (managedPath.ok) return managedPath;

  const repoPath = resolveRepoArtifact(db, artifact);
  if (repoPath.ok) return repoPath;

  return { ok: false, reason: artifact.uri.startsWith("file://") ? managedPath.reason : repoPath.reason };
}

function resolveManagedFileArtifact(
  db: Db,
  artifact: ArtifactRecord,
): { ok: true; path: string; source: ArtifactContentResult["source"] } | { ok: false; reason: string } {
  if (!artifact.uri.startsWith("file://")) {
    return { ok: false, reason: "artifact has no registered local file URI" };
  }
  if (artifact.custody_mode !== "managed" && artifact.custody_mode !== "copy") {
    return { ok: false, reason: "local file URI is not managed by Mandible" };
  }
  if (artifact.algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(artifact.content_hash)) {
    return { ok: false, reason: "managed local artifact has no verifiable sha256" };
  }

  let filePath: string;
  try {
    filePath = fileURLToPath(new URL(artifact.uri));
  } catch {
    return { ok: false, reason: "artifact file URI is invalid" };
  }

  const realPath = safeRealpath(filePath);
  if (!realPath) {
    return { ok: false, reason: "artifact bytes are not available on disk" };
  }

  return {
    ok: true,
    path: realPath,
    source: { kind: "managed_file", locator: "artifact-storage" },
  };
}

function resolveRepoArtifact(
  db: Db,
  artifact: ArtifactRecord,
): { ok: true; path: string; source: ArtifactContentResult["source"] } | { ok: false; reason: string } {
  const repoId = stringValue(artifact.repo_locator.repo_id) ?? stringValue(artifact.repo_locator.repo);
  const relativePath = stringValue(artifact.repo_locator.path) ?? stringValue(artifact.repo_locator.relative_path);
  if (!repoId || !relativePath) {
    return { ok: false, reason: "artifact has no registered repo locator" };
  }
  if (path.isAbsolute(relativePath)) {
    return { ok: false, reason: "artifact repo locator path must be relative" };
  }

  const root = checkoutRootForRepo(db, repoId);
  if (!root) {
    return { ok: false, reason: "artifact repo locator has no registered checkout" };
  }

  const realRoot = safeRealpath(root);
  if (!realRoot) {
    return { ok: false, reason: "registered repo checkout is not available on disk" };
  }
  const candidate = path.resolve(realRoot, relativePath);
  if (!isPathInside(candidate, realRoot)) {
    return { ok: false, reason: "artifact repo locator path is outside the registered checkout" };
  }
  if (!fs.existsSync(candidate)) {
    return { ok: false, reason: "artifact bytes are not available on disk" };
  }
  const realPath = safeRealpath(candidate);
  if (!realPath || !isPathInside(realPath, realRoot)) {
    return { ok: false, reason: "artifact repo locator path is outside the registered checkout" };
  }

  return {
    ok: true,
    path: realPath,
    source: { kind: "repo_locator", locator: `repo://${repoId}/${relativePath.replace(/^\/+/, "")}` },
  };
}

function checkResolvedFile(
  artifact: ArtifactRecord,
  filePath: string,
  source: string,
  expected: string | null,
  recoverability: ArtifactRecoverability | null,
  ref?: string,
): ArtifactMaterializationCheck {
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile()) {
    return {
      artifact_id: artifact.id,
      ref,
      materializable: false,
      hash_matches: expected ? null : true,
      expected_sha256: expected,
      actual_sha256: null,
      source,
      recoverability,
      reasons: ["missing_bytes"],
      warnings: [],
    };
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return {
    artifact_id: artifact.id,
    ref,
    materializable: true,
    hash_matches: expected ? actual === expected : null,
    expected_sha256: expected,
    actual_sha256: actual,
    source,
    recoverability,
    reasons: expected && actual !== expected ? ["hash_mismatch"] : [],
    warnings: [],
  };
}

function readRepoArtifactBytes(
  db: Db,
  artifact: ArtifactRecord,
): { ok: true; bytes: Buffer; source: string; warning?: string } | { ok: false; reason: string } {
  const repoId = stringValue(artifact.repo_locator.repo_id) ?? stringValue(artifact.repo_locator.repo);
  const relativePath = stringValue(artifact.repo_locator.path) ?? stringValue(artifact.repo_locator.relative_path);
  if (!repoId || !relativePath || path.isAbsolute(relativePath)) return { ok: false, reason: "no_repo_locator" };
  const root = checkoutRootForRepo(db, repoId);
  if (!root) return { ok: false, reason: "repo_checkout_unavailable" };
  const realRoot = safeRealpath(root);
  if (!realRoot) return { ok: false, reason: "repo_checkout_missing" };

  const ref = stringValue(artifact.repo_locator.commit) ?? stringValue(artifact.repo_locator.ref);
  if (ref && /^[a-f0-9]{40,64}$/i.test(ref)) {
    try {
      const bytes = execFileSync("git", ["-C", realRoot, "show", `${ref}:${relativePath}`], {
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: Math.max(1024 * 1024, artifact.size_bytes + 1024),
      });
      return { ok: true, bytes, source: `repo_commit:${repoId}@${ref}:${relativePath}` };
    } catch {
      return { ok: false, reason: "repo_commit_unavailable" };
    }
  }

  const candidate = path.resolve(realRoot, relativePath);
  const realPath = safeRealpath(candidate);
  if (!realPath || !isPathInside(realPath, realRoot)) return { ok: false, reason: "repo_locator_outside_checkout" };
  try {
    return {
      ok: true,
      bytes: fs.readFileSync(realPath),
      source: `repo_worktree:${repoId}:${relativePath}`,
      warning: ref ? "mutable_repo_ref" : "repo_worktree_fallback",
    };
  } catch {
    return { ok: false, reason: "missing_bytes" };
  }
}

function recoverabilityForArtifact(artifact: ArtifactRecord): ArtifactRecoverability | null {
  const raw = artifact.metadata.recoverability ?? artifact.reference.recoverability ?? artifact.retention.recoverability;
  switch (raw) {
    case "repo_commit":
    case "repo_worktree":
    case "local_only":
    case "mandible_cas":
    case "provider_store":
    case "external_remote":
    case "regenerable":
      return raw;
    default:
      break;
  }
  if (artifact.custody_mode === "copy" || artifact.custody_mode === "managed") return "mandible_cas";
  if (artifact.provider_id && artifact.custody_mode === "external") return "provider_store";
  if (artifact.custody_mode === "external") return "external_remote";
  if (artifact.home_repo_id && stringValue(artifact.repo_locator.commit)) return "repo_commit";
  if (artifact.home_repo_id) return "repo_worktree";
  return null;
}

function reasonCode(reason: string): string {
  if (reason.includes("sha256")) return "missing_sha256";
  if (reason.includes("not managed")) return "not_managed_file";
  if (reason.includes("invalid")) return "invalid_file_uri";
  if (reason.includes("no registered local file")) return "no_local_file_uri";
  if (reason.includes("not available")) return "missing_bytes";
  return reason.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function checkoutRootForRepo(db: Db, repoId: string): string | null {
  if (!tableExists(db, "ledger_project_checkouts")) return null;
  const hasProjects = tableExists(db, "ledger_projects");
  const projectJoin = hasProjects ? "LEFT JOIN ledger_projects p ON p.id = c.project_id" : "";
  const projectWhere = hasProjects ? "OR p.id = @repo OR lower(p.display_name) = lower(@repo)" : "";
  const rows = db.prepare(
    `SELECT c.root
       FROM ledger_project_checkouts c
       ${projectJoin}
      WHERE c.work_repo_id = @repo
         OR lower(c.name) = lower(@repo)
         OR c.root = @repo
         ${projectWhere}
      ORDER BY c.updated_at DESC
      LIMIT 1`,
  ).all({ repo: repoId }) as Array<{ root: string | null }>;
  return rows[0]?.root ?? null;
}

function tableExists(db: Db, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) as { 1: number } | undefined;
  return Boolean(row);
}

function validateContentHash(artifact: ArtifactRecord, filePath: string): string | null {
  if (artifact.algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(artifact.content_hash)) {
    return null;
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return actual === artifact.content_hash.toLowerCase()
    ? null
    : "artifact bytes do not match registered sha256";
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function previewKind(mediaType: string, filename: string | null): Exclude<ArtifactContentKind, "unavailable"> {
  const lowerMediaType = mediaType.toLowerCase();
  const lowerName = (filename ?? "").toLowerCase();
  if (lowerMediaType.includes("json") || lowerName.endsWith(".json")) return "json";
  if (lowerMediaType.includes("markdown") || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "markdown";
  }
  if (lowerMediaType.startsWith("text/") || [".txt", ".log", ".csv", ".tsv"].some((ext) => lowerName.endsWith(ext))) {
    return "text";
  }
  return "binary";
}

function readTextPreview(filePath: string, maxBytes: number): ArtifactContentPreview {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const limit = Math.max(0, maxBytes);
    const bytesToRead = Math.min(stat.size, limit + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const read = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    const truncated = read > limit;
    return {
      encoding: "utf-8",
      text: buffer.subarray(0, truncated ? limit : read).toString("utf8"),
      truncated,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function inferMediaType(artifact: ArtifactRecord): string {
  const filename = artifactFilename(artifact);
  const lowerName = (filename ?? "").toLowerCase();
  if (lowerName.endsWith(".json")) return "application/json";
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "text/markdown";
  if (lowerName.endsWith(".txt") || lowerName.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

function artifactFilename(artifact: ArtifactRecord): string | null {
  return stringValue(artifact.metadata.filename)
    ?? stringValue(artifact.metadata.logical_name)
    ?? stringValue(artifact.repo_locator.path)?.split(/[\\/]/).pop()
    ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
