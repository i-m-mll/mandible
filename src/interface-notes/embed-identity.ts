import { execFile } from "node:child_process";
import path from "node:path";
import type { Db } from "../db.js";
import { resolveProjectForCheckoutReadOnly } from "../ledger/projects.js";
import type { EmbedIdentity } from "./contract.js";

/**
 * Which app a loopback dev origin serves. The daemon finds the process listening
 * on the origin's port, takes its working directory, and resolves that directory's
 * checkout to a registered project without registering anything: a registered
 * checkout root, or any checkout (a worktree, a clone) whose origin remote is a
 * registered project's identity.
 */

/** What the resolution reads from the machine; tests substitute it. */
export interface EmbedProcessProbe {
  /** Pids listening on the TCP port, on any address. */
  listeners(port: number): Promise<number[]>;
  cwd(pid: number): Promise<string | null>;
  /** The checkout root containing the directory, or null outside a checkout. */
  checkoutRoot(directory: string): Promise<string | null>;
  originRemote(root: string): Promise<string>;
}

const PROBE_TIMEOUT_MS = 3_000;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function lsofField(output: string | null, field: string): string[] {
  return (output ?? "").split("\n").filter((line) => line.startsWith(field)).map((line) => line.slice(1));
}

export const systemEmbedProbe: EmbedProcessProbe = {
  async listeners(port) {
    const output = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
    return [...new Set(lsofField(output, "p").map(Number).filter(Number.isInteger))];
  },
  async cwd(pid) {
    return lsofField(await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]), "n")[0] ?? null;
  },
  async checkoutRoot(directory) {
    return (await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]))?.trim() || null;
  },
  async originRemote(root) {
    return (await run("git", ["-C", root, "remote", "get-url", "origin"]))?.trim() ?? "";
  },
};

const LOOPBACK_HOSTNAME = /^(?:localhost|(?:[a-z0-9-]+\.)+localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The port of an http(s) origin on a loopback host, or null for any other value. */
export function loopbackOriginPort(origin: string): number | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin || !LOOPBACK_HOSTNAME.test(url.hostname)) return null;
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** A resolved page: its identity and the directory its listener runs in. */
export type ResolvedEmbedPage = EmbedIdentity & { directory: string };

export type EmbedIdentityFailure = "origin_not_loopback" | "origin_not_registered";
export type EmbedIdentityResult = { ok: true; value: ResolvedEmbedPage } | { ok: false; error: EmbedIdentityFailure };

/**
 * Names the app a loopback origin serves. The name is a label, not authentication:
 * a process chooses its working directory, and this assumes every loopback listener
 * belongs to the owner. Whether a page may use the name is the operator's grant
 * (`EmbedGrants`).
 */
export async function resolveEmbedPage(db: Db, probe: EmbedProcessProbe, origin: string): Promise<EmbedIdentityResult> {
  const port = loopbackOriginPort(origin);
  if (port === null) return { ok: false, error: "origin_not_loopback" };
  const pids = await probe.listeners(port);
  const directories = await Promise.all(pids.map((pid) => probe.cwd(pid)));
  // An unreadable directory, or listeners in different directories (one on 127.0.0.1, another on ::1), leave the page's server unknown.
  const distinct = new Set(directories);
  if (pids.length === 0 || directories.includes(null) || distinct.size !== 1) return { ok: false, error: "origin_not_registered" };
  const directory = directories[0]!;
  const root = await probe.checkoutRoot(directory);
  if (!root) return { ok: false, error: "origin_not_registered" };
  const resolved = resolveProjectForCheckoutReadOnly(db, { root, remoteUrl: await probe.originRemote(root) });
  const projectId = resolved.status === "resolved" ? resolved.project.id : resolved.matchedProjectId;
  const project = projectId ? db.prepare("SELECT id, project_key, display_name FROM ledger_projects WHERE id = ?")
    .get(projectId) as { id: string; project_key: string; display_name: string } | undefined : undefined;
  if (!project) return { ok: false, error: "origin_not_registered" };
  const within = path.relative(path.resolve(root), path.resolve(directory)).split(path.sep).join("/");
  if (within.startsWith("..")) return { ok: false, error: "origin_not_registered" };
  return {
    ok: true,
    value: {
      app: `${project.project_key}:${within || "."}`,
      project: { id: project.id, key: project.project_key, name: project.display_name },
      directory,
    },
  };
}
