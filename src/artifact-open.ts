import { execFile } from "node:child_process";
import type { Db } from "./db.js";
import { resolveArtifactOpenFile } from "./artifact-content.js";

export type ArtifactExternalOpenResult =
  | { ok: true; artifact_id: string }
  | { ok: false; status: 404 | 409 | 500; reason: string };

type DefaultApplicationOpener = (filePath: string) => Promise<void>;

export function openWithDefaultApplication(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", [filePath], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Resolve registered artifact custody server-side, then open its regular file. */
export async function openArtifactExternally(
  db: Db,
  artifactId: string,
  opener: DefaultApplicationOpener = openWithDefaultApplication,
): Promise<ArtifactExternalOpenResult> {
  const resolved = await resolveArtifactOpenFile(db, artifactId);
  if (!resolved) {
    return { ok: false, status: 404, reason: "artifact not found" };
  }
  if (!resolved.ok) {
    return {
      ok: false,
      status: 409,
      reason: resolved.reason,
    };
  }

  try {
    await opener(resolved.path);
    return { ok: true, artifact_id: resolved.artifact_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, reason: `failed to open artifact: ${message}` };
  }
}
