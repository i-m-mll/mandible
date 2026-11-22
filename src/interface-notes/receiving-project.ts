import type { Db } from "../db.js";
import { readOriginRemote, resolveProjectForCheckoutReadOnly } from "../ledger/projects.js";
import { installedResourceRoot, readInstalledRelease } from "../../scripts/installed-release.mjs";
import { MANDIBLE_INTERFACE_NOTES_APP } from "./contract.js";

/**
 * A note's receiving project is the project of the code that serves the page it
 * was made on. An embedding app's key names its project (`feedbax:web`). Mandible's
 * own interface is served by this daemon's build: a checkout resolves by the embed's
 * rule (a registered checkout root, or an origin remote equal to a project's
 * identity), and an installed release by the repository identity recorded in its
 * `release.json` provenance when it was staged.
 */
export type MandibleBuild =
  | { kind: "checkout"; root: string; remoteUrl: string }
  | { kind: "release"; repository: string | null };

export type ReceivingProject = { id: string; key: string; name: string };

export function currentMandibleBuild(checkoutRoot: string): MandibleBuild {
  const installed = installedResourceRoot();
  if (installed) return { kind: "release", repository: readInstalledRelease(installed).provenance.repository ?? null };
  return { kind: "checkout", root: checkoutRoot, remoteUrl: readOriginRemote(checkoutRoot) };
}

type ProjectRow = { id: string; project_key: string; display_name: string };

function projectWhere(db: Db, column: "id" | "project_key" | "remote_identity", value: string): ReceivingProject | null {
  const row = db.prepare(`SELECT id, project_key, display_name FROM ledger_projects WHERE ${column} = ?`).get(value) as ProjectRow | undefined;
  return row ? { id: row.id, key: row.project_key, name: row.display_name } : null;
}

/** The project whose issues receive an app's notes, or null when the app's code is no registered project's. */
export function receivingProject(db: Db, build: MandibleBuild, app: string): ReceivingProject | null {
  if (app !== MANDIBLE_INTERFACE_NOTES_APP) return projectWhere(db, "project_key", app.slice(0, app.indexOf(":")));
  if (build.kind === "release") return build.repository ? projectWhere(db, "remote_identity", build.repository) : null;
  const resolved = resolveProjectForCheckoutReadOnly(db, { root: build.root, remoteUrl: build.remoteUrl });
  const id = resolved.status === "resolved" ? resolved.project.id : resolved.matchedProjectId;
  return id ? projectWhere(db, "id", id) : null;
}
