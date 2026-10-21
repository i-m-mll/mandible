import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

// One stock library per process: Bun's public configuration also selects
// node:sqlite's library. No bun:sqlite connection is constructed.
export const SQLITE_RUNTIME_LOCK = {
  version: "3.53.4",
  sourceUrl: "https://www.sqlite.org/2026/sqlite-autoconf-3530400.tar.gz",
  sourceSha256: "0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c",
  sourceId: "bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc",
  platform: "darwin-arm64",
  archiveUrl: "https://ghcr.io/v2/homebrew/core/sqlite/blobs/sha256:804bef8ca4631bf2cf790c2b0564cee7ace649eb4052f2e16da3ac9142e77f51",
  archiveSha256: "804bef8ca4631bf2cf790c2b0564cee7ace649eb4052f2e16da3ac9142e77f51",
  libraryMember: "sqlite/3.53.4/lib/libsqlite3.3.53.4.dylib",
  librarySha256: "52b6c72ddd0ddaa0ecff9164689cad2a83680ee5ec001906ff1b5572b65e36cf",
  dependencies: ["/usr/lib/libz.1.dylib", "/usr/lib/libSystem.B.dylib"],
} as const;

function hash(filename: string) { return createHash("sha256").update(fs.readFileSync(filename)).digest("hex"); }

let accountStore: string | undefined;
/**
 * The verified runtime store, shared with scripts/bun-runtime.sh. It belongs to
 * the OS account, not to HOME or XDG_DATA_HOME, which tests and agents override
 * to isolate data; Bun's os.userInfo() reports HOME, so the account's home
 * comes from the user database.
 */
export function runtimeStoreRoot() {
  if (process.env.MANDIBLE_RUNTIME_STORE) return process.env.MANDIBLE_RUNTIME_STORE;
  if (!accountStore) {
    const result = spawnSync("/bin/sh", ["-c", 'eval "printf %s ~$(id -un)"'], { encoding: "utf8", timeout: 5_000 });
    if (result.status !== 0 || !path.isAbsolute(result.stdout)) throw new Error("Cannot resolve the OS account home for the runtime store; set MANDIBLE_RUNTIME_STORE.");
    accountStore = path.join(result.stdout, ".local", "share", "mandible", "runtimes");
  }
  return accountStore;
}
export function sqliteRuntimePaths() {
  const root = path.join(runtimeStoreRoot(), "sqlite", SQLITE_RUNTIME_LOCK.librarySha256);
  return { root, library: path.join(root, "libsqlite3.dylib"), archive: path.join(root, "sqlite.tar.gz") };
}
export function verifySqliteLibrary(filename: string) {
  if (!fs.existsSync(filename) || hash(filename) !== SQLITE_RUNTIME_LOCK.librarySha256) {
    throw new Error(`Pinned SQLite library is missing or corrupt: ${filename}. Provision the preserved SQLite archive before opening a database.`);
  }
  return filename;
}
export function verifySqliteArchive(filename: string) {
  if (!fs.existsSync(filename) || hash(filename) !== SQLITE_RUNTIME_LOCK.archiveSha256) throw new Error(`Pinned SQLite archive checksum mismatch: ${filename}`);
  return filename;
}
function publish(source: string, destination: string, verify: (filename: string) => string) {
  try { fs.linkSync(source, destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  verify(destination);
}
export function provisionSqliteLibrary(archive: string) {
  verifySqliteArchive(archive);
  const files = sqliteRuntimePaths();
  fs.mkdirSync(files.root, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(files.root, "install-"));
  try {
    const retained = path.join(scratch, "sqlite.tar.gz");
    fs.copyFileSync(archive, retained);
    verifySqliteArchive(retained);
    const result = spawnSync("/usr/bin/tar", ["-xzf", retained, "-C", scratch, SQLITE_RUNTIME_LOCK.libraryMember], { encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Cannot extract pinned SQLite library: ${result.stderr}`);
    const library = path.join(scratch, SQLITE_RUNTIME_LOCK.libraryMember);
    verifySqliteLibrary(library);
    publish(retained, files.archive, verifySqliteArchive);
    publish(library, files.library, verifySqliteLibrary);
    return files;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

const ownershipKey = Symbol.for("mandible.sqlite.library-owner");
const workerOwnershipKey = "mandible.sqlite.library-owner@1";
type LibraryOwner = { pid: number; sha256: string; sourceId: string; filename: string };
type NativeDriver = new (filename: string) => {
  prepare(sql: string): { get(): Record<string, unknown> | undefined };
  close(): void;
};

function verifyOwner(owner: LibraryOwner) {
  if (owner.pid !== process.pid || owner.sha256 !== SQLITE_RUNTIME_LOCK.librarySha256 || owner.sourceId !== SQLITE_RUNTIME_LOCK.sourceId) {
    throw new Error("Conflicting SQLite library identity in this process");
  }
  verifySqliteLibrary(owner.filename);
}

function verifyLoadedIdentity(Driver: NativeDriver) {
  const probe = new Driver(":memory:");
  try {
    const row = probe.prepare("SELECT sqlite_version() AS version, sqlite_source_id() AS source_id").get();
    if (row?.version !== SQLITE_RUNTIME_LOCK.version || typeof row.source_id !== "string" || row.source_id.split(" ").at(-1) !== SQLITE_RUNTIME_LOCK.sourceId) {
      throw new Error("Loaded SQLite library does not match the pinned native identity");
    }
  } finally { probe.close(); }
}
const processOwnership = globalThis as typeof globalThis & { [ownershipKey]?: LibraryOwner };
export function configureSqliteRuntime(Driver?: NativeDriver) {
  if (process.platform !== "darwin") return;
  if (`${process.platform}-${process.arch}` !== SQLITE_RUNTIME_LOCK.platform) throw new Error("No qualified stock SQLite library for this macOS architecture");
  const files = sqliteRuntimePaths();
  const override = process.env.MANDIBLE_SQLITE_LIBRARY;
  if (!override && process.env.MANDIBLE_SQLITE_LIBRARY_ARCHIVE) {
    verifySqliteArchive(process.env.MANDIBLE_SQLITE_LIBRARY_ARCHIVE);
    if (!fs.existsSync(files.library) || !fs.existsSync(files.archive)) provisionSqliteLibrary(process.env.MANDIBLE_SQLITE_LIBRARY_ARCHIVE);
  }
  const library = verifySqliteLibrary(override || files.library);
  const owner = processOwnership[ownershipKey];
  if (owner) {
    verifyOwner(owner);
    return;
  }
  // Environment data is inherited by Worker realms, not by child processes.
  // Its receipt alone is insufficient: verify the actual already selected
  // node:sqlite driver identity before sharing the process-wide selection.
  const inheritedOwner = getEnvironmentData(workerOwnershipKey) as LibraryOwner | undefined;
  if (inheritedOwner) {
    verifyOwner(inheritedOwner);
    if (!Driver) throw new Error("Worker SQLite initialization requires native identity verification");
    verifyLoadedIdentity(Driver);
    processOwnership[ownershipKey] = Object.freeze({ ...inheritedOwner });
    return;
  }
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as { Database: { setCustomSQLite(filename: string): boolean } };
  if (!Database.setCustomSQLite(library)) throw new Error("Pinned SQLite must be configured before the first database opens");
  if (Driver) verifyLoadedIdentity(Driver);
  const selectedOwner = Object.freeze({ pid: process.pid, sha256: SQLITE_RUNTIME_LOCK.librarySha256, sourceId: SQLITE_RUNTIME_LOCK.sourceId, filename: library });
  processOwnership[ownershipKey] = selectedOwner;
  setEnvironmentData(workerOwnershipKey, selectedOwner);
}
