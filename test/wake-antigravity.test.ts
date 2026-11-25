// Antigravity wake executor against a fake home (hub and conversation files) and a fake agentapi.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_LANGUAGE_SERVER, wakeAntigravity } from "../src/notices/wake/antigravity.js";
import type { RegisteredRoute, WakeEnvironment, WakeTarget } from "../src/notices/wake/types.js";

const LIVE_PID = 4242;
const DEAD_PID = 1717;
const APP_TOKEN = "app-token-6f1c";
const CLI_TOKEN = "cli-token-93ad";
const TEXT = "Mandible holds a message for you.";
const SENT = JSON.stringify({ response: { sendMessage: { recipientId: "r" } } });

interface Call {
  command: string;
  args: readonly string[];
  env: Record<string, string> | undefined;
}

let home: string;
let calls: Call[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wake-antigravity-"));
  calls = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function environment(reply: { code: number | null; stdout: string; stderr?: string } = { code: 0, stdout: SENT }): WakeEnvironment {
  return {
    home,
    alive: (pid) => pid === LIVE_PID,
    run: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { code: reply.code, stdout: reply.stdout, stderr: reply.stderr ?? "" };
    },
  };
}

function write(relative: string, content: string, mtimeSeconds?: number): void {
  const file = path.join(home, ".gemini", "antigravity", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeSeconds !== undefined) fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

function hub(port: number, pid: number, token: string, mtimeSeconds: number): void {
  write(`daemon/hub_${port}.json`, JSON.stringify({ pid, httpPort: port, httpsPort: port + 1, lsVersion: "2.32.2", csrfToken: token }), mtimeSeconds);
}

function target(session_id: string, registered: RegisteredRoute | null = null): WakeTarget {
  return { provider: "antigravity", session_id, registered, text: TEXT };
}

const cliRoute: RegisteredRoute = { provider: "antigravity", address: "127.0.0.1:61000", token: CLI_TOKEN };

describe("wakeAntigravity", () => {
  it("wakes an App conversation through the live hub, ignoring a newer hub of a dead process", async () => {
    write("conversations/app-conv.db", "");
    hub(55157, LIVE_PID, APP_TOKEN, 1_000);
    hub(55999, DEAD_PID, "dead-token", 2_000);

    expect(await wakeAntigravity(target("app-conv", cliRoute), environment())).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([{
      command: APP_LANGUAGE_SERVER,
      args: ["agentapi", "send-message", "app-conv", TEXT],
      env: { ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:55157", ANTIGRAVITY_CSRF_TOKEN: APP_TOKEN },
    }]);
  });

  it("picks the newest of several live hubs", async () => {
    write("conversations/app-conv.db", "");
    hub(50001, LIVE_PID, "old-token", 1_000);
    hub(50002, LIVE_PID, APP_TOKEN, 3_000);

    await wakeAntigravity(target("app-conv"), environment());
    expect(calls[0]?.env?.ANTIGRAVITY_CSRF_TOKEN).toBe(APP_TOKEN);
  });

  it("reports provider_not_running for an App conversation with no live hub", async () => {
    write("conversations/app-conv.db", "");
    hub(55999, DEAD_PID, "dead-token", 2_000);

    const result = await wakeAntigravity(target("app-conv", cliRoute), environment());
    expect(result.ok ? null : result.error.code).toBe("provider_not_running");
    expect(calls).toEqual([]);
  });

  it("wakes a CLI conversation through its registered route", async () => {
    hub(55157, LIVE_PID, APP_TOKEN, 1_000);

    expect(await wakeAntigravity(target("cli-conv", cliRoute), environment())).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([{
      command: path.join(home, ".local", "bin", "agy"),
      args: ["agentapi", "send-message", "cli-conv", TEXT],
      env: { ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:61000", ANTIGRAVITY_CSRF_TOKEN: CLI_TOKEN },
    }]);
  });

  it("reports no_route for a CLI conversation that registered none", async () => {
    hub(55157, LIVE_PID, APP_TOKEN, 1_000);

    const result = await wakeAntigravity(target("cli-conv"), environment());
    expect(result).toEqual({ ok: false, error: { code: "no_route" } });
    expect(calls).toEqual([]);
  });

  it("reports route_refused when the address refuses the connection", async () => {
    // Output of `agy agentapi send-message` against a closed port, observed with agy 1.5.14.
    const refused = JSON.stringify({
      response: {},
      error: "rpc error: code = Unavailable desc = connection error: desc = \"transport: Error while dialing: dial tcp 127.0.0.1:61000: connect: connection refused\"",
    });
    const result = await wakeAntigravity(target("cli-conv", cliRoute), environment({ code: 1, stdout: refused }));
    expect(result.ok ? null : result.error.code).toBe("route_refused");
  });

  it("reports entry_point_failed with the provider's message, without the token", async () => {
    const failure = JSON.stringify({ response: {}, error: `rpc error: code = NotFound desc = conversation not found (csrf ${CLI_TOKEN})` });
    const result = await wakeAntigravity(target("cli-conv", cliRoute), environment({ code: 1, stdout: failure }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("entry_point_failed");
    expect(result.error).toHaveProperty("detail", expect.stringContaining("conversation not found"));
    expect(JSON.stringify(result.error)).not.toContain(CLI_TOKEN);
  });

  it("reports entry_point_failed when the child times out", async () => {
    const result = await wakeAntigravity(target("cli-conv", cliRoute), environment({ code: null, stdout: "" }));
    expect(result.ok ? null : result.error.code).toBe("entry_point_failed");
  });
});
