import { isBuildSourcePath } from "../scripts/build-revision.mjs";
import type { AuthRequest } from "./types.js";

export const MANDIBLE_REBUILD_HOOK_ID = "builtin-mandible-rebuild";

export function authRequestChangesBuildInputs(request: Pick<AuthRequest, "merge_head_sha" | "merge_effective_head_sha" | "merge_candidate_pin_sha" | "change_report">, original?: AuthRequest["change_report"]): boolean {
  const report = request.change_report;
  if (original !== undefined && authRequestChangesBuildInputs({ merge_head_sha: request.merge_head_sha, change_report: original })) return true;
  const head = request.merge_effective_head_sha ? request.merge_candidate_pin_sha : request.merge_head_sha;
  if (!report || report.comparison.head_sha !== head) return true;
  return report.files.some(file => [file.old_path, file.new_path].some(name => name !== null && isBuildSourcePath(name)));
}
