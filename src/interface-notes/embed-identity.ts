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

export type EmbedIdentityFailure = "origin_not_loopback" | "origin_not_registered";
export type EmbedIdentityResult = { ok: true; value: EmbedIdentity } | { ok: false; error: EmbedIdentityFailure };

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

export class EmbedIdentityResolver {
  /** Resolved directories; a listener's working directory is read on every request, a resolved project only once. */
  private readonly byDirectory = new Map<string, EmbedIdentity>();

  constructor(private readonly db: Db, private readonly probe: EmbedProcessProbe = systemEmbedProbe) {}

  async resolve(origin: string): Promise<EmbedIdentityResult> {
    const port = loopbackOriginPort(origin);
    if (port === null) return { ok: false, error: "origin_not_loopback" };
    const pids = await this.probe.listeners(port);
    const directories = new Set((await Promise.all(pids.map((pid) => this.probe.cwd(pid)))).filter((dir): dir is string => dir !== null));
    // Listeners on one port with different directories (one on 127.0.0.1, another on ::1) leave the page's server unknown.
    if (directories.size !== 1) return { ok: false, error: "origin_not_registered" };
    const [directory] = directories as Set<string> & [string];
    const identity = this.byDirectory.get(directory) ?? await this.identityOf(directory);
    if (identity) this.byDirectory.set(directory, identity);
    return identity ? { ok: true, value: identity } : { ok: false, error: "origin_not_registered" };
  }

  private async identityOf(directory: string): Promise<EmbedIdentity | null> {
    const root = await this.probe.checkoutRoot(directory);
    if (!root) return null;
    const resolved = resolveProjectForCheckoutReadOnly(this.db, { root, remoteUrl: await this.probe.originRemote(root) });
    const projectId = resolved.status === "resolved" ? resolved.project.id : resolved.matchedProjectId;
    if (!projectId) return null;
    const project = this.db.prepare("SELECT id, project_key, display_name FROM ledger_projects WHERE id = ?")
      .get(projectId) as { id: string; project_key: string; display_name: string } | undefined;
    if (!project) return null;
    const within = path.relative(path.resolve(root), path.resolve(directory)).split(path.sep).join("/");
    return {
      app: within && !within.startsWith("..") ? `${project.project_key}:${within}` : project.project_key,
      project: { id: project.id, key: project.project_key, name: project.display_name },
    };
  }
}
