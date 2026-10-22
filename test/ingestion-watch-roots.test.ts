// Bug: 4f7e45e — the chokidar v4 watcher opened one fs.watch fd per matched
// conversation file (11,675 against the real corpus), exhausting the daemon's
// fd limit so every subsequent spawn failed with EMFILE. The watcher now uses
// one recursive watch per root directory; these tests pin the path
// classification that replaced chokidar's add/change/unlink events.

import { waitUntil } from "./helpers/wait-until.js";
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
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
  type PerFileWatchFactory,
  type RecursiveWatchFactory,
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

const waitFor = (predicate: () => boolean) => waitUntil(predicate, "watch event", 25);

it("groups watch configs per root and maps event names to exactly the files a root owns", () => {
  expect(groupWatchConfigs([
    { base: "/home/.claude/projects", glob: "**/*.jsonl" },
    { base: "/home/.claude/projects", glob: "**/workflows/wf_*.json" },
    { base: "/home/.claude/projects", glob: "**/*.jsonl" },
    { base: "/home/.codex/archived_sessions", glob: "**/*.jsonl" },
  ])).toEqual([
    { base: "/home/.claude/projects", globs: ["**/*.jsonl", "**/workflows/wf_*.json"] },
    { base: "/home/.codex/archived_sessions", globs: ["**/*.jsonl"] },
  ]);

  const base = "/home/.codex/sessions";
  const resolved: Array<[unknown, string | null]> = [
    ["2026/07/02/rollout-a.jsonl", path.join(base, "2026", "07", "02", "rollout-a.jsonl")],
    ["rollout-a.jsonl", path.join(base, "rollout-a.jsonl")],
    [Buffer.from("a/b.jsonl", "utf8"), path.join(base, "a", "b.jsonl")],
    ["/elsewhere/c.jsonl", "/elsewhere/c.jsonl"],
    [null, null], [undefined, null], ["", null],
  ];
  for (const [filename, expected] of resolved) expect(resolveWatchEventPath(base, filename), String(filename)).toBe(expected);

  const claude = "/home/.claude/projects";
  const matches = makeWatchRootMatcher(claude, ["**/*.jsonl", "**/workflows/wf_*.json"]);
  const owned: Array<[string, boolean]> = [
    [path.join(claude, "proj", "a.jsonl"), true],
    [path.join(claude, "a.jsonl"), true],
    [path.join(claude, "proj", "workflows", "wf_1.json"), true],
    [path.join(claude, "proj", "notes.md"), false],
    [path.join(claude, "proj", "workflows", "other.json"), false],
    [claude, false],
    ["/home/.claude/projects-other/a.jsonl", false],
  ];
  for (const [file, expected] of owned) expect(matches(file), file).toBe(expected);
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
    // A watch reports nothing until it is armed; probe each root until it reports.
    for (const base of [sessions, archived]) {
      const probe = path.join(base, "armed.jsonl");
      await waitUntil(() => {
        fs.writeFileSync(probe, "probe\n");
        return seen.includes(probe);
      }, `the watch on ${base} to report a write`, 25);
    }

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

// --- Bug: 4f7e45e finding 6 -------------------------------------------------
// The first fix fell straight back to per-file chokidar whenever the recursive
// watch failed synchronously — on darwin too, which is exactly the descriptor
// explosion the fix exists to prevent — and a live watcher that emitted `error`
// was only logged, leaving that root permanently unwatched until the hourly
// reconcile. These tests pin the platform fallback policy and the runtime
// restart/degrade behavior.
//
// Measured on darwin with a 2,000-file corpus and a watch factory that always
// throws (the simulated FSEvents failure): the darwin path grew the process fd
// count by 0 (40 -> 40), while the per-file fallback grew it by exactly one fd
// per file (40 -> 2,040). That per-file slope is the 11,675-fd explosion at
// real corpus size, which is why darwin must never reach it.

class FakeFsWatcher extends EventEmitter {
  closeCount = 0;
  close(): void {
    this.closeCount += 1;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

function asFsWatcher(watcher: FakeFsWatcher): fs.FSWatcher {
  return watcher as unknown as fs.FSWatcher;
}

function makeRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-watch-policy-"));
  const base = path.join(tempDir, ".codex", "sessions");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** A per-file factory that records every construction and never opens fds. */
function recordingPerFileFactory(calls: Array<{ base: string; glob: string }>): PerFileWatchFactory {
  return (base, glob, handlers) => {
    calls.push({ base, glob });
    return {
      close: async () => {
        void handlers;
      },
    };
  };
}

describe("watchConversationRoots darwin fallback policy", () => {
  it("degrades a failed root to bounded polling instead of per-file watching", async () => {
    const base = makeRoot();
    const perFileCalls: Array<{ base: string; glob: string }> = [];
    const degraded: Array<{ base: string; reason: string }> = [];
    const refusals: unknown[] = [];

    handle = watchConversationRoots({
      configs: [{ base, glob: "**/*.jsonl" }, { base, glob: "**/*.json" }],
      onFile: () => undefined,
      onDegraded: (degradedBase, reason) => degraded.push({ base: degradedBase, reason }),
      platform: "darwin",
      watchFactory: () => {
        throw Object.assign(new Error("ENOTSUP: recursive watch unsupported"), { code: "ENOTSUP" });
      },
      perFileWatchFactory: recordingPerFileFactory(perFileCalls),
      degradedPollIntervalMs: 25,
      log: (_level, message, details) => {
        if (message === "ingestion_watcher_per_file_fallback_refused") refusals.push(details);
      },
    });

    // The per-file watcher — the descriptor explosion — is never constructed.
    expect(perFileCalls).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(handle.rootCount).toBe(0);
    expect(handle.degradedRootCount).toBe(1);
    expect(handle.rootModes.get(base)).toBe("degraded-poll");
    expect(degraded[0]).toEqual({ base, reason: "recursive_unavailable" });

    // Polling keeps asking for reconciles at a bounded cadence.
    await waitFor(() => degraded.filter((entry) => entry.reason === "degraded_poll").length >= 2);
    expect(perFileCalls).toEqual([]);
  });

  it("never constructs a per-file watcher after a runtime error exhausts retries", async () => {
    const base = makeRoot();
    const perFileCalls: Array<{ base: string; glob: string }> = [];
    const degraded: string[] = [];
    const live = new FakeFsWatcher();
    let attempts = 0;

    const watchFactory: RecursiveWatchFactory = () => {
      attempts += 1;
      if (attempts === 1) return asFsWatcher(live);
      throw new Error("FSEvents init failed");
    };

    handle = watchConversationRoots({
      configs: [{ base, glob: "**/*.jsonl" }],
      onFile: () => undefined,
      onDegraded: (_base, reason) => degraded.push(reason),
      platform: "darwin",
      watchFactory,
      perFileWatchFactory: recordingPerFileFactory(perFileCalls),
      retryDelaysMs: [5, 5],
      degradedPollIntervalMs: 10_000,
    });

    expect(handle.rootModes.get(base)).toBe("recursive");
    live.emit("error", new Error("watcher died"));

    // The errored watcher is closed (Node documents it as unusable) and the
    // lost-event window is reported so the caller reconciles.
    expect(live.closeCount).toBe(1);
    expect(degraded[0]).toBe("watcher_error");
    // ...and the root stops claiming a live recursive watcher the moment it
    // loses one, rather than at the end of the ladder.
    expect(handle.rootModes.get(base)).toBe("reattaching");

    await waitFor(() => handle?.rootModes.get(base) === "degraded-poll");
    expect(attempts).toBe(3); // initial attach + two bounded retries
    expect(degraded).toContain("retries_exhausted");
    expect(perFileCalls).toEqual([]);
    expect(handle.rootCount).toBe(0);
    expect(handle.degradedRootCount).toBe(1);
  });

  // Bug: 4f7e45e (re-review nit) — a runtime error closes the watcher, but the
  // root used to keep reporting mode "recursive" for the whole retry interval,
  // so `rootCount` counted a live watcher that no longer existed exactly while
  // events were being lost. Status must describe the gap, not the last good
  // state.
  it("reports a root with a closed watcher as reattaching, never as a live root", async () => {
    const base = makeRoot();
    const live = new FakeFsWatcher();
    let attempts = 0;

    handle = watchConversationRoots({
      configs: [{ base, glob: "**/*.jsonl" }],
      onFile: () => undefined,
      platform: "darwin",
      watchFactory: () => {
        attempts += 1;
        return asFsWatcher(live);
      },
      perFileWatchFactory: () => {
        throw new Error("per-file fallback must not be reachable on darwin");
      },
      // Long enough that the assertions below run inside the retry gap.
      retryDelaysMs: [60_000],
      degradedPollIntervalMs: 60_000,
    });

    expect(handle.rootCount).toBe(1);
    expect(handle.degradedRootCount).toBe(0);

    live.emit("error", new Error("watcher died"));

    // No watcher exists, and no retry has run yet.
    expect(attempts).toBe(1);
    expect(handle.rootModes.get(base)).toBe("reattaching");
    expect(handle.rootCount).toBe(0);
    expect(handle.degradedRootCount).toBe(1);
    // The counts still partition the watched roots.
    expect(handle.rootCount + handle.degradedRootCount).toBe(handle.rootModes.size);
  });

  it("re-establishes a recursive watcher after a runtime error and resumes events", async () => {
    const base = makeRoot();
    const seen: string[] = [];
    const first = new FakeFsWatcher();
    const listeners: Array<(eventType: string, filename: string | Buffer | null) => void> = [];
    const watchers = [first, new FakeFsWatcher()];

    handle = watchConversationRoots({
      configs: [{ base, glob: "**/*.jsonl" }],
      onFile: (filePath) => seen.push(filePath),
      platform: "darwin",
      watchFactory: (_base, listener) => {
        listeners.push(listener);
        return asFsWatcher(watchers[listeners.length - 1]);
      },
      perFileWatchFactory: () => {
        throw new Error("per-file fallback must not be reachable on darwin");
      },
      retryDelaysMs: [5],
      degradedPollIntervalMs: 10_000,
    });

    first.emit("error", new Error("watcher died"));
    expect(handle.rootModes.get(base)).toBe("reattaching");
    await waitFor(() => listeners.length === 2);
    expect(handle.rootModes.get(base)).toBe("recursive");
    expect(handle.rootCount).toBe(1);
    expect(handle.degradedRootCount).toBe(0);

    listeners[1]("change", "2026/08/12/rollout.jsonl");
    expect(seen).toEqual([path.join(base, "2026", "08", "12", "rollout.jsonl")]);
  });

  it("self-heals a degraded root when recursive watching becomes available again", async () => {
    const base = makeRoot();
    const recovered: unknown[] = [];
    let attempts = 0;

    handle = watchConversationRoots({
      configs: [{ base, glob: "**/*.jsonl" }],
      onFile: () => undefined,
      platform: "darwin",
      watchFactory: (_base, listener) => {
        attempts += 1;
        if (attempts < 3) throw new Error("FSEvents unavailable");
        void listener;
        return asFsWatcher(new FakeFsWatcher());
      },
      perFileWatchFactory: () => {
        throw new Error("per-file fallback must not be reachable on darwin");
      },
      degradedPollIntervalMs: 20,
      log: (_level, message, details) => {
        if (message === "ingestion_watcher_recovered") recovered.push(details);
      },
    });

    expect(handle.rootModes.get(base)).toBe("degraded-poll");
    await waitFor(() => handle?.rootModes.get(base) === "recursive");
    expect(recovered).toHaveLength(1);
    expect(handle.degradedRootCount).toBe(0);
  });
});

describe("watchConversationRoots non-darwin fallback", () => {
  it("keeps the per-file fallback when recursive watching is unavailable", async () => {
    const base = makeRoot();
    const perFileCalls: Array<{ base: string; glob: string }> = [];

    handle = watchConversationRoots({
      configs: [{ base, glob: "**/*.jsonl" }, { base, glob: "**/workflows/wf_*.json" }],
      onFile: () => undefined,
      platform: "linux",
      watchFactory: () => {
        throw new Error("recursive watch unsupported");
      },
      perFileWatchFactory: recordingPerFileFactory(perFileCalls),
      degradedPollIntervalMs: 10_000,
    });

    expect(perFileCalls).toEqual([
      { base, glob: "**/*.jsonl" },
      { base, glob: "**/workflows/wf_*.json" },
    ]);
    expect(handle.rootModes.get(base)).toBe("per-file");
    expect(handle.rootCount).toBe(1);
    expect(handle.degradedRootCount).toBe(0);
  });

  it("degrades to polling when the per-file fallback itself cannot start", async () => {
    const base = makeRoot();
    const degraded: string[] = [];

    handle = watchConversationRoots({
      configs: [{ base, glob: "**/*.jsonl" }],
      onFile: () => undefined,
      onDegraded: (_base, reason) => degraded.push(reason),
      platform: "linux",
      watchFactory: () => {
        throw new Error("recursive watch unsupported");
      },
      perFileWatchFactory: () => {
        throw new Error("chokidar unavailable");
      },
      degradedPollIntervalMs: 10_000,
    });

    expect(handle.rootModes.get(base)).toBe("degraded-poll");
    expect(degraded).toEqual(["recursive_unavailable"]);
  });
});
