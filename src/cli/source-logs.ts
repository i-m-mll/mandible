import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readLogicalSourcePrefix, inspectSourceRepresentation } from "../conversations/logical-source.js";
import { parseBound } from "../conversation-block-filters.js";
import SqliteDatabase from "../sqlite.js";
import { getUserHome } from "../platform-paths.js";
import { files as codexFiles, head as codexHead, summary as codexSummary } from "./logical-sources.js";
import { parseCommand, stringOption, numberOption, flagOption } from "./grammar.js";

type Summary = { provider: string; path: string; size: number; mtime: string; session_id: unknown; title: unknown; cwd: unknown; model: unknown };
const parsed = parseCommand(["logs"], process.argv.slice(2));
const provider = stringOption(parsed, "provider") ?? "all";
const json = flagOption(parsed, "json");
const operation = parsed.command.split(".").at(-1);
const limit = numberOption(parsed, "limit") ?? 50;
const home = getUserHome();
const isCodex = (filename: string) => /\/\.codex\/(sessions|archived_sessions)\//.test(filename);
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function walk(directory: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  return entries.flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : entry.isFile() ? [path.join(directory, entry.name)] : []);
}
async function files(): Promise<Array<[string, string]>> {
  const rows: Array<[string, string]> = [];
  if (provider === "all" || provider === "codex") rows.push(...(await codexFiles()).map(file => ["codex", file.path] as [string, string]));
  if (provider === "all" || provider === "claude") rows.push(...walk(path.join(home, ".claude/projects")).filter(name => name.endsWith(".jsonl")).map(name => ["claude", name] as [string, string]));
  if (provider === "all" || provider === "gemini") rows.push(...walk(path.join(home, ".gemini/tmp")).filter(name => name.includes("/chats/") && /\.jsonl?$/.test(name)).map(name => ["gemini", name] as [string, string]));
  return rows;
}
async function records(filename: string, count: number): Promise<Array<Record<string, unknown>>> {
  if (isCodex(filename)) return await codexHead(filename, count) as Array<Record<string, unknown>>;
  return (await readLogicalSourcePrefix(filename, 16 * 1024 * 1024)).toString("utf8").split(/\r?\n/).slice(0, count).flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; }
    catch { return []; }
  });
}
async function summary(source: string, filename: string): Promise<Summary> {
  if (source === "codex" || isCodex(filename)) return codexSummary(filename);
  const stat = fs.statSync(filename);
  const result: Summary = { provider: source, path: filename, size: stat.size, mtime: stat.mtime.toISOString(), session_id: null, title: null, cwd: null, model: null };
  for (const row of await records(filename, 200)) {
    if (source === "claude") {
      result.session_id = row.sessionId || row.session_id || result.session_id;
      result.cwd = row.cwd || result.cwd;
      result.model = row.model || result.model;
    } else if (source === "gemini") result.session_id = row.id || row.session_id || result.session_id;
  }
  return result;
}
function indexed(): Array<Record<string, any>> {
  const filename = process.env.MANDIBLE_DB!;
  if (!fs.existsSync(filename)) return [];
  const db = new SqliteDatabase(filename, { readonly: true, timeout: 5000 });
  try {
    db.pragma("query_only = ON");
    const source = provider === "claude" ? "claude_code" : provider;
    return db.prepare(`SELECT id, source, source_path, source_hash, source_mtime, session_id, title, block_count, updated_at FROM conversations WHERE source_path IS NOT NULL AND source_path != ''${source === "all" ? "" : " AND source = ?"}`).all(...(source === "all" ? [] : [source])) as Array<Record<string, any>>;
  } finally { db.close(); }
}
function blocks(args: string[]): number {
  const extension = path.extname(fileURLToPath(import.meta.url));
  const child = spawnSync(process.execPath, ["--no-install", fileURLToPath(new URL(`./conversation-blocks${extension}`, import.meta.url)), ...args], { stdio: "inherit", env: process.env, timeout: 60_000 });
  if (child.error) throw child.error;
  return child.status ?? 1;
}
function printRows(rows: Summary[], missing = false) {
  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  const selected = missing ? rows : rows.slice(0, limit);
  if (json) console.log(JSON.stringify(selected, null, 2));
  else for (const row of selected) console.log([row.provider, row.mtime.slice(0, 19), ...(!missing ? [row.title || row.session_id || "-"] : []), row.path].join("\t"));
}
async function main(): Promise<number> {
  if (operation === "capabilities") return blocks(["capabilities", provider, ...(json ? ["--json"] : [])]);
  if (operation === "inspect") {
    const target = parsed.positionals[0];
    const expanded = target.startsWith("~/") ? path.join(home, target.slice(2)) : target;
    let found: [string, string] | undefined = fs.existsSync(expanded) ? ["unknown", path.resolve(expanded)] : undefined;
    if (!found) for (const [source, filename] of await files()) {
      if (target === path.basename(filename) || target === (await summary(source, filename)).session_id) { found = [source, filename]; break; }
    }
    if (!found) { console.error(`log not found: ${target}`); return 1; }
    const [source, filename] = found;
    if (flagOption(parsed, "parse")) {
      const args = ["logs", filename, "--limit", String(limit)];
      for (const key of ["role", "type", "tool", "tool-kind", "since", "until", "content"]) {
        const value = stringOption(parsed, key, ...(key === "content" ? ["contains"] : []));
        if (value) args.push(`--${key}`, value);
      }
      return blocks([...args, ...(json ? ["--json"] : [])]);
    }
    const item = await summary(source, filename);
    const head = await records(filename, numberOption(parsed, "head") ?? 20);
    if (json) console.log(JSON.stringify({ summary: item, records: head }, null, 2));
    else {
      console.log(`${item.provider} ${item.session_id || path.basename(filename)}\npath: ${filename}\nmtime: ${item.mtime}\nrecords shown: ${head.length}`);
      for (const row of head) console.log(JSON.stringify(row).slice(0, 500));
    }
    return 0;
  }
  const catalog = await files();
  if (operation === "orphans") {
    const present = new Set(catalog.map(([, filename]) => filename));
    const rows = indexed().filter(row => !present.has(row.source_path) && !fs.existsSync(row.source_path)).sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.source}\t${row.id.slice(0, 8)}\t${row.session_id || "-"}\t${row.source_path}`);
    return 0;
  }
  let selected = catalog;
  if (operation === "missing") {
    const present = new Set(indexed().map(row => row.source_path));
    selected = catalog.filter(([, filename]) => !present.has(filename));
  } else if (operation === "inventory") {
    const since = stringOption(parsed, "since");
    const bound = parseBound(since);
    const cutoff = bound ? Date.parse(bound) : 0;
    const metadata = await Promise.all(selected.map(async ([source, filename]) => ({ source, filename, ...(await inspectSourceRepresentation(filename)) })));
    const recent = metadata.filter(row => row.mtimeMs >= cutoff).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
    printRows(await Promise.all(recent.map(row => summary(row.source, row.filename))));
    return 0;
  } else throw new Error(`Unsupported native log command: ${operation}`);
  printRows(await Promise.all(selected.map(([source, filename]) => summary(source, filename))), true);
  return 0;
}
process.exitCode = await main();
