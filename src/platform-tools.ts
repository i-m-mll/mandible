import { spawnSync } from "node:child_process";

/** Native text diff adapter. Windows packaging must provide this role before enabling revision diffs. */
export function nativeRevisionDiff(oldFile: string, newFile: string, oldLabel: string, newLabel: string):
  { ok: true; output: string } | { ok: false; message: string } {
  if (process.platform !== "darwin" && process.platform !== "linux") return { ok: false, message: "Revision diff is not implemented for this native platform." };
  const result = spawnSync("/usr/bin/diff", ["-u", "-L", oldLabel, "-L", newLabel, oldFile, newFile], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status === null || result.status > 1) return { ok: false, message: result.error?.message ?? result.stderr };
  return { ok: true, output: result.stdout };
}
