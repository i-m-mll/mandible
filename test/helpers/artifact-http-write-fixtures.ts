import type { Db } from "../../src/db.js";
import {
  recordArtifactVersion as recordCanonicalVersion,
  commitArtifactVersion as commitCanonicalVersion,
  commitArtifactVersionBatch as commitCanonicalBatch,
  publishArtifactDraft as publishCanonicalDraft,
  appendArtifactVersion as appendCanonicalVersion,
  projectArtifactVersionWriteResult,
  projectArtifactResolution,
  resolveArtifactIdentity,
} from "../../src/provider-artifacts.js";

/** Existing HTTP-shape fixtures exercise the retained external projection. */
export function recordArtifactVersion(...args: Parameters<typeof recordCanonicalVersion>) {
  return projectArtifactVersionWriteResult(args[0], recordCanonicalVersion(...args));
}
export function commitArtifactVersion(...args: Parameters<typeof commitCanonicalVersion>) {
  const result = commitCanonicalVersion(...args);
  return result.ok ? { ok: true as const, value: projectArtifactVersionWriteResult(args[0], result.value) } : result;
}
export function commitArtifactVersionBatch(...args: Parameters<typeof commitCanonicalBatch>) {
  const result = commitCanonicalBatch(...args);
  return result.ok ? { ok: true as const, value: result.value.map(value => projectArtifactVersionWriteResult(args[0], value)) } : result;
}
export function publishArtifactDraft(...args: Parameters<typeof publishCanonicalDraft>) {
  const result = publishCanonicalDraft(...args);
  return { draft: result.draft, result: projectArtifactVersionWriteResult(args[0], result.result) };
}
export function appendArtifactVersion(db: Db,
  input: Omit<Parameters<typeof appendCanonicalVersion>[1], "logical_artifact_id" | "blob_id"> & { series_id: string; artifact_id: string }, now?: number) {
  const blob = resolveArtifactIdentity(db, input.artifact_id, "surface").artifact_blob;
  if (!blob) throw new Error("Fixture blob did not resolve");
  const result = appendCanonicalVersion(db, { ...input, logical_artifact_id: input.series_id.replace(/^artifact-series:/, "artifact:"), blob_id: blob.id }, now);
  return { ...result, version: projectArtifactResolution(db, resolveArtifactIdentity(db, result.version.id)).version! };
}
export function resolveArtifactRef(db: Db, ref: string, now?: number) {
  return projectArtifactResolution(db, resolveArtifactIdentity(db, ref, "strict-read", now));
}
export function resolveArtifactRefReadonlyFull(db: Db, ref: string) {
  return projectArtifactResolution(db, resolveArtifactIdentity(db, ref));
}
export function resolveArtifactLinkRef(db: Db, ref: string, now?: number) {
  return projectArtifactResolution(db, resolveArtifactIdentity(db, ref, "link", now));
}
export function resolveArtifactSurfaceRefReadonlyFull(db: Db, ref: string) {
  return projectArtifactResolution(db, resolveArtifactIdentity(db, ref, "surface"));
}
