import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const FIXTURES = path.resolve("test/fixtures/hook-payloads");
const fixture = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

// What each provider takes from a hook's stdout, per its documentation and the captured runs.
const json = (stdout: string) => JSON.parse(stdout) as Record<string, any>;
const context = (stdout: string) => { const out = json(stdout); return out.hookSpecificOutput.hookEventName === "PostToolUse" ? out.hookSpecificOutput.additionalContext : null; };
const block = (stdout: string) => { const out = json(stdout); return out.decision === "block" ? out.reason : null; };
const plain = (stdout: string) => stdout.trimEnd();
const CASES: Array<{ provider: string; payload: string; read: (stdout: string) => unknown; agent?: string }> = [
  { provider: "claude", payload: "claude-UserPromptSubmit", read: plain },
  { provider: "claude", payload: "claude-PostToolUse", read: context },
  { provider: "claude", payload: "claude-PostToolUse-subagent", read: context, agent: "a4e1c2b7d9f03a6e" },
  { provider: "claude", payload: "claude-Stop", read: block },
  { provider: "claude", payload: "claude-SubagentStop", read: block, agent: "a4e1c2b7d9f03a6e" },
  { provider: "codex", payload: "codex-UserPromptSubmit", read: plain },
  { provider: "codex", payload: "codex-PostToolUse", read: context },
  { provider: "codex", payload: "codex-Stop", read: block },
  { provider: "antigravity", payload: "antigravity-PreInvocation", read: (stdout) => json(stdout).injectSteps[0].systemMessage.systemMessage },
  { provider: "antigravity", payload: "antigravity-Stop", read: (stdout) => { const out = json(stdout); return out.decision === "continue" ? out.reason : null; } },
];
const sessionOf = (payload: Record<string, unknown>) => (payload.session_id ?? payload.conversationId) as string;

const TEXT = "Mandible: message 1a2b3c4d from agent:codex:t1: Rebase onto main.\nMandible: auth 01234567 expired.";
let dir: string, socket: string, server: http.Server;
let owed: Array<{ id: string; text: string }>;
let deliveredStatus: number;
const seen: Array<{ url: string; body: unknown }> = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-hook-"));
  socket = path.join(dir, "s.sock");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url!, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/notices/collect") res.end(JSON.stringify({ notices: owed }));
      else { res.statusCode = deliveredStatus; res.end("{}"); }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  seen.length = 0;
  owed = TEXT.split("\n").map((text, i) => ({ id: `n${i}`, text }));
  deliveredStatus = 200;
});

function runHook(provider: string, payload: unknown, target = socket): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath.includes("bun") ? process.execPath : "bun", ["--no-install", path.resolve("src/cli/hook-notices.ts"), provider],
      { env: { ...process.env, MANDIBLE_SOCKET: target }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

it.each(CASES)("hands owed text to $provider at $payload in the provider's shape and confirms it", async ({ provider, payload, read, agent }) => {
  const input = fixture(payload);
  const result = await runHook(provider, input);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(read(result.stdout)).toBe(TEXT);
  expect(seen).toEqual([
    { url: "/api/notices/collect", body: { provider, session_id: sessionOf(input), ...(agent ? { agent_id: agent } : {}) } },
    { url: "/api/notices/delivered", body: { ids: ["n0", "n1"] } },
  ]);
});

it.each(CASES)("prints nothing for $payload when nothing is owed, after one request", async ({ provider, payload }) => {
  owed = [];
  expect(await runHook(provider, fixture(payload))).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(seen.map((request) => request.url)).toEqual(["/api/notices/collect"]);
});

it.each([["claude", "claude-Stop-continuing"], ["codex", "codex-Stop-continuing"], ["antigravity", "antigravity-Stop-continuing"]])(
  "does not refuse a %s Stop a second time in the same turn", async (provider, payload) => {
    expect(await runHook(provider, fixture(payload))).toEqual({ code: 0, stdout: "", stderr: "" });
  });

it("fails with a non-blocking exit when the daemon is unreachable or delivery is not confirmed", async () => {
  expect(await runHook("codex", fixture("codex-Stop"), path.join(dir, "absent.sock"))).toMatchObject({ code: 1, stdout: "" });
  deliveredStatus = 500;
  expect((await runHook("antigravity", fixture("antigravity-Stop"))).code).toBe(1);
});

it("fails with a non-blocking exit on an event it does not handle, an unknown provider, or a malformed payload", async () => {
  const preToolUse = { ...fixture("claude-PostToolUse"), hook_event_name: "PreToolUse" };
  const results = await Promise.all([
    runHook("claude", preToolUse), runHook("gemini", fixture("claude-Stop")), runHook("claude", "not json"),
    runHook("antigravity", fixture("codex-Stop")),
  ]);
  expect(results.map((result) => [result.code, result.stdout])).toEqual([[1, ""], [1, ""], [1, ""], [1, ""]]);
  expect(seen).toEqual([]);
});
