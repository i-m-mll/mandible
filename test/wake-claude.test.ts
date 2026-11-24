import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wakeClaude } from "../src/notices/wake/claude.js";
import type { RegisteredRoute, WakeEnvironment, WakeTarget } from "../src/notices/wake/types.js";
import { waitUntil } from "./helpers/wait-until.js";

const TOKEN = "tok-6f1d0c2e-secret";
const TEXT = "Mandible holds a message for you.";

interface Spawned { command: string; args: readonly string[]; env: Record<string, string> | undefined; pid: number | undefined }

function realEnvironment(spawned: Spawned[]): WakeEnvironment {
  return {
    home: "/nonexistent",
    alive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
    run: (command, args, options) => new Promise(resolve => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: options.timeout_ms, env: options.env });
      spawned.push({ command, args, env: options.env, pid: child.pid });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", error => resolve({ code: null, stdout, stderr: error.message }));
      child.once("close", code => resolve({ code, stdout, stderr }));
      child.stdin.end(options.stdin ?? "");
    }),
  };
}

function target(registered: RegisteredRoute | null): WakeTarget {
  return { provider: "claude", session_id: "c749d68d-d55b-49eb-97bb-e140b640152f", registered, text: TEXT };
}

/**
 * An inbox socket that, like Claude Code, reads to the end and then waits for
 * the poster to be gone. It never replies or closes, so a poster that waited
 * on it would time out.
 */
function fakeInbox(socket: string, spawned: Spawned[]) {
  const received: string[] = [];
  const held: net.Socket[] = [];
  const server = net.createServer({ allowHalfOpen: true }, connection => {
    held.push(connection);
    let text = "";
    connection.on("data", chunk => { text += chunk; });
    connection.on("end", async () => {
      const pid = spawned.at(-1)!.pid!;
      await waitUntil(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "the poster to exit");
      received.push(text);
    });
  });
  return {
    received,
    listen: () => new Promise<void>(resolve => server.listen(socket, resolve)),
    close: () => new Promise<void>(resolve => { held.forEach(connection => connection.destroy()); server.close(() => resolve()); }),
  };
}

describe("Claude wake executor", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync("/tmp/mwake-"); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("posts the auth line then the user line from a child that exits without waiting on the socket", async () => {
    const socket = path.join(dir, "inbox.sock");
    const spawned: Spawned[] = [];
    const inbox = fakeInbox(socket, spawned);
    await inbox.listen();
    try {
      const result = await wakeClaude(target({ provider: "claude", socket, token: TOKEN }), realEnvironment(spawned));
      expect(result).toEqual({ ok: true, value: undefined });
      const [post] = await waitUntil(() => inbox.received.length === 1 && inbox.received, "the inbox to read the post");
      expect(post.split("\n").filter(Boolean).map(line => JSON.parse(line))).toEqual([
        { type: "auth", token: TOKEN },
        { type: "user", message: { role: "user", content: TEXT } },
      ]);
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args.join(" ")).not.toContain(TOKEN);
      expect(JSON.stringify(spawned[0].env ?? {})).not.toContain(TOKEN);
    } finally {
      await inbox.close();
    }
  });

  it("maps a missing socket and a socket nobody listens on to route_refused", async () => {
    const stale = path.join(dir, "stale.sock");
    fs.writeFileSync(stale, "");
    for (const socket of [path.join(dir, "missing.sock"), stale]) {
      const result = await wakeClaude(target({ provider: "claude", socket, token: TOKEN }), realEnvironment([]));
      expect(result.ok ? null : result.error.code).toBe("route_refused");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it("reports no_route without starting a process when the session registered no Claude route", async () => {
    const spawned: Spawned[] = [];
    for (const registered of [null, { provider: "antigravity", address: "127.0.0.1:1", token: TOKEN } as const]) {
      expect(await wakeClaude(target(registered), realEnvironment(spawned))).toEqual({ ok: false, error: { code: "no_route" } });
    }
    expect(spawned).toEqual([]);
  });

  it("maps any other poster failure to entry_point_failed without the token in its detail", async () => {
    const route = { provider: "claude", socket: path.join(dir, "inbox.sock"), token: TOKEN } as const;
    for (const outcome of [{ code: 1, stdout: "", stderr: `EPIPE write failed after ${TOKEN}` }, { code: null, stdout: "", stderr: "" }]) {
      const environment: WakeEnvironment = { home: "/nonexistent", alive: () => false, run: async () => outcome };
      const result = await wakeClaude(target(route), environment);
      expect(result.ok ? null : result.error.code).toBe("entry_point_failed");
      expect(result.ok ? "" : "detail" in result.error ? result.error.detail : "").not.toBe("");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });
});
