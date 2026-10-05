import type { ArtifactRecord, ArtifactBlobRecord, ArtifactIdentityRecord, CanonicalArtifactVersionRecord } from "./contracts.js";
export const MIN_ARTIFACT_ID_PREFIX_LENGTH = 7;
export const DEFAULT_ARTIFACT_ID_PREFIX_LENGTH = 12;

export type ArtifactResolutionMode = "strict-read" | "surface" | "link";
export type {
  CanonicalArtifactTargetType, ArtifactIdentityKind, ArtifactRequestedKind,
  ResolvedArtifactIdentity, FailedArtifactIdentity, ArtifactIdentityResolution,
  ArtifactCustody, ArtifactMaterializationTarget, ArtifactMaterializationError, ArtifactMaterializationResult,
} from "./contracts.js";
import type { ArtifactIdentityResolution, FailedArtifactIdentity, ArtifactCustody, ArtifactMaterializationTarget, ArtifactMaterializationResult } from "./contracts.js";

export function artifactMaterializationTarget(resolution: ArtifactIdentityResolution): ArtifactMaterializationResult<ArtifactMaterializationTarget> {
  if (resolution.status !== "resolved") return { ok: false, error: {
    code: resolution.status === "ambiguous" ? "ambiguous_source" : "unknown_reference",
    message: `Artifact reference is ${resolution.status}`,
  }};
  const blob = resolution.artifact_blob;
  const version = resolution.artifact_version;
  if (!blob) return { ok: false, error: { code: "unavailable_material", message: "Artifact has no saved material" }};
  let custody: ArtifactCustody;
  if (version?.custody_mode === "git") {
    if (!version.source_project_id || !version.repo_path || !version.commit_sha
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(version.commit_sha)) {
      return { ok: false, error: { code: "invalid_custody", message: "Git custody requires a verified project, commit and path" }};
    }
    custody = { kind: "git", project_id: version.source_project_id, commit: version.commit_sha,
      path: version.repo_path, hash: version.content_hash };
  } else {
    if (!blob.storage_uri?.startsWith("file://")) return { ok: false, error: {
      code: "unavailable_material", message: "Stored artifact bytes are unavailable; select a saved version for Git custody",
    }};
    custody = { kind: "managed", storage_uri: blob.storage_uri, hash: version?.content_hash ?? blob.content_hash };
  }
  if (custody.hash !== blob.content_hash) return { ok: false, error: { code: "hash_mismatch", message: "Version and blob hashes disagree" }};
  return { ok: true, value: { id: version?.id ?? blob.id, version_id: version?.id ?? null, blob, custody,
    metadata: { ...blob.metadata, ...resolution.logical_artifact?.metadata, ...version?.metadata } }};
}

export type ArtifactRefClassification =
  | { kind: "logical"; ref: string }
  | { kind: "pinned-version"; ref: string }
  | { kind: "blob"; ref: string; compact: boolean }
  | { kind: "series"; ref: string }
  | { kind: "legacy-blob"; ref: string }
  | { kind: "alias"; ref: string };

/**
 * Classify author-facing artifact references before any database lookup.
 *
 * `artifact:<7+ hex>` is the current compact identity shared by immutable
 * blobs and generated logical IDs. Database resolution applies exact-logical
 * precedence and otherwise requires the prefix to be unique across both
 * namespaces.
 */
export function classifyArtifactRef(ref: string): ArtifactRefClassification {
  const trimmed = ref.trim();
  if (/^artifact:sha256:/i.test(trimmed) || /^sha256:/i.test(trimmed) || /^[a-f0-9]{7,64}$/i.test(trimmed)) {
    return { kind: "legacy-blob", ref: trimmed };
  }
  if (/^artifact-version:/i.test(trimmed)) return { kind: "pinned-version", ref: trimmed };
  if (/^artifact-blob:/i.test(trimmed)) return { kind: "blob", ref: trimmed, compact: false };
  if (/^artifact:[a-f0-9]{7,64}$/i.test(trimmed)) return { kind: "blob", ref: trimmed, compact: true };
  if (/^artifact-series:/i.test(trimmed)) return { kind: "series", ref: trimmed };
  if (/^artifact:/i.test(trimmed)) return { kind: "logical", ref: trimmed };
  return { kind: "alias", ref: trimmed };
}

export function formatCompactArtifactId(hash: string, length = DEFAULT_ARTIFACT_ID_PREFIX_LENGTH): string {
  const normalized = hash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("artifact hash must be 64 hexadecimal characters");
  const safeLength = Math.min(Math.max(length, MIN_ARTIFACT_ID_PREFIX_LENGTH), normalized.length);
  return `artifact:${normalized.slice(0, safeLength)}`;
}

export function emptyArtifactIdentityPayload() {
  return { alias: null, logical_artifact: null, artifact_version: null, artifact_blob: null };
}

export function failedArtifactIdentity(input: Omit<FailedArtifactIdentity, "kind" | "target_id">): FailedArtifactIdentity {
  return { ...input, kind: input.status, target_id: null };
}

/** Project the selected version and its shared content descriptor. */
export function projectCanonicalArtifactRecord(blob: ArtifactBlobRecord, logical: ArtifactIdentityRecord | null = null,
  version: CanonicalArtifactVersionRecord | null = null): ArtifactRecord {
  const git = version?.custody_mode === 'git';
  const locator = git ? {repo_id: version.source_project_id, path: version.repo_path, commit: version.commit_sha} : {};
  return {
    id: version?.id ?? blob.id, algorithm: blob.algorithm, content_hash: blob.content_hash,
    uri: git ? `repo://${version.source_project_id}@${version.commit_sha}/${version.repo_path}` : blob.storage_uri ?? blob.id,
    media_type: blob.media_type, role: blob.role, size_bytes: blob.size_bytes,
    provider_id: blob.provider_id, manifest_id: blob.manifest_id,
    metadata: { ...blob.metadata, ...logical?.metadata, ...version?.metadata },
    pinned: true, custody_mode: version?.custody_mode ?? (blob.storage_uri ? 'managed' : null), home_repo_id: git ? version.source_project_id : null,
    repo_locator: locator, availability: blob.storage_uri || git ? 'present' : 'missing', retention: {},
    reference: {canonical_blob_id:blob.id,canonical_artifact_id:logical?.id ?? null,canonical_version_id:version?.id ?? null},
    created_at:version?.created_at ?? blob.created_at,
  };
}

export function resolvedArtifactRecord(resolution: ArtifactIdentityResolution | null | undefined): ArtifactRecord | null {
  if (resolution?.status !== "resolved" || !resolution.artifact_blob) return null;
  return projectCanonicalArtifactRecord(resolution.artifact_blob, resolution.logical_artifact, resolution.artifact_version);
}
