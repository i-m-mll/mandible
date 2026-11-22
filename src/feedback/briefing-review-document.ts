import { createHash } from "node:crypto";
import { BriefingStoreError } from "./briefing-errors.js";
import type { Db } from "../db.js";
import { readArtifactBytesFull } from "../artifact-content.js";
import { listCommittedBranchHeads, readCommittedReviewPath } from "../artifact-commit-source.js";
import { canonicalJson } from "../canonical-json.js";
import { getCanonicalArtifactVersion } from "../provider-artifacts.js";
import type { ArtifactReviewDocument, GitReviewDocument, ReviewDocumentReference } from "./review-types.js";

class BriefingDocumentError extends BriefingStoreError {
  constructor(message: string, code: "document_unavailable" | "document_integrity_failed" | "invalid_comparison_target") {
    super(message, code === "invalid_comparison_target" ? 400 : 409, code);
  }
}

export type PinnedBriefingText = { source: string; content_hash: string; utf8_bom: boolean };

function briefingText(bytes: Uint8Array, content_hash = createHash("sha256").update(bytes).digest("hex")): PinnedBriefingText {
  try {
    return {
      source: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      content_hash,
      utf8_bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    };
  } catch {
    throw new BriefingDocumentError("round document is not valid UTF-8", "document_unavailable");
  }
}

/** Briefing offsets and directive digests use the historical decoded text, which omits a UTF-8 BOM. */
export function pinnedRoundDocument(db: Db, versionId: string): PinnedBriefingText {
  const version = getCanonicalArtifactVersion(db, versionId);
  if (!version || version.id !== versionId) {
    throw new BriefingDocumentError("round document is unavailable", "document_unavailable");
  }
  const content = readArtifactBytesFull(db, version.id);
  if (!content.ok) throw new BriefingDocumentError(
    content.code === "hash_mismatch" ? "round document failed integrity verification" : "round document is unavailable",
    content.code === "hash_mismatch" ? "document_integrity_failed" : "document_unavailable",
  );
  return briefingText(content.bytes, version.content_hash);
}

export function artifactReviewDocument(artifact_version_id: string): ArtifactReviewDocument {
  return { kind: "artifact_version", artifact_version_id };
}

function trackedLocation(db: Db, versionId: string) {
  const version = getCanonicalArtifactVersion(db, versionId);
  return version?.custody_mode === "git" && version.source_project_id && version.repo_path
    ? { project_id: version.source_project_id, path: version.repo_path } : null;
}

function readGitComparison(db: Db, location: Pick<GitReviewDocument, "project_id" | "path">, commit: string) {
  try {
    const file = readCommittedReviewPath(db, { project: location.project_id, path: location.path, commit });
    const target: GitReviewDocument = { kind: "git_file", ...location, commit: file.commit, blob: file.blob };
    return { target, ...briefingText(file.bytes ?? new Uint8Array()), retain: file.retain };
  } catch (error) {
    throw new BriefingDocumentError(`comparison document is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      "document_unavailable");
  }
}

export function defaultBriefingComparison(db: Db, input: {
  versionId: string; explicitVersionId: string | null; previousRoundId: string | null;
}): ReviewDocumentReference | null {
  if (input.explicitVersionId) return artifactReviewDocument(input.explicitVersionId);
  const location = trackedLocation(db, input.versionId);
  if (location) {
    const { defaultBranch, branches } = comparisonBranchHeads(db, location.project_id);
    const head = branches.find((branch) => branch.name === defaultBranch);
    if (!head) throw new BriefingDocumentError("the project's protected branch head is unavailable", "document_unavailable");
    const comparison = readGitComparison(db, location, head.commit);
    comparison.retain();
    return comparison.target;
  }
  if (!input.previousRoundId) return null;
  const previous = db.prepare("SELECT artifact_version_id FROM briefing_rounds WHERE id = ?")
    .get(input.previousRoundId) as { artifact_version_id: string };
  return artifactReviewDocument(previous.artifact_version_id);
}

function comparisonBranchHeads(db: Db, projectId: string) {
  try {
    return listCommittedBranchHeads(db, projectId);
  } catch (error) {
    throw new BriefingDocumentError(error instanceof Error ? error.message : String(error), "document_unavailable");
  }
}

export function briefingComparisonBranches(db: Db, versionId: string) {
  const location = trackedLocation(db, versionId);
  return location ? comparisonBranchHeads(db, location.project_id).branches : [];
}

export function resolveBriefingBranchComparison(db: Db, versionId: string, commit: string) {
  const location = trackedLocation(db, versionId);
  if (!location || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new BriefingDocumentError("comparison requires a tracked document and a full commit id", "invalid_comparison_target");
  }
  const { retain: _retain, ...comparison } = readGitComparison(db, location, commit);
  return { artifact_version_id: null, ...comparison };
}

export function materializeBriefingComparison(db: Db, target: ReviewDocumentReference | null) {
  if (!target) return null;
  if (target.kind === "artifact_version") {
    return { artifact_version_id: target.artifact_version_id, target, ...pinnedRoundDocument(db, target.artifact_version_id) };
  }
  if (target.kind !== "git_file") throw new BriefingDocumentError("invalid briefing document binding", "invalid_comparison_target");
  const { target: actual, retain: _retain, ...document } = readGitComparison(db, target, target.commit);
  if (canonicalJson(actual) !== canonicalJson(target)) {
    throw new BriefingDocumentError("pinned comparison file identity changed", "document_integrity_failed");
  }
  return { artifact_version_id: null, target, ...document };
}

export function validateBriefingSubmissionComparison(db: Db, input: {
  versionId: string; defaultTarget: ReviewDocumentReference | null; supplied: unknown; operator: boolean;
}): ReviewDocumentReference | null {
  if (input.supplied === undefined || canonicalJson(input.supplied) === canonicalJson(input.defaultTarget)) return input.defaultTarget;
  const requested = input.supplied;
  if (requested && typeof requested === "object" && "kind" in requested) {
    if (requested.kind === "git_file" && input.operator && "commit" in requested && typeof requested.commit === "string"
        && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(requested.commit)) {
      const location = trackedLocation(db, input.versionId);
      if (location) {
        const comparison = readGitComparison(db, location, requested.commit);
        if (canonicalJson(comparison.target) === canonicalJson(requested)) {
          comparison.retain();
          return comparison.target;
        }
      }
    }
    if (requested.kind === "artifact_version" && "artifact_version_id" in requested && typeof requested.artifact_version_id === "string") {
      const version = getCanonicalArtifactVersion(db, requested.artifact_version_id);
      const current = getCanonicalArtifactVersion(db, input.versionId);
      if (version && current && version.artifact_id === current.artifact_id) {
        pinnedRoundDocument(db, version.id);
        return artifactReviewDocument(version.id);
      }
    }
  }
  if (requested === null) return null;
  throw new BriefingDocumentError("comparison target does not belong to this review document", "invalid_comparison_target");
}
