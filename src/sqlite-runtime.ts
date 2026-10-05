import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

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
export function sqliteRuntimePaths() {
  const root = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "mandible", "sqlite", SQLITE_RUNTIME_LOCK.librarySha256);
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
type LibraryOwner = { sha256: string; sourceId: string; filename: string };
const processOwnership = globalThis as typeof globalThis & { [ownershipKey]?: LibraryOwner };
export function configureSqliteRuntime() {
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
    if (owner.sha256 !== SQLITE_RUNTIME_LOCK.librarySha256 || owner.sourceId !== SQLITE_RUNTIME_LOCK.sourceId) {
      throw new Error("Conflicting SQLite library identity in this process");
    }
    verifySqliteLibrary(owner.filename);
    return;
  }
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as { Database: { setCustomSQLite(filename: string): boolean } };
  if (!Database.setCustomSQLite(library)) throw new Error("Pinned SQLite must be configured before the first database opens");
  processOwnership[ownershipKey] = Object.freeze({ sha256: SQLITE_RUNTIME_LOCK.librarySha256, sourceId: SQLITE_RUNTIME_LOCK.sourceId, filename: library });
}
