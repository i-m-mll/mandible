import { retainArtifactCommit } from "./artifact-commit-source.js";
import { recoverArtifactCustody } from "./artifact-recovery.js";
import { reconcileRecoveredArtifactSources } from "./artifact-source-recovery.js";
import type { Db } from "./db.js";
import { preserveLegacyDocuments } from "./spaces/history.js";

export { preserveLegacyDocuments };

export function recoverPre185ArtifactCustody(db: Db): void {
  const recovery = recoverArtifactCustody(db, { retain_git_commit: retainArtifactCommit });
  if (!recovery.recovery_receipt_path) throw new Error("Artifact recovery did not preserve its audit receipt");
  reconcileRecoveredArtifactSources(db, {
    collisions: "managed",
    receipt_path: `${recovery.recovery_receipt_path}.sources.json`,
    history_shape: "v184",
  });
}
