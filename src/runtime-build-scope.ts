import { isBuildSourcePath } from "../scripts/build-revision.mjs";
import type { AuthRequest } from "./types.js";

export function authRequestChangesBuildInputs(request: Pick<AuthRequest, "merge_head_sha" | "change_report">): boolean {
  const report = request.change_report;
  if (!report || report.comparison.head_sha !== request.merge_head_sha) return true;
  return report.files.some(file => [file.old_path, file.new_path].some(name => name !== null && isBuildSourcePath(name)));
}
