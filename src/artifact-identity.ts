import type {
  ArtifactAliasRecord,
  ArtifactBlobRecord,
  ArtifactIdentityRecord,
  ArtifactRecord,
  ArtifactResolveResult,
  CanonicalArtifactVersionRecord,
} from "./types.js";

export const MIN_ARTIFACT_ID_PREFIX_LENGTH = 7;
export const DEFAULT_ARTIFACT_ID_PREFIX_LENGTH = 12;

export type ArtifactResolutionMode = "strict-read" | "surface" | "link" | "materializing";
export type CanonicalArtifactTargetType = "artifact" | "artifact_version" | "artifact_blob";
export type ArtifactIdentityKind = "logical" | "pinned-version" | "blob" | "alias";
export type ArtifactRequestedKind = ArtifactIdentityKind | "series" | "unknown";

interface ArtifactIdentityPayload {
  artifact: ArtifactRecord | null;
  alias: ArtifactAliasRecord | null;
  logical_artifact: ArtifactIdentityRecord | null;
  artifact_version: CanonicalArtifactVersionRecord | null;
  artifact_blob: ArtifactBlobRecord | null;
}

interface ArtifactIdentityBase extends ArtifactIdentityPayload {
  ref: string;
  scheme: string;
  normalized_ref: string;
  warnings: string[];
}

export interface ResolvedArtifactIdentity extends ArtifactIdentityBase {
  status: "resolved";
  kind: ArtifactIdentityKind;
  target_type: CanonicalArtifactTargetType;
  target_id: string;
}

export interface FailedArtifactIdentity extends ArtifactIdentityBase {
  status: "unresolved" | "ambiguous" | "unsupported";
  kind: "unresolved" | "ambiguous" | "unsupported";
  requested_kind: ArtifactRequestedKind;
  target_type: CanonicalArtifactTargetType | null;
  target_id: null;
}

export type ArtifactIdentityResolution = ResolvedArtifactIdentity | FailedArtifactIdentity;

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

export function emptyArtifactIdentityPayload(): ArtifactIdentityPayload {
  return {
    artifact: null,
    alias: null,
    logical_artifact: null,
    artifact_version: null,
    artifact_blob: null,
  };
}

export function resolvedArtifactIdentity(
  input: Omit<ResolvedArtifactIdentity, "status">,
): ResolvedArtifactIdentity {
  if (!input.target_id) throw new Error("resolved artifact identity requires a canonical target id");
  return { ...input, status: "resolved" };
}

export function failedArtifactIdentity(
  input: Omit<FailedArtifactIdentity, "kind" | "target_id">,
): FailedArtifactIdentity {
  return { ...input, kind: input.status, target_id: null };
}

/**
 * Compatibility-only projection for the historical public resolver shape.
 *
 * The deprecated `series` and `version` fields are deliberately absent here:
 * they are computed from canonical records by the caller that owns the HTTP
 * boundary, so no canonical code path can read them back as domain facts.
 */
export function projectLegacyArtifactResolution(
  resolution: ArtifactIdentityResolution,
): ArtifactResolveResult {
  return {
    status: resolution.status,
    ref: resolution.ref,
    scheme: resolution.scheme,
    normalized_ref: resolution.normalized_ref,
    target_type: resolution.target_type ?? undefined,
    target_id: resolution.target_id,
    artifact: resolution.artifact,
    alias: resolution.alias,
    logical_artifact: resolution.logical_artifact,
    artifact_version: resolution.artifact_version,
    artifact_blob: resolution.artifact_blob,
    warnings: resolution.warnings,
  };
}
