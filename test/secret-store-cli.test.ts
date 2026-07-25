// Issue e2cb93f — the secret-backend seam in cli/api.sh and the one-command
// provisioning flow `mandible user token mint <ref> --store`.
//
// Every test here stubs the macOS `security` binary via PATH (and, for the
// unsupported-platform cases, `uname`), so nothing in this file reads or writes
// the developer machine's real keychain.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const API_HELPER = path.join(process.cwd(), "cli", "api.sh");
const CLI = path.join(process.cwd(), "bin", "mandible");
const SHELLS = ["bash", "zsh"];

let stubDir = "";
let storeDir = "";
let homeDir = "";
let argvLog = "";
let server: http.Server | null = null;

/**
 * A fake `security` that keeps generic passwords as two-line files
 * (`<account>\n<secret>`) under storeDir, and appends every invocation's
 * arguments to argvLog so tests can prove the secret never travels in argv.
 */
function writeSecurityStub(): void {
  const stub = path.join(stubDir, "security");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -u
STORE=${JSON.stringify(storeDir)}
LOG=${JSON.stringify(argvLog)}
printf '%s\\n' "$*" >> "$LOG"
cmd="\${1:-}"
shift || true
svc=""; acct=""; inline=""; update=0
while [ $# -gt 0 ]; do
  case "$1" in
    -s) svc="\${2:-}"; shift 2 ;;
    -a) acct="\${2:-}"; shift 2 ;;
    -U) update=1; shift ;;
    -w)
      shift
      if [ $# -gt 0 ]; then
        case "$1" in
          -*) ;;
          *) inline="$1"; shift ;;
        esac
      fi
      ;;
    *) shift ;;
  esac
done
case "$cmd" in
  find-generic-password)
    file="$STORE/$svc"
    [ -f "$file" ] || exit 44
    stored_acct="$(sed -n 1p "$file")"
    if [ -n "$acct" ] && [ "$stored_acct" != "$acct" ]; then exit 44; fi
    sed -n 2p "$file"
    ;;
  add-generic-password)
    if [ -n "$inline" ]; then
      p1="$inline"
    else
      IFS= read -r p1 || exit 1
      IFS= read -r p2 || exit 1
      [ "$p1" = "$p2" ] || exit 1
    fi
    if [ -f "$STORE/$svc" ] && [ "$update" -eq 0 ]; then exit 45; fi
    printf '%s\\n%s\\n' "$acct" "$p1" > "$STORE/$svc"
    ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
}

/** A `uname` that claims a platform with no implemented secret backend. */
function writeLinuxUnameStub(): void {
  fs.writeFileSync(path.join(stubDir, "uname"), "#!/usr/bin/env bash\nprintf 'Linux\\n'\n", {
    mode: 0o755,
  });
}

function storedItem(service: string): { account: string; secret: string } | null {
  const file = path.join(storeDir, service);
  if (!fs.existsSync(file)) return null;
  const [account = "", secret = ""] = fs.readFileSync(file, "utf8").split("\n");
  return { account, secret };
}

function seedItem(service: string, account: string, secret: string): void {
  fs.writeFileSync(path.join(storeDir, service), `${account}\n${secret}\n`);
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    HOME: homeDir,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    ...extra,
  };
}

beforeEach(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-secret-stub-"));
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-secret-store-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-secret-home-"));
  argvLog = path.join(stubDir, "argv.log");
  fs.writeFileSync(argvLog, "");
  writeSecurityStub();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  }
  for (const dir of [stubDir, storeDir, homeDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runSeam(
  shell: string,
  script: string,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const full = [`source ${JSON.stringify(API_HELPER)}`, script].join("\n");
  const result = spawnSync(shell, ["-c", full], { encoding: "utf8", env: baseEnv(env) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("secret backend seam", () => {
  for (const shell of SHELLS) {
    it(`stores and reads a secret through the macOS backend under ${shell}`, () => {
      const written = runSeam(
        shell,
        'printf %s "tok-round-trip" | secret_set mandible-agent-test acct-1',
      );
      expect(written.status, written.stderr).toBe(0);
      expect(storedItem("mandible-agent-test")).toEqual({
        account: "acct-1",
        secret: "tok-round-trip",
      });

      const read = runSeam(shell, "secret_get mandible-agent-test acct-1");
      expect(read.status, read.stderr).toBe(0);
      expect(read.stdout).toBe("tok-round-trip");
    });

    it(`never passes the secret in argv under ${shell}`, () => {
      const written = runSeam(
        shell,
        'printf %s "tok-not-in-argv" | secret_set mandible-agent-test acct-1',
      );
      expect(written.status, written.stderr).toBe(0);
      expect(fs.readFileSync(argvLog, "utf8")).not.toContain("tok-not-in-argv");
    });

    it(`rotates an existing item in place under ${shell}`, () => {
      seedItem("mandible-agent-test", "acct-1", "old-token");
      const written = runSeam(
        shell,
        'printf %s "new-token" | secret_set mandible-agent-test acct-1',
      );
      expect(written.status, written.stderr).toBe(0);
      expect(storedItem("mandible-agent-test")?.secret).toBe("new-token");
    });

    it(`reports absence quietly under ${shell}`, () => {
      const result = runSeam(shell, 'secret_get mandible-agent-absent; printf "rc=%s" "$?"');
      expect(result.stdout).toBe("rc=1");
      expect(result.stderr).toBe("");
    });

    it(`fails visibly when the platform has no backend under ${shell}`, () => {
      writeLinuxUnameStub();
      const available = runSeam(shell, 'secret_backend_available; printf "rc=%s" "$?"');
      expect(available.stdout).toBe("rc=1");

      const reason = runSeam(shell, "secret_backend_unavailable_reason");
      expect(reason.stdout).toContain("no secret backend available on this platform");
      expect(reason.stdout).toContain("e2cb93f");

      const written = runSeam(
        shell,
        'printf %s "tok" | secret_set mandible-agent-test acct-1; printf "rc=%s" "$?"',
      );
      expect(written.stdout).toBe("rc=1");
      expect(storedItem("mandible-agent-test")).toBeNull();
    });
  }

  it("keeps api_keychain_operator_token semantics when routed through the seam", () => {
    seedItem("mandible-operator", "mll", "operator-token");

    const read = runSeam("bash", "api_keychain_operator_token");
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe("operator-token");

    const optedOut = runSeam("bash", 'api_keychain_operator_token; printf "rc=%s" "$?"', {
      MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
    });
    expect(optedOut.stdout).toBe("rc=0");

    // No backend at all is still a normal, non-fatal "no token" for readers.
    writeLinuxUnameStub();
    const noBackend = runSeam("bash", 'api_keychain_operator_token; printf "rc=%s" "$?"');
    expect(noBackend.stdout).toBe("rc=0");
    expect(noBackend.stderr).toBe("");
  });
});

interface FakeUser {
  slug: string;
  kind: string;
  appNames?: string[];
}

const MINTED_TOKEN = "mandible_pat_test-token-value";

async function startUserServer(
  user: FakeUser,
  requests: string[],
): Promise<number> {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url?.startsWith("/api/users/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          user: {
            id: `user-${user.slug}`,
            slug: user.slug,
            kind: user.kind,
            display_name: user.slug,
            status: "active",
            credentials: [],
            bindings: (user.appNames ?? []).map((value, index) => ({
              id: `binding-${index}`,
              binding_type: "app_name",
              value,
              status: "active",
            })),
          },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/tokens")) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          token: MINTED_TOKEN,
          credential: { id: "credential-1", status: "active", label: "provisioning" },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

function runCli(
  args: string[],
  port: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: baseEnv({
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
        MANDIBLE_PORT: String(port),
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
        // Reads are opted out so the stub is exercised only by the explicit
        // --store write; MANDIBLE_NO_KEYCHAIN_TOKEN governs token reads, not
        // deliberate provisioning.
        MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
      }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("user token mint --store", () => {
  it("stores an agent token under the shortest app_name binding and prints no token", async () => {
    const requests: string[] = [];
    const port = await startUserServer(
      { slug: "claude-code", kind: "agent", appNames: ["claude-channel", "claude-code", "claude"] },
      requests,
    );

    const result = await runCli(["user", "token", "mint", "claude-code", "--store"], port);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(MINTED_TOKEN);
    expect(result.stderr).not.toContain(MINTED_TOKEN);
    expect(result.stdout).toContain("credential: credential-1 [active]");
    expect(result.stdout).toContain("service: mandible-agent-claude");
    expect(result.stdout).toContain("account: claude-code");
    expect(storedItem("mandible-agent-claude")).toEqual({
      account: "claude-code",
      secret: MINTED_TOKEN,
    });
    expect(fs.readFileSync(argvLog, "utf8")).not.toContain(MINTED_TOKEN);
  });

  it("stores a human operator token under mandible-operator", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(["user", "token", "mint", "mll", "--store", "--json"], port);

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.token).toBeUndefined();
    expect(payload.secret).toEqual({
      backend: "keychain",
      service: "mandible-operator",
      account: "mll",
      rotated: false,
    });
    expect(storedItem("mandible-operator")?.secret).toBe(MINTED_TOKEN);
  });

  it("reports a rotation when the item already exists", async () => {
    seedItem("mandible-operator", "mll", "previous-token");
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(["user", "token", "mint", "mll", "--store"], port);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("rotated");
    expect(storedItem("mandible-operator")?.secret).toBe(MINTED_TOKEN);
  });

  it("honors an explicit --service override", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "gemini", kind: "agent" }, requests);

    const result = await runCli(
      ["user", "token", "mint", "gemini", "--store", "--service", "mandible-agent-custom"],
      port,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("service: mandible-agent-custom");
    expect(storedItem("mandible-agent-custom")?.secret).toBe(MINTED_TOKEN);
  });

  it("refuses to guess a service name for an agent with no app_name binding", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "gemini", kind: "agent" }, requests);

    const result = await runCli(["user", "token", "mint", "gemini", "--store"], port);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--service");
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false);
  });

  it("fails before minting when no secret backend is available", async () => {
    writeLinuxUnameStub();
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(["user", "token", "mint", "mll", "--store"], port);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no secret backend available on this platform");
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false);
  });

  it("rejects --service without --store", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(
      ["user", "token", "mint", "mll", "--service", "mandible-operator"],
      port,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--service requires --store");
    expect(requests).toEqual([]);
  });

  it("still prints the token once when --store is not passed", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(["user", "token", "mint", "mll"], port);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`token: ${MINTED_TOKEN}`);
    expect(requests.some((entry) => entry.startsWith("GET"))).toBe(false);
  });
});
