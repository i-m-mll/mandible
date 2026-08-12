// Bug: 4f7e45e — the chokidar v4 watcher opened one fs.watch fd per matched
// conversation file (11,675 against the real corpus), exhausting the daemon's
// fd limit so every subsequent spawn failed with EMFILE. The watcher now uses
// one recursive watch per root directory; these tests pin the path
// classification that replaced chokidar's add/change/unlink events.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  groupWatchConfigs,
  makeWatchRootMatcher,
  resolveWatchEventPath,
  watchConversationRoots,
  type ConversationWatchHandle,
} from "../src/ingestion.js";

let tempDir = "";
let handle: ConversationWatchHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for watch event");
}

describe("groupWatchConfigs", () => {
  it("collapses configs that share a base into one root", () => {
    const roots = groupWatchConfigs([
      { base: "/home/.claude/projects", glob: "**/*.jsonl" },
      { base: "/home/.claude/projects", glob: "**/workflows/wf_*.json" },
      { base: "/home/.codex/sessions", glob: "**/*.jsonl" },
      { base: "/home/.codex/archived_sessions", glob: "**/*.jsonl" },
      { base: "/home/.gemini/tmp", glob: "**/chats/*.json" },
      { base: "/home/.gemini/tmp", glob: "**/chats/*.jsonl" },
    ]);

    expect(roots).toEqual([
      { base: "/home/.claude/projects", globs: ["**/*.jsonl", "**/workflows/wf_*.json"] },
      { base: "/home/.codex/sessions", globs: ["**/*.jsonl"] },
      { base: "/home/.codex/archived_sessions", globs: ["**/*.jsonl"] },
      { base: "/home/.gemini/tmp", globs: ["**/chats/*.json", "**/chats/*.jsonl"] },
    ]);
  });

  it("does not duplicate a glob repeated on the same base", () => {
    const roots = groupWatchConfigs([
      { base: "/home/.codex/sessions", glob: "**/*.jsonl" },
      { base: "/home/.codex/sessions", glob: "**/*.jsonl" },
    ]);
    expect(roots).toEqual([{ base: "/home/.codex/sessions", globs: ["**/*.jsonl"] }]);
  });
});

describe("resolveWatchEventPath", () => {
  const base = "/home/.codex/sessions";

  it("joins a base-relative posix name reported by recursive fs.watch", () => {
    expect(resolveWatchEventPath(base, "2026/07/02/rollout-a.jsonl"))
      .toBe(path.join(base, "2026", "07", "02", "rollout-a.jsonl"));
  });

  it("resolves a flat name at the watch root", () => {
    expect(resolveWatchEventPath("/home/.codex/archived_sessions", "rollout-a.jsonl"))
      .toBe(path.join("/home/.codex/archived_sessions", "rollout-a.jsonl"));
  });

  it("decodes a Buffer filename", () => {
    expect(resolveWatchEventPath(base, Buffer.from("a/b.jsonl", "utf8")))
      .toBe(path.join(base, "a", "b.jsonl"));
  });

  it("passes through an absolute filename", () => {
    expect(resolveWatchEventPath(base, "/elsewhere/c.jsonl")).toBe("/elsewhere/c.jsonl");
  });

  it("returns null when the platform omits the filename", () => {
    expect(resolveWatchEventPath(base, null)).toBeNull();
    expect(resolveWatchEventPath(base, undefined)).toBeNull();
    expect(resolveWatchEventPath(base, "")).toBeNull();
  });
});

describe("makeWatchRootMatcher", () => {
  const base = "/home/.claude/projects";
  const matches = makeWatchRootMatcher(base, ["**/*.jsonl", "**/workflows/wf_*.json"]);

  it("matches any glob configured for the root", () => {
    expect(matches(path.join(base, "proj", "a.jsonl"))).toBe(true);
    expect(matches(path.join(base, "proj", "workflows", "wf_1.json"))).toBe(true);
  });

  it("matches a file directly at a flat root (`**/` spans zero directories)", () => {
    const flat = "/home/.codex/archived_sessions";
    expect(makeWatchRootMatcher(flat, ["**/*.jsonl"])(path.join(flat, "rollout.jsonl"))).toBe(true);
  });

  it("rejects non-matching names, the root directory itself, and paths outside the root", () => {
    expect(matches(path.join(base, "proj", "notes.md"))).toBe(false);
    expect(matches(path.join(base, "proj", "workflows", "other.json"))).toBe(false);
    expect(matches(base)).toBe(false);
    expect(matches("/home/.claude/projects-other/a.jsonl")).toBe(false);
  });
});

describe("watchConversationRoots", () => {
  it("reports create, modify, and delete of matching files across nested and flat roots", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-watch-roots-"));
    const sessions = path.join(tempDir, ".codex", "sessions");
    const archived = path.join(tempDir, ".codex", "archived_sessions");
    fs.mkdirSync(path.join(sessions, "2026", "07", "02"), { recursive: true });
    fs.mkdirSync(archived, { recursive: true });

    const seen: string[] = [];
    handle = watchConversationRoots({
      configs: [
        { base: sessions, glob: "**/*.jsonl" },
        { base: archived, glob: "**/*.jsonl" },
      ],
      onFile: (filePath) => seen.push(filePath),
    });

    // Two bases, one recursive watch each — the fd budget is O(roots).
    expect(handle.rootCount).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // add, in a directory that existed when the watch started
    const nested = path.join(sessions, "2026", "07", "02", "rollout-a.jsonl");
    await fsp.writeFile(nested, "one\n", "utf8");
    await waitFor(() => seen.includes(nested));

    // change
    seen.length = 0;
    await fsp.appendFile(nested, "two\n", "utf8");
    await waitFor(() => seen.includes(nested));

    // add, in a directory created after the watch started
    seen.length = 0;
    const deep = path.join(sessions, "2026", "08", "12");
    await fsp.mkdir(deep, { recursive: true });
    const deepFile = path.join(deep, "rollout-b.jsonl");
    await fsp.writeFile(deepFile, "one\n", "utf8");
    await waitFor(() => seen.includes(deepFile));

    // add, directly at the flat archive root (`codex archive` destination)
    seen.length = 0;
    const archivedFile = path.join(archived, "rollout-a.jsonl");
    await fsp.rename(nested, archivedFile);
    await waitFor(() => seen.includes(archivedFile));
    // the source side of the move reports too, so ingestion can probe relocation
    expect(seen).toContain(nested);

    // unlink
    seen.length = 0;
    await fsp.rm(archivedFile);
    await waitFor(() => seen.includes(archivedFile));
  });

  it("ignores non-matching files and directory events", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-watch-roots-"));
    const sessions = path.join(tempDir, ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });

    const seen: string[] = [];
    handle = watchConversationRoots({
      configs: [{ base: sessions, glob: "**/*.jsonl" }],
      onFile: (filePath) => seen.push(filePath),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    await fsp.mkdir(path.join(sessions, "2026"), { recursive: true });
    await fsp.writeFile(path.join(sessions, "2026", "notes.md"), "x\n", "utf8");
    await fsp.writeFile(path.join(sessions, "2026", "index.json"), "{}\n", "utf8");

    const marker = path.join(sessions, "2026", "rollout-marker.jsonl");
    await fsp.writeFile(marker, "x\n", "utf8");
    await waitFor(() => seen.includes(marker));

    expect(seen.every((filePath) => filePath.endsWith(".jsonl"))).toBe(true);
  });

  it("skips missing bases and reports one root per surviving base", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-watch-roots-"));
    const present = path.join(tempDir, ".claude", "projects");
    fs.mkdirSync(present, { recursive: true });

    const skipped: string[] = [];
    handle = watchConversationRoots({
      configs: [
        { base: present, glob: "**/*.jsonl" },
        { base: present, glob: "**/workflows/wf_*.json" },
        { base: path.join(tempDir, ".gemini", "tmp"), glob: "**/chats/*.json" },
      ],
      onFile: () => undefined,
      log: (_level, message, details) => {
        if (message === "ingestion_skip_missing_dir") {
          skipped.push(String((details as { path?: string } | undefined)?.path));
        }
      },
    });

    expect(handle.rootCount).toBe(1);
    expect(skipped).toEqual([path.join(tempDir, ".gemini", "tmp")]);
  });
});
