import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { openDb } from "../src/db.js";

const CLI = path.join(process.cwd(), "bin", "mandible");
const tempRoots: string[] = [];

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { cwd: os.tmpdir(), env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

describe("conversations list CLI", () => {
  // Issue 6f6b0ce: the local transport lists from the SQLite index through
  // embedded Python, a path the file-RPC tests never reach.
  it("lists from a migrated local index with provider, tag, and limit filters", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-list-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "mandible.db");
    const db = openDb(dbPath);
    const insert = db.prepare(`
      INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, session_id, tags)
      VALUES (?, ?, ?, 'hash', 0, ?, ?, ?, ?)
    `);
    insert.run("conv-old", "codex", "/logs/old.jsonl", "Older", "2026-06-11T00:00:00.000Z", "session-old", '["keep"]');
    insert.run("conv-new", "codex", "/logs/new.jsonl", "Newer", "2026-06-12T00:00:00.000Z", "session-new", '["keep"]');
    insert.run("conv-claude", "claude_code", "/logs/claude.jsonl", "Claude", "2026-06-13T00:00:00.000Z", "session-claude", "[]");
    db.close();

    const result = await run(
      ["conversations", "list", "--provider", "codex", "--tag", "keep", "--limit", "1", "--json"],
      { MANDIBLE_DB: dbPath },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ id: "conv-new", source: "codex", session_id: "session-new", tags: ["keep"] }),
    ]);
  });
});
