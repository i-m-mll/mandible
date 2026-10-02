import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import type http from "node:http";
import type { InstanceInfo } from "./types.js";
import { getUserHome } from "./platform-paths.js";

export function localApiSocketPath(instance: InstanceInfo, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MANDIBLE_SOCKET?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("MANDIBLE_SOCKET must be an absolute path.");
    if (instance.role === "preview" && path.basename(override) === "production.sock") {
      throw new Error("Preview cannot use the production local socket.");
    }
    return override;
  }
  const directory = path.join(env.HOME || getUserHome(), ".cache", "mandible", "local-api");
  const name = instance.role === "main" ? "production"
    : `preview-${createHash("sha256").update(instance.instance_id).digest("hex").slice(0, 16)}`;
  return path.join(directory, `${name}.sock`);
}

function requirePrivateDirectory(directory: string, leaf = true): void {
  const parent = path.dirname(directory);
  if (parent !== directory) requirePrivateDirectory(parent, false);
  let created = false;
  try { fs.lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
    created = true;
  }
  const stat = fs.lstatSync(directory);
  if (stat.uid !== 0 && stat.uid !== process.getuid?.()) {
    throw new Error(`Foreign-owned local socket ancestor: ${directory}`);
  }
  if (stat.isSymbolicLink() && stat.uid === 0 && fs.statSync(directory).isDirectory()) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || ((created || leaf) && stat.uid !== process.getuid?.())) {
    throw new Error(`Unsafe local socket directory: ${directory}`);
  }
  if (!leaf && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
    throw new Error(`Writable local socket ancestor: ${directory}`);
  }
  if (leaf && (stat.mode & 0o077) !== 0) throw new Error(`Local socket directory is not private: ${directory}`);
}

async function assertSocketAvailable(socketPath: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
    throw new Error(`Unsafe existing local socket path: ${socketPath}`);
  }
  const active = await new Promise<boolean>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.setTimeout(1000);
    client.once("connect", () => { client.destroy(); resolve(true); });
    client.once("timeout", () => { client.destroy(); reject(new Error(`Cannot classify local socket: ${socketPath}`)); });
    client.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error(`Local socket already active: ${socketPath}`);
  const current = fs.lstatSync(socketPath);
  if (!current.isSocket() || current.ino !== stat.ino || current.dev !== stat.dev) {
    throw new Error(`Local socket changed while checking: ${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}

export async function startLocalApiSocket(server: http.Server, socketPath: string): Promise<() => Promise<void>> {
  if (!path.isAbsolute(socketPath)) throw new Error("Local socket path must be absolute.");
  requirePrivateDirectory(path.dirname(socketPath));
  await assertSocketAvailable(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Local listener path changed during bind.");
    fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  server.on("error", (error) => {
    process.stderr.write(`Local API socket error: ${String(error)}\n`);
    process.exit(1);
  });
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const current = fs.lstatSync(socketPath);
      if (current.isSocket() && current.ino === stat.ino && current.dev === stat.dev) fs.unlinkSync(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
