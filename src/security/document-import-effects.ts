import type { Db } from "../db.js";
import { artifactMaterializationTarget } from "../artifact-identity.js";
import { resolveArtifactIdentity } from "../provider-artifacts.js";
import { documentHistoryEntry } from "../spaces/history.js";
import type { Effect } from "./operation-policy.js";

const LOCAL_IMPORT: readonly Effect[] = ["ledger:read", "ledger:write"];
const HOST_IMPORT: readonly Effect[] = [...LOCAL_IMPORT, "files:production"];

/** Permission follows saved-version custody, never the request's reference spelling. */
export function documentArtifactImportEffects(db: Db, ref: unknown): readonly Effect[] {
  if (typeof ref !== "string") return HOST_IMPORT;
  const target = artifactMaterializationTarget(resolveArtifactIdentity(db, ref, "strict-read"));
  return target.ok && target.value.custody.kind === "managed" ? LOCAL_IMPORT : HOST_IMPORT;
}

export function documentHistoryImportEffects(db: Db, spaceId: string, historyId: string): readonly Effect[] {
  const entry = documentHistoryEntry(db, spaceId, historyId);
  if (typeof entry?.artifact_ref === "string") return documentArtifactImportEffects(db, entry.artifact_ref);
  return typeof entry?.content === "string" ? LOCAL_IMPORT : HOST_IMPORT;
}
