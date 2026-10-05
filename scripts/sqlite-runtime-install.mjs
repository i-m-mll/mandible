#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = fs.existsSync(path.join(root, "src/sqlite-runtime.ts")) ? path.join(root, "src/sqlite-runtime.ts") : path.join(root, "dist/sqlite-runtime.js");
const { SQLITE_RUNTIME_LOCK: lock, sqliteRuntimePaths, verifySqliteLibrary, verifySqliteArchive, provisionSqliteLibrary } = await import(pathToFileURL(modulePath).href);
if (process.platform !== "darwin") process.exit(0);
if (`${process.platform}-${process.arch}` !== lock.platform) throw new Error("No qualified stock SQLite library for this macOS architecture");
const files = sqliteRuntimePaths();
const mode = process.argv[2] || "library";
if (!["library", "--archive"].includes(mode)) throw new Error("Usage: sqlite-runtime-install.mjs [--archive]");
if (fs.existsSync(files.library)) verifySqliteLibrary(files.library);
if (fs.existsSync(files.archive)) verifySqliteArchive(files.archive);
const suppliedArchive = process.env.MANDIBLE_SQLITE_LIBRARY_ARCHIVE || (fs.existsSync(path.join(root, "runtime/sqlite.tar.gz")) ? path.join(root, "runtime/sqlite.tar.gz") : undefined);
if (suppliedArchive) {
  verifySqliteArchive(suppliedArchive);
  if (!fs.existsSync(files.library) || !fs.existsSync(files.archive)) provisionSqliteLibrary(suppliedArchive);
} else if (!fs.existsSync(files.library) || !fs.existsSync(files.archive)) {
  fs.mkdirSync(files.root, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(files.root, "download-"));
  try {
    const tokenResponse = await fetch("https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/sqlite:pull", { signal: AbortSignal.timeout(30_000) });
    if (!tokenResponse.ok) throw new Error(`SQLite registry access failed: ${tokenResponse.status}`);
    const { token } = await tokenResponse.json();
    const response = await fetch(lock.archiveUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Pinned SQLite download failed: ${response.status}. Supply MANDIBLE_SQLITE_LIBRARY_ARCHIVE from the offline kit.`);
    const archive = path.join(scratch, "sqlite.tar.gz");
    fs.writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
    provisionSqliteLibrary(archive);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
process.stdout.write(`${mode === "--archive" ? verifySqliteArchive(files.archive) : verifySqliteLibrary(files.library)}\n`);
