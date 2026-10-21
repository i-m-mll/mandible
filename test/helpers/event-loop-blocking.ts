import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

/** The longest single stretch for which `run` kept the event loop from turning. */
export async function longestEventLoopBlockMs(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 2);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Math.max(longest, performance.now() - last);
  } finally {
    clearInterval(ticker);
  }
}

/**
 * Put a `git` first on PATH that waits `delaySeconds` before running the real
 * one, as Git does on a loaded host. A synchronous child then blocks the event
 * loop for at least that long, so blocking is unmistakable.
 */
export function useSlowGit(delaySeconds: number): { dir: string } {
  const real = (process.env.PATH ?? "").split(path.delimiter)
    .map((dir) => path.join(dir, "git"))
    .find((candidate) => fs.existsSync(candidate));
  if (!real) throw new Error("git is not on PATH");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-slow-git-"));
  fs.writeFileSync(path.join(dir, "git"), `#!/bin/sh\nsleep ${delaySeconds}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
  return { dir };
}
