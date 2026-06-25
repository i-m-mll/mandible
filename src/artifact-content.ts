import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { getArtifact, resolveArtifactRef } from "./provider-artifacts.js";
import type { ArtifactMaterializationCheck, ArtifactRecord, ArtifactRecoverability } from "./types.js";

const DEFAULT_PREVIEW_BYTES = 128 * 1024;
const HTML_PREVIEW_BYTES = 8 * 1024 * 1024;

export type ArtifactContentKind = "text" | "markdown" | "json" | "html" | "binary" | "unavailable";
export type ArtifactContentSourceKind = "managed_file" | "repo_locator" | "local_file";

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
  warnings?: string[];
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

  const localPath = resolveLinkFileArtifact(artifact);
  if (isMutableLocalFileLink(artifact) && localPath.ok) {
    return checkResolvedFile(artifact, localPath.path, "local_file", expected, recoverability, options.ref);
  }
  const aliasPath = isMutableLocalFileLink(artifact)
    ? resolveLocalFileAliasArtifact(db, artifact)
    : { ok: false as const, reason: "artifact has no resolved local file alias" };
  if (isMutableLocalFileLink(artifact) && aliasPath.ok) {
    return checkResolvedFile(artifact, aliasPath.path, "local_file", expected, recoverability, options.ref);
  }
  if (isMutableLocalFileLink(artifact)) {
    reasons.push(reasonCode(aliasPath.ok ? "no_materializable_location" : aliasPath.reason));
    if (artifact.availability === "remote_only") reasons.push("remote_only");
    if (artifact.availability === "missing") reasons.push("missing");
    warnings.push("local_only");
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

  const repoBytes = readRepoArtifactBytes(db, artifact);
  if (repoBytes.ok) {
    const actual = crypto.createHash("sha256").update(repoBytes.bytes).digest("hex");
    const mismatch = expected && actual !== expected;
    const drift = mismatch && isMutableLocalDrift(recoverability);
    const repoWarnings = repoBytes.warning ? [repoBytes.warning] : [];
    return {
      artifact_id: artifact.id,
      ref: options.ref,
      materializable: true,
      hash_matches: expected ? actual === expected : null,
      expected_sha256: expected,
      actual_sha256: actual,
      source: repoBytes.source,
      recoverability,
      reasons: mismatch ? [drift ? "local_file_drift" : "hash_mismatch"] : [],
      warnings: drift
        ? [...repoWarnings, "local_only artifact bytes differ from the registered sha256"]
        : repoWarnings,
    };
  }
  if (artifact.home_repo_id || Object.keys(artifact.repo_locator ?? {}).length > 0) {
    reasons.push(repoBytes.reason);
  }

  if (localPath.ok) {
    return checkResolvedFile(artifact, localPath.path, "local_file", expected, recoverability, options.ref);
  }
  if (artifact.uri.startsWith("file://")) {
    reasons.push(reasonCode(localPath.reason));
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

  const hashCheck = validateContentHash(artifact, resolved.path, recoverabilityForArtifact(artifact));
  if (!hashCheck.ok) {
    return unresolvedDownload(hashCheck.reason);
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
    warnings: hashCheck.warnings,
  };

  const kind = previewKind(mediaType, filename);
  if (kind === "binary") {
    return {
      ...base,
      kind,
      preview: null,
    };
  }

  const textPreviewBytes = kind === "html" ? Math.max(previewBytes, HTML_PREVIEW_BYTES) : previewBytes;
  const preview = readTextPreview(resolved.path, textPreviewBytes);
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

  const linkPath = resolveLinkFileArtifact(artifact);
  if (isMutableLocalFileLink(artifact) && linkPath.ok) return linkPath;
  if (isMutableLocalFileLink(artifact)) {
    const aliasPath = resolveLocalFileAliasArtifact(db, artifact);
    return aliasPath.ok ? aliasPath : linkPath;
  }

  const repoPath = resolveRepoArtifact(db, artifact);
  if (repoPath.ok) return repoPath;

  if (linkPath.ok) return linkPath;

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

function resolveLinkFileArtifact(
  artifact: ArtifactRecord,
): { ok: true; path: string; source: ArtifactContentResult["source"] } | { ok: false; reason: string } {
  if (!artifact.uri.startsWith("file://")) {
    return { ok: false, reason: "artifact has no registered local file URI" };
  }
  if (artifact.custody_mode !== "link") {
    return { ok: false, reason: "local file URI is not link custody" };
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
    source: { kind: "local_file", locator: artifact.uri },
  };
}

function resolveLocalFileAliasArtifact(
  db: Db,
  artifact: ArtifactRecord,
): { ok: true; path: string; source: ArtifactContentResult["source"] } | { ok: false; reason: string } {
  if (!tableExists(db, "artifact_aliases")) {
    return { ok: false, reason: "artifact has no resolved local file alias" };
  }
  const rows = db.prepare(
    `SELECT normalized_ref
       FROM artifact_aliases
      WHERE artifact_id = ?
        AND scheme = 'file'
        AND resolution_status = 'resolved'
      ORDER BY CASE WHEN normalized_ref = ? THEN 1 ELSE 0 END, updated_at DESC, normalized_ref`,
  ).all(artifact.id, artifact.uri) as Array<{ normalized_ref: string }>;

  for (const row of rows) {
    const resolved = resolveFileUriPath(row.normalized_ref, row.normalized_ref);
    if (resolved.ok) return resolved;
  }
  return { ok: false, reason: "artifact bytes are not available on disk" };
}

function resolveFileUriPath(
  uri: string,
  locator: string,
): { ok: true; path: string; source: ArtifactContentResult["source"] } | { ok: false; reason: string } {
  if (!uri.startsWith("file://")) {
    return { ok: false, reason: "artifact has no registered local file URI" };
  }

  let filePath: string;
  try {
    filePath = fileURLToPath(new URL(uri));
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
    source: { kind: "local_file", locator },
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
  const mismatch = expected && actual !== expected;
  const drift = mismatch && isMutableLocalDrift(recoverability);
  return {
    artifact_id: artifact.id,
    ref,
    materializable: true,
    hash_matches: expected ? actual === expected : null,
    expected_sha256: expected,
    actual_sha256: actual,
    source,
    recoverability,
    reasons: mismatch ? [drift ? "local_file_drift" : "hash_mismatch"] : [],
    warnings: drift ? ["local_only artifact bytes differ from the registered sha256"] : [],
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
  if (isMutableLocalFileLink(artifact)) return "local_only";
  if (artifact.provider_id && artifact.custody_mode === "external") return "provider_store";
  if (artifact.custody_mode === "external") return "external_remote";
  if (artifact.home_repo_id && stringValue(artifact.repo_locator.commit)) return "repo_commit";
  if (artifact.home_repo_id) return "repo_worktree";
  return null;
}

function isMutableLocalFileLink(artifact: ArtifactRecord): boolean {
  return artifact.custody_mode === "link"
    && artifact.uri.startsWith("file://")
    && !stringValue(artifact.repo_locator?.commit);
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

function validateContentHash(
  artifact: ArtifactRecord,
  filePath: string,
  recoverability: ArtifactRecoverability | null,
): { ok: true; warnings: string[] } | { ok: false; reason: string } {
  if (artifact.algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(artifact.content_hash)) {
    return { ok: true, warnings: [] };
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual === artifact.content_hash.toLowerCase()) {
    return { ok: true, warnings: [] };
  }
  if (isMutableLocalDrift(recoverability)) {
    return {
      ok: true,
      warnings: ["local_only artifact bytes differ from the registered sha256; previewing current local bytes"],
    };
  }
  return { ok: false, reason: "artifact bytes do not match registered sha256" };
}

function isMutableLocalDrift(recoverability: ArtifactRecoverability | null): boolean {
  return recoverability === "local_only";
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
  if (lowerMediaType.includes("html") || lowerName.endsWith(".html") || lowerName.endsWith(".htm")) return "html";
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
  if (lowerName.endsWith(".html") || lowerName.endsWith(".htm")) return "text/html";
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

// ---------------------------------------------------------------------------
// Artifact full-byte reads and text/JSON/Markdown diffs (issue f7a994e).
//
// Diffs are DERIVED from full snapshot bytes (never stored as the canonical
// representation) — analogous to the issue/comment body-revision diff
// precedent. The immutable artifact rows remain the source of truth.
// ---------------------------------------------------------------------------

const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_CELLS = 4_000_000;

export interface ArtifactDiffSide {
  ref: string;
  artifact_id: string | null;
  content_hash: string | null;
  media_type: string;
  size_bytes: number | null;
  available: boolean;
  reason?: string;
}

export interface ArtifactDiffResult {
  a: ArtifactDiffSide;
  b: ArtifactDiffSide;
  diffable: boolean;
  identical: boolean;
  kind: ArtifactContentKind;
  unified: string | null;
  stats: { added: number; removed: number } | null;
  reason?: string;
}

function readArtifactBytesFull(
  db: Db,
  id: string,
  maxBytes = MAX_DIFF_BYTES,
): { ok: true; bytes: Buffer; source: string } | { ok: false; reason: string } {
  const artifact = getArtifact(db, id);
  if (!artifact) return { ok: false, reason: "artifact not found" };

  // Prefer commit-pinned repo bytes so an old version reads its exact snapshot
  // rather than the current working-tree state.
  const commit = stringValue(artifact.repo_locator.commit);
  if (commit && /^[a-f0-9]{40,64}$/i.test(commit)) {
    const repo = readRepoArtifactBytes(db, artifact);
    if (repo.ok) {
      if (repo.bytes.byteLength > maxBytes) return { ok: false, reason: "artifact exceeds diff size limit" };
      return { ok: true, bytes: repo.bytes, source: repo.source };
    }
  }

  const resolved = resolveRegisteredArtifactPath(db, artifact);
  if (resolved.ok) {
    const stat = safeStat(resolved.path);
    if (stat?.isFile()) {
      if (stat.size > maxBytes) return { ok: false, reason: "artifact exceeds diff size limit" };
      return { ok: true, bytes: fs.readFileSync(resolved.path), source: resolved.source?.kind ?? "file" };
    }
  }

  const repo = readRepoArtifactBytes(db, artifact);
  if (repo.ok) {
    if (repo.bytes.byteLength > maxBytes) return { ok: false, reason: "artifact exceeds diff size limit" };
    return { ok: true, bytes: repo.bytes, source: repo.source };
  }

  return { ok: false, reason: resolved.ok ? "artifact bytes are not available on disk" : resolved.reason };
}

function diffSideMeta(artifact: ArtifactRecord | null, ref: string): ArtifactDiffSide {
  if (!artifact) {
    return { ref, artifact_id: null, content_hash: null, media_type: "application/octet-stream", size_bytes: null, available: false, reason: "artifact ref did not resolve" };
  }
  return {
    ref,
    artifact_id: artifact.id,
    content_hash: artifact.content_hash,
    media_type: artifact.media_type ?? inferMediaType(artifact),
    size_bytes: artifact.size_bytes,
    available: true,
  };
}

// Resolve a diff ref to its immutable artifact, accepting version/series refs,
// registerable hash refs, and the canonical `artifact:sha256:<hash>` id form.
function resolveDiffArtifact(db: Db, ref: string): ArtifactRecord | null {
  return resolveArtifactRef(db, ref).artifact ?? getArtifact(db, ref);
}

export function diffArtifacts(db: Db, refA: string, refB: string): ArtifactDiffResult {
  const artifactA = resolveDiffArtifact(db, refA);
  const artifactB = resolveDiffArtifact(db, refB);
  const sideA = diffSideMeta(artifactA, refA);
  const sideB = diffSideMeta(artifactB, refB);

  const fail = (reason: string, kind: ArtifactContentKind = "unavailable"): ArtifactDiffResult => ({
    a: sideA, b: sideB, diffable: false, identical: false, kind, unified: null, stats: null, reason,
  });

  if (!artifactA || !artifactB) {
    return fail("one or both artifact refs did not resolve");
  }

  const kindA = previewKind(sideA.media_type, artifactFilename(artifactA));
  const kindB = previewKind(sideB.media_type, artifactFilename(artifactB));
  if (kindA === "binary" || kindB === "binary") {
    return fail("artifact content is not text-like; diff is unavailable", "binary");
  }

  const identical = artifactA.algorithm === "sha256"
    && artifactB.algorithm === "sha256"
    && artifactA.content_hash.toLowerCase() === artifactB.content_hash.toLowerCase();

  const bytesA = readArtifactBytesFull(db, artifactA.id);
  if (!bytesA.ok) {
    sideA.available = false;
    sideA.reason = bytesA.reason;
    return fail(`left artifact bytes unavailable: ${bytesA.reason}`);
  }
  const bytesB = readArtifactBytesFull(db, artifactB.id);
  if (!bytesB.ok) {
    sideB.available = false;
    sideB.reason = bytesB.reason;
    return fail(`right artifact bytes unavailable: ${bytesB.reason}`);
  }

  const isJson = kindA === "json" || kindB === "json";
  const textA = normalizeDiffText(bytesA.bytes.toString("utf8"), isJson);
  const textB = normalizeDiffText(bytesB.bytes.toString("utf8"), isJson);
  const kind: ArtifactContentKind = isJson
    ? "json"
    : (kindA === "markdown" || kindB === "markdown")
      ? "markdown"
      : (kindA === "html" || kindB === "html")
        ? "html"
        : "text";

  if (identical || textA === textB) {
    return { a: sideA, b: sideB, diffable: true, identical: true, kind, unified: "", stats: { added: 0, removed: 0 } };
  }

  const linesA = textA.split("\n");
  const linesB = textB.split("\n");
  if (linesA.length * linesB.length > MAX_DIFF_CELLS) {
    return {
      a: sideA,
      b: sideB,
      diffable: true,
      identical: false,
      kind,
      unified: `# diff omitted: content too large for line-level diff (${linesA.length} vs ${linesB.length} lines)\n`,
      stats: null,
    };
  }

  const ops = diffLines(linesA, linesB);
  const stats = ops.reduce(
    (acc, op) => {
      if (op.tag === "+") acc.added += 1;
      if (op.tag === "-") acc.removed += 1;
      return acc;
    },
    { added: 0, removed: 0 },
  );
  const unified = formatUnifiedDiff(
    artifactFilename(artifactA) ?? sideA.artifact_id ?? refA,
    artifactFilename(artifactB) ?? sideB.artifact_id ?? refB,
    ops,
  );
  return { a: sideA, b: sideB, diffable: true, identical: false, kind, unified, stats };
}

function normalizeDiffText(text: string, isJson: boolean): string {
  const stripped = text.replace(/\r\n/g, "\n");
  if (!isJson) return stripped;
  try {
    return JSON.stringify(JSON.parse(stripped), null, 2);
  } catch {
    return stripped;
  }
}

type DiffOp = { tag: " " | "-" | "+"; text: string };

// Line-based LCS diff. Standard O(n*m) DP with backtracking; callers bound
// n*m via MAX_DIFF_CELLS before invoking.
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ tag: "-", text: a[i] });
      i += 1;
    } else {
      ops.push({ tag: "+", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ tag: "-", text: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ tag: "+", text: b[j] });
    j += 1;
  }
  return ops;
}

// Group ops into unified-diff hunks with 3 lines of context.
function formatUnifiedDiff(nameA: string, nameB: string, ops: DiffOp[], context = 3): string {
  const lines: string[] = [`--- ${nameA}`, `+++ ${nameB}`];
  const changeIdx = ops
    .map((op, idx) => (op.tag === " " ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (changeIdx.length === 0) return "";

  // Compute hunk ranges (indices into ops) merged when within 2*context.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  let aLine = 1;
  let bLine = 1;
  // Precompute per-op starting line numbers.
  const aStarts: number[] = [];
  const bStarts: number[] = [];
  for (const op of ops) {
    aStarts.push(aLine);
    bStarts.push(bLine);
    if (op.tag !== "+") aLine += 1;
    if (op.tag !== "-") bLine += 1;
  }

  for (const range of ranges) {
    let aCount = 0;
    let bCount = 0;
    for (let k = range.start; k <= range.end; k += 1) {
      if (ops[k].tag !== "+") aCount += 1;
      if (ops[k].tag !== "-") bCount += 1;
    }
    const aStart = aCount === 0 ? aStarts[range.start] - 1 : aStarts[range.start];
    const bStart = bCount === 0 ? bStarts[range.start] - 1 : bStarts[range.start];
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let k = range.start; k <= range.end; k += 1) {
      lines.push(`${ops[k].tag}${ops[k].text}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
