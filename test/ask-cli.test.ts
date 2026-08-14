import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { Router } from "../src/server.js";

const root = process.cwd();
let temp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ask-cli-"));
  const callLog = path.join(temp, "calls");
  fs.writeFileSync(path.join(temp, "api.sh"), `#!/usr/bin/env bash
api_send() {
  printf '%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3" "\${MANDIBLE_BASE:-}" >> "${callLog}"
  printf '%s' '{"ask_id":"ask-1","request_digest":"digest","replay":false,"dashboard_url":"/#/briefing?ask=ask-1&sidebar=hidden"}'
}
api_get() {
  printf '%s\\t%s\\t%s\\t%s\\n' "$1" "\${MANDIBLE_HTTP_TIMEOUT:-}" "\${MANDIBLE_FILE_RPC_TIMEOUT:-}" "\${MANDIBLE_BASE:-}" >> "${callLog}"
  printf '%s' '{"schema":"mandible-ask-result@1","ask_id":"ask-1","state":"open","request_digest":"digest","expires_at":999999,"submission":null,"wait_timed_out":true}'
}
api_temp_file() { mktemp "${temp}/response.XXXXXX"; }
api_capture() {
  local method="$1" request_path="$2" data="$3" output_file="$4"
  if [[ "$method" == "GET" ]]; then api_get "$request_path" > "$output_file"; else api_send "$method" "$request_path" "$data" > "$output_file"; fi
  printf '200'
}
urlencode() { printf '%s' "$1"; }
`, { mode: 0o700 });
  env = { ...process.env, MANDIBLE_CLI_DIR: temp, MANDIBLE_BASE: "http://127.0.0.1:19420" };
});

afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function run(args: string[], options: { input?: string; customEnv?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("bash", [path.join(root, "cli/ask.sh"), ...args], {
    cwd: root,
    env: options.customEnv ?? env,
    input: options.input,
    encoding: "utf8",
  });
}

async function runRealFileRpc(args: string[], transport: FileRpcTransport) {
  let stopped = false;
  const timer = setInterval(() => {
    if (!stopped) void transport.processOnce();
  }, 10);
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(path.join(root, "bin/mandible"), args, {
      cwd: root,
      env: { ...process.env, MANDIBLE_BASE: `file://${transport.dir}`, MANDIBLE_FILE_RPC_TIMEOUT: "5" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      stopped = true;
      clearInterval(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("mandible ask CLI", () => {
  it("is dispatched and documented by the top-level help", () => {
    const help = execFileSync(path.join(root, "bin/mandible"), ["help"], { encoding: "utf8" });
    expect(help).toContain("ask submit|wait|result");
    const askHelp = execFileSync(path.join(root, "bin/mandible"), ["ask", "--help"], { encoding: "utf8" });
    expect(askHelp).toContain("mandible ask submit");
  });

  it("submits JSON unchanged from a file and stdin with JSON or human output", () => {
    const packetPath = path.join(temp, "packet.json");
    const packet = '{"request_key":"key","items":[]}';
    fs.writeFileSync(packetPath, packet);
    const json = run(["submit", packetPath, "--json"]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ ask_id: "ask-1", replay: false });
    expect(fs.readFileSync(path.join(temp, "calls"), "utf8")).toContain(`POST\t/api/asks\t${packet}`);
    fs.rmSync(path.join(temp, "calls"));
    const human = run(["submit", "-"], { input: packet });
    expect(human.stdout).toContain("Ask ask-1");
    expect(human.stdout).toContain("/#/briefing?ask=ask-1");
  });

  it("rejects concatenated JSON documents from both a file and stdin before transport", () => {
    const packetPath = path.join(temp, "concatenated.json");
    fs.writeFileSync(packetPath, '{} {"second":true}');
    for (const result of [run(["submit", packetPath]), run(["submit", "-"], { input: "{}\n{}" })]) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exactly one valid JSON document");
    }
    expect(fs.existsSync(path.join(temp, "calls"))).toBe(false);
  });

  it("parses wait durations and raises both transport budgets above the server wait", () => {
    for (const [duration, expected] of [[undefined, "25000"], ["55s", "55000"], ["500ms", "500"], ["1.5s", "1500"]] as const) {
      fs.rmSync(path.join(temp, "calls"), { force: true });
      const args = ["wait", "ask-1", "--json"];
      if (duration) args.splice(2, 0, "--timeout", duration);
      const result = run(args);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: "mandible-ask-result@1", submission: null });
      const fields = fs.readFileSync(path.join(temp, "calls"), "utf8").trim().split("\t");
      expect(fields[0]).toContain(`/wait?timeout_ms=${expected}`);
      expect(Number(fields[1]) * 1000).toBeGreaterThan(Number(expected));
      expect(Number(fields[2]) * 1000).toBeGreaterThan(Number(expected));
    }
  });

  it("rejects waits above 55000 ms before transport", () => {
    const result = run(["wait", "ask-1", "--timeout", "1m"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("55000");
    expect(fs.existsSync(path.join(temp, "calls"))).toBe(false);
  });

  it("keeps result envelopes structured over HTTP and file-RPC selections", () => {
    for (const base of ["http://127.0.0.1:19420", `file://${temp}/rpc`]) {
      const result = run(["result", "ask-1", "--json"], {
        customEnv: { ...env, MANDIBLE_BASE: base },
      });
      expect(JSON.parse(result.stdout)).toEqual({
        schema: "mandible-ask-result@1",
        ask_id: "ask-1",
        state: "open",
        request_digest: "digest",
        expires_at: 999999,
        submission: null,
        wait_timed_out: true,
      });
    }
  });

  it("uses the real shared HTTP helper and preserves its canonical response", () => {
    const binDir = path.join(temp, "bin");
    fs.mkdirSync(binDir);
    const response = path.join(temp, "http-response.json");
    const curlLog = path.join(temp, "curl-log");
    fs.writeFileSync(response, '{"schema":"mandible-ask-result@1","ask_id":"http-ask","state":"open","request_digest":"digest","expires_at":999999,"submission":null}');
    fs.writeFileSync(path.join(binDir, "curl"), `#!/usr/bin/env bash
out=""
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --max-time) printf '%s\\n' "$2" >> "${curlLog}"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
cp "${response}" "$out"
printf '200'
`, { mode: 0o700 });
    const result = spawnSync(path.join(root, "bin/mandible"), ["ask", "result", "http-ask", "--json"], {
      cwd: root,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, MANDIBLE_BASE: "http://mandible.invalid", MANDIBLE_HTTP_RETRIES: "0" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema: "mandible-ask-result@1", ask_id: "http-ask", state: "open", request_digest: "digest", expires_at: 999999, submission: null });
    expect(fs.readFileSync(curlLog, "utf8").trim()).toBe("15");
  });

  it("uses the real shared file-RPC helper for result and wait envelopes", async () => {
    const rpcDir = path.join(temp, "rpc-real");
    const canonical = { schema: "mandible-ask-result@1", ask_id: "rpc-ask", state: "open", request_digest: "digest", expires_at: 999999, submission: null };
    const rpcRouter = new Router();
    rpcRouter.get("/api/asks/:id/result", (_req, res) => res.json(canonical), { fileRpc: "allow" });
    rpcRouter.get("/api/asks/:id/wait", (req, res) => res.json({ ...canonical, wait_timed_out: true, timeout_seen: req.query.timeout_ms }), { fileRpc: "allow" });
    const transport = new FileRpcTransport({ router: rpcRouter, dir: rpcDir, responseTtlMs: 60_000 });
    const result = await runRealFileRpc(["ask", "result", "rpc-ask", "--json"], transport);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(canonical);
    const wait = await runRealFileRpc(["ask", "wait", "rpc-ask", "--timeout", "500ms", "--json"], transport);
    expect(wait.status).toBe(0);
    expect(JSON.parse(wait.stdout)).toEqual({ ...canonical, wait_timed_out: true, timeout_seen: "500" });
  });

  it("returns nonzero API failures without printing staged secrets", () => {
    fs.writeFileSync(path.join(temp, "api.sh"), `#!/usr/bin/env bash
api_send() { printf 'request failed\\n' >&2; return 22; }
api_get() { printf 'request failed\\n' >&2; return 22; }
api_temp_file() { mktemp "${temp}/response.XXXXXX"; }
api_capture() { printf '%s' '{"error":"answer-secret-and-token","code":"denied"}' > "$4"; printf '403'; }
urlencode() { printf '%s' "$1"; }
`, { mode: 0o700 });
    const secret = "answer-secret-and-token";
    const result = run(["result", "ask-1", "--json"], {
      customEnv: { ...env, MANDIBLE_CLIENT_TOKEN: secret },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(secret);
  });
});
