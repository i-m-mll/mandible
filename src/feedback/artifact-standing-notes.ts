import type { Db } from "../db.js";
import { artifactMaterializationTarget } from "../artifact-identity.js";
import { artifactReviewRangeKind, decodeArtifactUtf8, readArtifactBytesFull } from "../artifact-content.js";
import { getCanonicalArtifactVersion, resolveArtifactIdentity } from "../provider-artifacts.js";
import { listStandingNotes, standingNoteRecords, type StandingNoteSource } from "./standing-notes.js";
import type { CanonicalArtifactVersionRecord } from "../contracts.js";
import { artifactReviewSource } from "./review-ranges.js";

export function resolveStandingArtifactVersion(db: Db, ref: string): CanonicalArtifactVersionRecord | null {
  const resolution = resolveArtifactIdentity(db, ref, "surface");
  if (resolution.status !== "resolved") return null;
  const id = ("artifact_version" in resolution ? resolution.artifact_version?.id : undefined)
    ?? resolution.logical_artifact?.latest_version_id;
  return id ? getCanonicalArtifactVersion(db, id) : null;
}

export function artifactStandingNoteSource(db: Db, version: CanonicalArtifactVersionRecord): StandingNoteSource | null {
  const target = artifactMaterializationTarget(resolveArtifactIdentity(db, version.id, "strict-read"));
  if (!target.ok) return null;
  const rangeKind = artifactReviewRangeKind(target.value);
  if (!rangeKind) return null;
  const read = readArtifactBytesFull(db, target.value, Number.MAX_SAFE_INTEGER);
  const source = read.ok ? decodeArtifactUtf8(read.bytes) : null;
  return source === null ? null : {
    documentKey: version.artifact_id, reference: { kind: "artifact_version", artifact_version_id: version.id },
    order: version.version_no, source: artifactReviewSource(source), rangeKind,
  };
}

export function artifactStandingNoteRecords(db: Db, version: CanonicalArtifactVersionRecord) {
  return standingNoteRecords(db, version.artifact_id, version.version_no);
}

export function readArtifactStandingNotes(db: Db,
  target: StandingNoteSource, actorUserId?: string) {
  return listStandingNotes(db, target, reference => {
    if (reference.kind !== "artifact_version") return null;
    const original = getCanonicalArtifactVersion(db, reference.artifact_version_id);
    return original ? artifactStandingNoteSource(db, original) : null;
  }, actorUserId);
}
