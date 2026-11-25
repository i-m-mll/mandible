import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CODEX_APP_CLI, wakeCodex } from "../src/notices/wake/codex.js";
import type { WakeEnvironment, WakeFailureCode, WakeTarget } from "../src/notices/wake/types.js";

const THREAD = "01a20e41-e0ad-7f41-93e7-b60a33cf8bd7";
const PARENT = "01a1cafc-c11b-7c82-8b67-daff47d56608";
const TEXT = "Mandible holds a message for you.";
const APP_PID = 58502;

type Run = { code: number | null; stdout: string; stderr: string };
const exit = (code: number | null, stdout = "", stderr = ""): Run => ({ code, stdout, stderr });

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "wake-codex-")); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function rollout(id: string, ...metas: object[]): void {
  const dir = path.join(home, ".codex", "sessions", "2026", "11", "24");
  fs.mkdirSync(dir, { recursive: true });
  const lines = metas.map((payload) => JSON.stringify({ type: "session_meta", payload: { id, ...payload } }));
  lines.push(JSON.stringify({ type: "turn_context", payload: {} }));
  fs.writeFileSync(path.join(dir, `rollout-2026-11-24T15-52-08-${id}.jsonl`), `${lines.join("\n")}\n`);
}

const desktop = { originator: "Codex Desktop", source: "vscode", thread_source: "user" };

function environment(responses: { lsappinfo?: Run; queue?: Run; open?: Run } = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const env: WakeEnvironment = {
    home,
    alive: (pid) => pid === APP_PID,
    run: async (command, args) => {
      calls.push({ command, args });
      if (command.endsWith("lsappinfo")) return responses.lsappinfo ?? exit(0, `"ChatGPT" ASN:0x0-0x1:\n    pid = ${APP_PID} !cgsConnection\n`);
      if (command === CODEX_APP_CLI) return responses.queue ?? exit(0, `Queued message for ${THREAD}`);
      if (command.endsWith("/open")) return responses.open ?? exit(0);
      throw new Error(`unexpected command ${command}`);
    },
  };
  return { env, calls, commands: () => calls.map((call) => path.basename(call.command)) };
}

const target = (session_id = THREAD): WakeTarget => ({ provider: "codex", session_id, registered: null, text: TEXT });

async function failure(t: WakeTarget, env: WakeEnvironment): Promise<WakeFailureCode> {
  const result = await wakeCodex(t, env);
  if (result.ok) throw new Error("expected a failure");
  return result.error.code;
}

it("wakes a desktop-app thread: queues with the app's bundled CLI, then opens the wake link in the background", async () => {
  rollout(THREAD, desktop);
  const { env, calls } = environment();
  expect(await wakeCodex(target(), env)).toEqual({ ok: true, value: undefined });
  const queue = calls.find((call) => call.command === CODEX_APP_CLI);
  expect(queue?.args).toEqual(["queue", "--thread", THREAD, "--message", TEXT]);
  expect(calls.at(-1)).toEqual({ command: "/usr/bin/open", args: ["-g", `codex://threads/wake/${THREAD}`] });
  expect(calls.indexOf(queue!)).toBeLessThan(calls.length - 1);
});

it("does not launch a quit app", async () => {
  rollout(THREAD, desktop);
  for (const lsappinfo of [exit(0, ""), exit(0, "pid = 999 !cgsConnection")]) {
    const { env, commands } = environment({ lsappinfo });
    expect(await failure(target(), env)).toBe("provider_not_running");
    expect(commands()).toEqual(["lsappinfo"]);
  }
});

it("refuses threads that do not live in the desktop app, touching nothing", async () => {
  const exec = "01a20e41-0000-7000-8000-000000000001";
  const terminal = "01a20e41-0000-7000-8000-000000000002";
  const forkedSubagent = "01a20e41-0000-7000-8000-000000000003";
  rollout(exec, { originator: "codex_exec", source: "exec", thread_source: "user" });
  rollout(terminal, { originator: "codex_cli_rs", source: "cli" });
  rollout(forkedSubagent,
    { originator: "Codex Desktop", source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } }, thread_source: "subagent" },
    { ...desktop, id: PARENT });
  const missing = "01a20e41-0000-7000-8000-000000000004";
  for (const id of [exec, terminal, forkedSubagent, missing, "../../etc"]) {
    const { env, calls } = environment();
    expect(await failure(target(id), env)).toBe("not_app_thread");
    expect(calls).toEqual([]);
  }
});

it("reports a missing or failing CLI, and a failed wake link, as entry_point_failed", async () => {
  rollout(THREAD, desktop);
  const missing = environment({ queue: exit(null, "", `spawn ${CODEX_APP_CLI} ENOENT`) });
  expect(await failure(target(), missing.env)).toBe("entry_point_failed");
  expect(missing.commands()).not.toContain("open");

  const failing = environment({ queue: exit(1, "", "error: thread not found") });
  const result = await wakeCodex(target(), failing.env);
  expect(result).toMatchObject({ ok: false, error: { code: "entry_point_failed", detail: expect.stringContaining("thread not found") } });
  expect(failing.commands()).not.toContain("open");

  const link = environment({ open: exit(1, "", "LSOpenURLsWithRole() failed") });
  expect(await failure(target(), link.env)).toBe("entry_point_failed");
});
