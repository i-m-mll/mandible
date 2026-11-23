import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installedResourceRoot, readInstalledRelease, releaseFile } from "../scripts/installed-release.mjs";

type FolderSelection =
  | { ok: true; path: string | null }
  | { ok: false; error: string };

const execFileAsync = promisify(execFile);

export async function chooseProjectFolder(signal: AbortSignal | undefined): Promise<FolderSelection> {
  if (process.platform !== "darwin") return { ok: false, error: "The project folder panel requires macOS." };
  if (signal?.aborted) return { ok: true, path: null };
  try {
    const resources = installedResourceRoot();
    const helper = resources
      ? releaseFile(resources, readInstalledRelease(resources).native.projectFolderHelper)
      : fileURLToPath(new URL("../src-tauri/resources/MandibleProjectFolder.app/Contents/MacOS/mandible-project-folder", import.meta.url));
    const { stdout } = await execFileAsync(helper, [], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 5 * 60_000,
      signal,
    });
    const selection: unknown = JSON.parse(stdout);
    if (selection === null || (typeof selection === "string" && path.isAbsolute(selection))) {
      return { ok: true, path: selection };
    }
    return { ok: false, error: "The project folder panel returned an invalid selection." };
  } catch {
    if (signal?.aborted) return { ok: true, path: null };
    return { ok: false, error: "The project folder panel could not open or finish." };
  }
}
