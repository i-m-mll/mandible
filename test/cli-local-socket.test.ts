// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("sends ordinary and protected local calls without inherited or Keychain tokens, preserving current agent attribution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-local-cli-"));
  const socket = path.join(root, "api.sock");
  const seen: Array<{ route?: string; authorization?: string; provider?: string; session?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ route: req.url, authorization: req.headers.authorization,
      provider: req.headers["x-mandible-ambient-provider"] as string,
      session: req.headers["x-mandible-ambient-provider-session-id"] as string });
    res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const child = spawn("bash", ["-c", `source "$API_HELPER"
secret_get() { echo forbidden-keychain-read >&2; return 99; }
api_keychain_operator_token() { echo forbidden-keychain-read >&2; return 99; }
for route in /api/health /api/auth/v2/request /api/users/agent/tokens; do
  out=$(api_temp_file); api_http_exchange POST "$route" '{}' "$out"
done`], { env: { ...process.env, HOME: root, API_HELPER: path.resolve("cli/api.sh"),
      MANDIBLE_BASE: "", MANDIBLE_SOCKET: socket, MANDIBLE_TOKEN: "stale-token", MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
      CODEX_THREAD_ID: "current-worker", CODEX_SESSION_ID: "inherited-parent", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" } });
    let output = ""; let errors = "";
    child.stdout.on("data", data => output += data); child.stderr.on("data", data => errors += data);
    expect(await new Promise(resolve => child.on("close", resolve)), errors).toBe(0);
    expect(output).toBe("200200200");
    expect(errors).not.toContain("forbidden-keychain-read");
    expect(seen).toHaveLength(3);
    expect(seen.every(request => !request.authorization && request.provider === "codex" && request.session === "current-worker")).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
