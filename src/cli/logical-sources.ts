import path from "node:path";
import { getUserHome } from "../platform-paths.js";
import {
  canonicalSourcePath, discoverLogicalSources, inspectSourceRepresentation, readLogicalSourcePrefix,
} from "../conversations/logical-source.js";

/** Native-log CLI bridge. Prefix metadata is partial and carries no content proof. */
async function head(filename: string, count: number): Promise<unknown[]> {
  const bytes = await readLogicalSourcePrefix(filename, 16 * 1024 * 1024);
  const lines = bytes.toString("utf8").split(/\r?\n/).slice(0, count);
  const records: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { /* Native logs may end in an interrupted row or a bounded prefix. */ }
  }
  if (bytes.length === 16 * 1024 * 1024 && records.length < count) {
    console.error("Native source prefix reached its 16 MiB limit; additional records are omitted. Use parsed inspection to read complete records.");
  }
  return records;
}

async function summary(filename: string) {
  const physical = await inspectSourceRepresentation(filename);
  const records = await head(filename, 200) as Array<{ type?: string; payload?: Record<string, unknown> }>;
  const meta = records.find((record) => record.type === "session_meta")?.payload;
  const git = meta?.git as Record<string, unknown> | undefined;
  return {
    provider: "codex", path: canonicalSourcePath(filename), size: physical.size,
    mtime: new Date(physical.mtimeMs).toISOString(), session_id: meta?.id ?? null,
    title: null, cwd: meta?.cwd ?? null, model: meta?.model_provider ?? null, branch: git?.branch,
    metadata_partial: true,
  };
}

async function files() {
  const result: Awaited<ReturnType<typeof inspectSourceRepresentation>>[] = [];
  for (const name of ["sessions", "archived_sessions"]) {
    for await (const filename of discoverLogicalSources(path.join(getUserHome(), ".codex", name))) {
      result.push(await inspectSourceRepresentation(filename));
    }
  }
  return result;
}

const [operation, argument, count] = process.argv.slice(2);
let result: unknown;
if (operation === "head") result = await head(argument, Number(count ?? 200));
else if (operation === "summary") result = await summary(argument);
else if (operation === "list") result = (await files()).map((file) => file.path);
else if (operation === "missing") {
  const indexed = new Set(JSON.parse(argument) as string[]);
  result = [];
  for (const file of await files()) {
    if (!indexed.has(file.path)) (result as unknown[]).push(await summary(file.path));
  }
}
else if (operation === "inventory") {
  const cutoff = Number(argument || 0);
  const selected = (await files()).filter((file) => file.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Number(count ?? 50));
  result = await Promise.all(selected.map((file) => summary(file.path)));
} else if (operation === "find") {
  try {
    result = (await inspectSourceRepresentation(argument)).path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    result = null;
    for (const file of await files()) {
      if (argument === path.basename(file.path) || (await summary(file.path)).session_id === argument) {
        result = file.path;
        break;
      }
    }
  }
} else throw new Error("unknown logical source bridge operation");
console.log(JSON.stringify(result));
