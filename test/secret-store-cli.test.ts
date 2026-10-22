// @vitest-environment node
// Issue e2cb93f — the secret-backend seam in cli/api.sh, ambient credential
// resolution, and `mandible user token mint <ref> --store`.
//
// Every test stubs the keychain tool (MANDIBLE_SECURITY_BIN) and `uname`, so
// nothing here touches the developer's keychain and the macOS-only backend runs
// on any CI runner. Both shells run only where shell semantics decide the
// outcome: xtrace suppression and never echoing or exporting a token.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CLI, runCli, scratchDir, startStubDaemon, type CliResult, type StubDaemon, type StubRequest } from "./helpers/cli-process.js";
import { qualifiedRuntimeFixtureEnv } from "./helpers/runtime-fixture.js";

const API_HELPER = path.join(process.cwd(), "cli", "api.sh");
const CLI_DIR = path.join(process.cwd(), "cli");
const SHELLS = ["bash", "zsh"];
const MINTED_TOKEN = "mandible_pat_test-token-value";
const fixtureRuntimeEnv = qualifiedRuntimeFixtureEnv();

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface StoredItem {
  service: string;
  account: string;
  secret: string;
}

/**
 * A fake keychain tool with the fidelity these tests need. Items are stored one
 * per file under `<store>/items/NNN` as `<service>\n<account>\n<secret>`, with
 * NNN increasing by creation order, so items are keyed by (service, account),
 * several may share a service, a service-only lookup resolves to the OLDEST
 * match (what the real keychain does), and a miss exits 44, the status the real
 * tool uses for item-not-found.
 *
 * It understands argv invocations and `-i` batch mode with security's batch
 * quoting. MANDIBLE_TEST_SECURITY_FAIL=attributes makes attribute reads fail
 * operationally (exit 1, never 44); MANDIBLE_TEST_SECURITY_SHADOW=<account>
 * inserts an older competing item for the service before a write.
 *
 * Every invocation's argv is logged so tests can assert no secret reaches an
 * argument list, and `add-generic-password` without an inline value (the
 * getpass/tty protocol) is refused, so reverting to "pipe the password to -w"
 * fails on every platform.
 */
function keychain() {
  const dir = scratchDir("keychain");
  const bin = path.join(dir, "bin");
  const store = path.join(dir, "store");
  const log = path.join(dir, "argv.log");
  const home = path.join(dir, "home");
  for (const created of [bin, store, home]) fs.mkdirSync(created);
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "security"), securityStub(store, log), { mode: 0o755 });
  const kernel = (name: "Darwin" | "Linux") => fs.writeFileSync(
    path.join(bin, "uname"),
    `#!/usr/bin/env bash\nif [[ "$1" == "-s" ]]; then printf '${name}\\n'; else /usr/bin/uname "$@"; fi\n`,
    { mode: 0o755 },
  );
  kernel("Darwin");
  const items = (): StoredItem[] => {
    const itemsDir = path.join(store, "items");
    if (!fs.existsSync(itemsDir)) return [];
    return fs.readdirSync(itemsDir).sort().map((name) => {
      const [service = "", account = "", secret = ""] = fs.readFileSync(path.join(itemsDir, name), "utf8").split("\n");
      return { service, account, secret };
    });
  };
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    MANDIBLE_RUNTIME: process.execPath,
    ...fixtureRuntimeEnv,
    GIT_OPTIONAL_LOCKS: "0",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    MANDIBLE_SECURITY_BIN: path.join(bin, "security"),
    ...extra,
  });
  return {
    dir,
    home,
    env,
    items,
    /** With an account, that exact item; without one, the oldest for the service. */
    item: (service: string, account?: string) =>
      items().find((item) => item.service === service && (account === undefined || item.account === account)) ?? null,
    seed(service: string, account: string, secret: string) {
      const itemsDir = path.join(store, "items");
      fs.mkdirSync(itemsDir, { recursive: true });
      fs.writeFileSync(path.join(itemsDir, String(fs.readdirSync(itemsDir).length + 1).padStart(3, "0")), `${service}\n${account}\n${secret}\n`);
    },
    argv: () => fs.readFileSync(log, "utf8"),
    linux: () => kernel("Linux"),
    /** Source api.sh and run `script` in `shell`. */
    seam(script: string, extra: Record<string, string> = {}, shell = "bash", flags: string[] = []) {
      const result = spawnSync(shell, [...flags, "-c", `source ${JSON.stringify(API_HELPER)}\n${script}`], { encoding: "utf8", env: env(extra) });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}
type Keychain = ReturnType<typeof keychain>;

interface FakeUser {
  slug: string;
  kind: string;
  appNames?: string[];
  whoamiAuthenticated?: boolean;
}

async function userDaemon(user: FakeUser): Promise<StubDaemon> {
  const stub = await startStubDaemon(({ method, url, headers }) => {
    if (method === "GET" && url === "/api/client-auth/whoami") {
      const authenticated = user.whoamiAuthenticated !== false && Boolean(headers.authorization);
      return { body: { authenticated, user: authenticated ? { id: `user-${user.slug}`, slug: user.slug, kind: user.kind } : null } };
    }
    if (method === "GET" && url.startsWith("/api/users") && !url.startsWith("/api/users/")) return { body: { users: [] } };
    if (method === "GET" && url.startsWith("/api/users/")) {
      return {
        body: {
          user: {
            id: `user-${user.slug}`, slug: user.slug, kind: user.kind, display_name: user.slug, status: "active", credentials: [],
            bindings: (user.appNames ?? []).map((value, index) => ({ id: `binding-${index}`, binding_type: "app_name", value, status: "active" })),
          },
        },
      };
    }
    if (method === "POST" && url.endsWith("/tokens")) {
      return { status: 201, body: { token: MINTED_TOKEN, credential: { id: "credential-1", status: "active", label: "provisioning" } } };
    }
    return undefined;
  });
  cleanups.push(() => stub.close());
  return stub;
}

/** Environment for a CLI talking to `stub`, with Keychain token reads opted out unless overridden. */
function cliEnv(chain: Keychain, stub: StubDaemon, extra: Record<string, string> = {}) {
  return chain.env({
    ...stub.env,
    MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
    MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
    ...extra,
  });
}

function cli(chain: Keychain, stub: StubDaemon, args: string[], extra: Record<string, string> = {}): Promise<CliResult> {
  return runCli(args, { env: cliEnv(chain, stub, extra), inheritEnv: false });
}

const authOf = (requests: StubRequest[], url: string) => requests.find((request) => request.method === "GET" && request.url === url)?.headers.authorization ?? "";
const posted = (stub: StubDaemon) => stub.requests.some((request) => request.method === "POST");

describe("secret backend seam", () => {
  it("writes through batch mode, never argv, and reads back exactly what was stored", () => {
    const chain = keychain();
    chain.seed("svc-rotate", "acct-1", "old-token");
    const awkward = 'has"quote\\slash and space';

    for (const [service, value] of [["svc-plain", "tok-not-in-argv"], ["svc-quoting", awkward], ["svc-rotate", "new-token"]]) {
      const written = chain.seam(`printf %s ${JSON.stringify(value)} | secret_set ${service} acct-1`);
      expect(written.status, written.stderr).toBe(0);
      expect(chain.item(service)?.secret).toBe(value);
    }

    expect(chain.seam("secret_get svc-plain acct-1").stdout).toBe("tok-not-in-argv");
    expect(chain.items().filter((item) => item.service === "svc-rotate")).toHaveLength(1);
    const argv = chain.argv();
    expect(argv).not.toContain("tok-not-in-argv");
    expect(argv.split("\n")).toContain("-i");
    expect(argv).not.toContain("add-generic-password");
  });

  it("keys lookups on service and account, and resolves a service-only lookup to the oldest item", () => {
    const chain = keychain();
    chain.seed("svc-multi", "older", "older-token");
    chain.seed("svc-multi", "newer", "newer-token");

    expect(chain.seam("secret_get svc-multi newer").stdout).toBe("newer-token");
    expect(chain.seam('secret_get svc-multi absent; printf "rc=%s" "$?"').stdout).toBe("rc=1");
    expect(chain.seam("secret_get svc-multi").stdout).toBe("older-token");
    expect(chain.seam("secret_account_for_service svc-multi").stdout).toBe("older");
  });

  it("reports an absent item quietly and never mistakes an unreadable keychain for absence", () => {
    const chain = keychain();
    chain.seed("svc-present", "acct-1", "token");
    const lookup = (service: string, extra: Record<string, string> = {}) =>
      chain.seam(`secret_account_for_service ${service}; printf "rc=%s" "$?"`, extra);

    expect(lookup("svc-present").stdout).toBe("acct-1rc=0");
    const absent = chain.seam('secret_get svc-absent; printf "rc=%s" "$?"');
    expect(absent.stdout).toBe("rc=1");
    expect(absent.stderr).toBe("");
    expect(lookup("svc-absent").stdout).toBe("rc=1");
    expect(lookup("svc-present", { MANDIBLE_TEST_SECURITY_FAIL: "attributes" }).stdout).toBe("rc=3");
  });

  it("refuses input it cannot store faithfully, storing nothing", () => {
    const chain = keychain();
    const brokenWc = path.join(chain.dir, "broken-wc");
    fs.mkdirSync(brokenWc);
    fs.writeFileSync(path.join(brokenWc, "wc"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    // Byte-exact NUL fixtures, piped through `cat` so the stream is non-seekable
    // (the seam's calling convention). A terminal NUL is swallowed as read's
    // delimiter, so only the read status itself can refuse it.
    const nul = (bytes: number[]) => {
      const file = path.join(chain.dir, `nul-${bytes.join("-")}`);
      fs.writeFileSync(file, Buffer.from(bytes));
      return `cat ${JSON.stringify(file)}`;
    };
    const cases: Array<[string, string, Record<string, string>?]> = [
      ["multi-line stdin", 'printf "first\\nsecond\\n"'],
      ["a terminal NUL", nul([0x74, 0x6f, 0x6b, 0x00])],
      ["a terminal NUL after the newline", nul([0x74, 0x6f, 0x6b, 0x0a, 0x00])],
      ["a leading NUL", nul([0x00, 0x74, 0x6f, 0x6b, 0x0a])],
      ["a NUL inside the line", nul([0x74, 0x00, 0x6f, 0x6b, 0x0a])],
      ["NULs after the line", nul([0x74, 0x6f, 0x6b, 0x0a, 0x00, 0x00])],
      ["NULs with no newline", nul([0x74, 0x6f, 0x6b, 0x00, 0x00])],
      ["NUL-only input", nul([0x00])],
      ["empty stdin", "cat /dev/null"],
      ["a tab", 'printf "a\\tb"'],
      ["non-ASCII", 'printf %s "café"'],
      ["an uncountable leftover", 'printf %s "tok"', { PATH: `${brokenWc}:${chain.env().PATH}` }],
    ];
    for (const [name, input, extra] of cases) {
      expect(chain.seam(`${input} | secret_set svc-refused acct-1; printf "rc=%s" "$?"`, extra).stdout, name).toBe("rc=2");
    }
    expect(chain.seam(`printf %s "tok" | secret_set "svc-$(printf '\\t')" acct-1; printf "rc=%s" "$?"`).stdout).toBe("rc=2");
    expect(chain.items()).toEqual([]);

    expect(chain.seam('printf "only\\n" | secret_set svc-single acct-1; printf "rc=%s" "$?"').stdout).toBe("rc=0");
    expect(chain.item("svc-single")?.secret).toBe("only");
  });

  it("fails writes visibly without a platform backend while token readers carry on without one", () => {
    const chain = keychain();
    chain.seed("mandible-operator", "mll", "operator-token");
    expect(chain.seam("api_keychain_operator_token").stdout).toBe("operator-token");
    expect(chain.seam('api_keychain_operator_token; printf "rc=%s" "$?"', { MANDIBLE_NO_KEYCHAIN_TOKEN: "1" }).stdout).toBe("rc=0");

    chain.linux();
    expect(chain.seam('secret_backend_available; printf "rc=%s" "$?"').stdout).toBe("rc=1");
    expect(chain.seam("secret_backend_unavailable_reason").stdout).toContain("no secret backend available on this platform");
    expect(chain.seam('printf %s "tok" | secret_set svc-linux acct-1; printf "rc=%s" "$?"').stdout).toBe("rc=1");
    expect(chain.item("svc-linux")).toBeNull();
    const reader = chain.seam('api_keychain_operator_token; printf "rc=%s" "$?"');
    expect(reader.stdout).toBe("rc=0");
    expect(reader.stderr).toBe("");
  });

  it("creates token-bearing temp files as 0600 inside a 0700 root", () => {
    const result = keychain().seam(
      'f="$(api_temp_file)"; printf "file="; stat -f "%Lp" "$f" 2>/dev/null || stat -c "%a" "$f"; '
        + 'printf "root="; stat -f "%Lp" "$MANDIBLE_API_TEMP_ROOT" 2>/dev/null || stat -c "%a" "$MANDIBLE_API_TEMP_ROOT"',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("file=600");
    expect(result.stdout).toContain("root=700");
  });

  for (const shell of SHELLS) {
    it(`suppresses and restores xtrace around secret handling under ${shell}`, () => {
      const chain = keychain();
      // Piped from a file so the traced caller line carries no secret: anything
      // in the trace came from inside the seam.
      const valueFile = path.join(chain.dir, "trace-input");
      fs.writeFileSync(valueFile, "xtrace-secret");
      const result = chain.seam([
        `cat ${JSON.stringify(valueFile)} | secret_set svc-trace acct-1`,
        "secret_get svc-trace acct-1 >/dev/null",
        "echo marker-after-restore >/dev/null",
      ].join("\n"), {}, shell, ["-x"]);

      expect(result.status, result.stderr).toBe(0);
      expect(chain.item("svc-trace")?.secret).toBe("xtrace-secret");
      expect(result.stderr).not.toContain("xtrace-secret");
      expect(result.stderr).toContain("marker-after-restore");
    });

    it(`sends the operator token through a real request without echoing it under ${shell}`, async () => {
      // The reader chain end to end under -x (api_client_token → secret_get →
      // curl config): a callee cannot protect its caller's trace, so only the
      // real call sites prove this.
      const chain = keychain();
      chain.seed("mandible-operator", "mll", "captured-operator-token");
      const stub = await userDaemon({ slug: "mll", kind: "human" });

      const result = await runCli(["-x", path.join(CLI_DIR, "user.sh"), "list"], {
        command: shell,
        env: cliEnv(chain, stub, { MANDIBLE_CLI_DIR: CLI_DIR, MANDIBLE_NO_KEYCHAIN_TOKEN: "" }),
        inheritEnv: false,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(stub.requests.map((request) => request.headers.authorization)).toContain("Bearer captured-operator-token");
      expect(result.stderr).not.toContain("captured-operator-token");
      expect(result.stderr).toContain("+");
    });

    it(`never exports an agent token from wrap.sh under ${shell}`, async () => {
      const chain = keychain();
      chain.seed("mandible-agent-claude", "claude-code", "wrapped-agent-token");
      const stub = await userDaemon({ slug: "claude-code", kind: "agent" });

      const result = await runCli([
        "-x", path.join(CLI_DIR, "wrap.sh"), "--app", "claude", "--id", "secret-store-test-session", "--",
        "/bin/sh", "-c", 'printf "token=%s managed=%s" "${MANDIBLE_TOKEN-unset}" "$MANDIBLE_MANAGED_CLIENT"',
      ], { command: shell, env: cliEnv(chain, stub, { MANDIBLE_NO_KEYCHAIN_TOKEN: "" }), inheritEnv: false });

      expect(result.stdout).toContain("token=unset managed=1");
      expect(result.stderr).not.toContain("wrapped-agent-token");
    });
  }
});

describe("direct CLI agent credential resolution", () => {
  const reads = { MANDIBLE_NO_KEYCHAIN_TOKEN: "" };

  it("loads the provider's own Keychain credential, and none when provider markers disagree", async () => {
    const markers: Array<[Record<string, string>, string]> = [
      [{ CODEX_SESSION_ID: "codex-session" }, "Bearer codex-keychain-token"],
      [{ CODEX_THREAD_ID: "thread-id", CODEX_SESSION_ID: "thread-id" }, "Bearer codex-keychain-token"],
      [{ CODEX_THREAD_ID: "thread-id", CLAUDE_SESSION_ID: "claude-id" }, ""],
    ];
    await Promise.all(markers.map(async ([marker, expected]) => {
      const chain = keychain();
      chain.seed("mandible-agent-codex", "codex-agent", "codex-keychain-token");
      chain.seed("mandible-operator", "mll", "operator-token");
      const stub = await userDaemon({ slug: "codex-agent", kind: "agent" });

      const result = await cli(chain, stub, ["user", "list", "--json"], { ...marker, ...reads });

      expect(result.status, result.stderr).toBe(0);
      expect(authOf(stub.requests, "/api/users"), JSON.stringify(marker)).toBe(expected);
      expect(chain.argv()).not.toContain("codex-keychain-token");
    }));
    const ambient = keychain().seam('printf "%s|%s" "$(api_ambient_provider)" "$(api_ambient_session_id)"', { CODEX_SESSION_ID: "codex-session" });
    expect(ambient.stdout).toBe("codex|codex-session");
  });

  it("keeps a verified inherited agent token without reading the Keychain secret", async () => {
    const chain = keychain();
    chain.seed("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    const stub = await userDaemon({ slug: "codex-agent", kind: "agent" });

    const result = await cli(chain, stub, ["user", "list", "--json"], { CODEX_THREAD_ID: "thread-id", MANDIBLE_TOKEN: "inherited-agent-token", ...reads });

    expect(result.status, result.stderr).toBe(0);
    expect(authOf(stub.requests, "/api/client-auth/whoami")).toBe("Bearer inherited-agent-token");
    expect(authOf(stub.requests, "/api/users")).toBe("Bearer inherited-agent-token");
    expect(chain.argv()).not.toContain(" -w");
  });

  it("drops an inherited token it cannot verify as this agent, with no Keychain or operator fallback", async () => {
    const users: FakeUser[] = [
      { slug: "mll", kind: "human" },
      { slug: "other-agent", kind: "agent" },
      { slug: "codex-agent", kind: "agent", whoamiAuthenticated: false },
    ];
    const results = await Promise.all(users.map(async (user) => {
      const chain = keychain();
      chain.seed("mandible-agent-codex", "codex-agent", "codex-keychain-token");
      chain.seed("mandible-operator", "mll", "operator-token");
      const stub = await userDaemon(user);
      const result = await cli(chain, stub, ["user", "list", "--json"], { CODEX_THREAD_ID: "thread-id", MANDIBLE_TOKEN: "rejected-inherited-token", ...reads });
      return { ...result, auth: authOf(stub.requests, "/api/users") };
    }));
    const unverifiable = keychain();
    unverifiable.seed("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    const unavailable = unverifiable.seam("api_client_token GET", {
      CODEX_SESSION_ID: "codex-session", MANDIBLE_TOKEN: "rejected-inherited-token", MANDIBLE_BASE: "http://127.0.0.1:1", ...reads,
    });

    for (const result of [...results, { ...unavailable, auth: unavailable.stdout }]) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.auth).toBe("");
      expect(result.stderr).toContain("ignoring inherited MANDIBLE_TOKEN");
      for (const secret of ["rejected-inherited-token", "codex-keychain-token", "operator-token"]) expect(result.stderr).not.toContain(secret);
    }
  });

  it("never falls back to the operator credential when the agent Keychain item is missing or locked", async () => {
    await Promise.all([{}, { MANDIBLE_TEST_SECURITY_FAIL: "attributes" }].map(async (state) => {
      const chain = keychain();
      chain.seed("mandible-operator", "mll", "operator-token");
      const stub = await userDaemon({ slug: "codex-agent", kind: "agent" });

      const result = await cli(chain, stub, ["user", "list", "--json"], { CODEX_SESSION_ID: "codex-session", ...reads, ...state });

      expect(result.status, result.stderr).toBe(0);
      expect(authOf(stub.requests, "/api/users")).toBe("");
    }));
  });

  it("uses the operator Keychain credential in an unmarked human shell", async () => {
    const chain = keychain();
    chain.seed("mandible-operator", "mll", "operator-token");
    const stub = await userDaemon({ slug: "mll", kind: "human" });

    const result = await cli(chain, stub, ["user", "list", "--json"], reads);

    expect(result.status, result.stderr).toBe(0);
    expect(authOf(stub.requests, "/api/users")).toBe("Bearer operator-token");
  });

  it("projects no agent credential, stored or inherited, into the file transport", () => {
    const chain = keychain();
    chain.seed("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    for (const inherited of ["", "inherited-agent-token"]) {
      const result = chain.seam('api_client_token POST; printf "|source=%s" "$API_CLIENT_CREDENTIAL_SOURCE"', {
        CODEX_SESSION_ID: "codex-session", MANDIBLE_BASE: `file://${path.join(chain.home, "spool")}`, MANDIBLE_TOKEN: inherited, ...reads,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("|source=");
      if (inherited) expect(result.stderr).not.toContain(inherited);
    }
  });
});

describe("user token mint --store", () => {
  const mint = (...args: string[]) => ["user", "token", "mint", ...args];

  it("stores an agent token under its shortest app_name binding or an explicit service, and prints no token", async () => {
    const [chain, explicit] = [keychain(), keychain()];
    const stub = await userDaemon({ slug: "claude-code", kind: "agent", appNames: ["claude-code", "claude"] });

    const [result, overridden] = await Promise.all([
      cli(chain, stub, mint("claude-code", "--store")),
      cli(explicit, stub, mint("claude-code", "--store", "--service", "mandible-agent-custom")),
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(MINTED_TOKEN);
    expect(result.stdout).toContain("service: mandible-agent-claude");
    expect(chain.item("mandible-agent-claude")).toEqual({ service: "mandible-agent-claude", account: "claude-code", secret: MINTED_TOKEN });
    expect(chain.argv()).not.toContain(MINTED_TOKEN);
    expect(overridden.status, overridden.stderr).toBe(0);
    expect(explicit.item("mandible-agent-custom")?.secret).toBe(MINTED_TOKEN);
  });

  it("stores an operator token under mandible-operator, reports rotation, and prints the token only without --store", async () => {
    const [fresh, rotated, printed] = [keychain(), keychain(), keychain()];
    rotated.seed("mandible-operator", "mll", "previous-token");
    const stub = await userDaemon({ slug: "mll", kind: "human" });

    const [json, rotation, once] = await Promise.all([
      cli(fresh, stub, mint("mll", "--store", "--json")),
      cli(rotated, stub, mint("mll", "--store")),
      cli(printed, stub, mint("mll")),
    ]);

    expect(json.status, json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout);
    expect(payload.token).toBeUndefined();
    expect(payload.secret).toEqual({ backend: "keychain", service: "mandible-operator", account: "mll", rotated: false });
    expect(fresh.item("mandible-operator")?.secret).toBe(MINTED_TOKEN);
    expect(rotation.status, rotation.stderr).toBe(0);
    expect(rotation.stderr).toContain("rotated");
    expect(rotated.item("mandible-operator")?.secret).toBe(MINTED_TOKEN);
    expect(once.status, once.stderr).toBe(0);
    expect(once.stdout).toContain(`token: ${MINTED_TOKEN}`);
    expect(printed.items()).toEqual([]);
  });

  it("refuses before minting when the stored token could not be found again or kept faithfully", async () => {
    const cases: Array<{ name: string; user: FakeUser; args: string[]; expected: string; setup?: (chain: Keychain) => Record<string, string> | void }> = [
      // Ambient readers look the service up without an account; a second item would leave them on the older token.
      { name: "another account holds the service", user: { slug: "mll", kind: "human" }, args: [], expected: "someone-else", setup: (chain) => chain.seed("mandible-operator", "someone-else", "previous-token") },
      { name: "the existing item is unreadable", user: { slug: "mll", kind: "human" }, args: [], expected: "could not read the existing secret-store item", setup: () => ({ MANDIBLE_TEST_SECURITY_FAIL: "attributes" }) },
      { name: "no backend", user: { slug: "mll", kind: "human" }, args: [], expected: "keychain tool is missing", setup: (chain) => ({ MANDIBLE_SECURITY_BIN: path.join(chain.dir, "missing-security") }) },
      { name: "an agent without app_name", user: { slug: "gemini", kind: "agent" }, args: [], expected: "no active app_name binding" },
      { name: "a system user", user: { slug: "system", kind: "system" }, args: [], expected: "user kind 'system'" },
      { name: "a blank service", user: { slug: "mll", kind: "human" }, args: ["--service", "  "], expected: "--service must name a service" },
      { name: "an unstorable service", user: { slug: "mll", kind: "human" }, args: ["--service", "mandible\toperator"], expected: "printable ASCII" },
    ];
    await Promise.all(cases.map(async ({ name, user, args, expected, setup }) => {
      const chain = keychain();
      const extra = setup?.(chain) ?? {};
      const before = chain.items();
      const stub = await userDaemon(user);

      const result = await cli(chain, stub, mint(user.slug, "--store", ...args), extra);

      expect(result.status, name).not.toBe(0);
      expect(result.stderr, name).toContain(expected);
      expect(posted(stub), name).toBe(false);
      expect(chain.items(), name).toEqual(before);
    }));
  });

  it("reports a racing writer that shadows the item it just stored", async () => {
    const chain = keychain();
    const stub = await userDaemon({ slug: "mll", kind: "human" });

    const result = await cli(chain, stub, mint("mll", "--store"), { MANDIBLE_TEST_SECURITY_SHADOW: "intruder" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("credential-1");
    expect(result.stderr).toContain("intruder");
    expect(result.stderr).not.toContain(MINTED_TOKEN);
    // The write happened; the failure is that ambient readers resolve to the shadowing item.
    expect(chain.item("mandible-operator", "mll")?.secret).toBe(MINTED_TOKEN);
    expect(chain.item("mandible-operator")?.account).toBe("intruder");
  });

  it("never echoes the token when the CLI itself runs under xtrace", async () => {
    const chain = keychain();
    const stub = await userDaemon({ slug: "mll", kind: "human" });

    const result = await runCli(["-x", path.join(CLI_DIR, "user.sh"), "token", "mint", "mll", "--store"], {
      command: "zsh",
      env: cliEnv(chain, stub, { MANDIBLE_CLI_DIR: CLI_DIR }),
      inheritEnv: false,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("+");
    expect(result.stderr).not.toContain(MINTED_TOKEN);
    expect(chain.item("mandible-operator")?.secret).toBe(MINTED_TOKEN);
  });

  it("stores the token with a controlling terminal attached", async () => {
    // `security` collects a missing password with getpass(3), which opens
    // /dev/tty and ignores piped stdin, so a write protocol that works headless
    // can hang an operator's terminal. BSD `script` takes the command as
    // trailing argv; util-linux takes -c.
    const chain = keychain();
    const stub = await userDaemon({ slug: "mll", kind: "human" });
    const quoted = [CLI, ...mint("mll", "--store")].map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
    const scriptArgs = process.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", "-c", quoted]
      : ["-q", "-e", "-c", quoted, "/dev/null"];

    const output = await new Promise<{ status: number | null; text: string }>((resolve) => {
      const child = spawn("script", scriptArgs, { env: cliEnv(chain, stub), stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.stderr.on("data", (chunk) => { text += chunk; });
      child.on("close", (status) => resolve({ status, text }));
    });

    expect(output.status, output.text).toBe(0);
    expect(output.text).not.toContain("password");
    expect(output.text).not.toContain(MINTED_TOKEN);
    expect(chain.item("mandible-operator")?.secret).toBe(MINTED_TOKEN);
  });
});

function securityStub(store: string, log: string): string {
  return `#!/usr/bin/env bash
set -u
STORE=${JSON.stringify(store)}
LOG=${JSON.stringify(log)}
ITEMS="$STORE/items"
mkdir -p "$ITEMS"
printf '%s\\n' "$*" >> "$LOG"

next_index() {
  local last
  last="$(ls "$ITEMS" 2>/dev/null | sort | tail -n 1)"
  if [ -z "$last" ]; then printf '001'; else printf '%03d' "$((10#$last + 1))"; fi
}

# Echo the path of the oldest item matching a service and, when given, account.
find_item() {
  local svc="$1" acct="$2" name file
  for name in $(ls "$ITEMS" 2>/dev/null | sort); do
    file="$ITEMS/$name"
    [ "$(sed -n 1p "$file")" = "$svc" ] || continue
    if [ -n "$acct" ] && [ "$(sed -n 2p "$file")" != "$acct" ]; then continue; fi
    printf '%s' "$file"
    return 0
  done
  return 1
}

write_item() {
  local svc="$1" acct="$2" secret="$3" file
  if file="$(find_item "$svc" "$acct")"; then
    printf '%s\\n%s\\n%s\\n' "$svc" "$acct" "$secret" > "$file"
  else
    printf '%s\\n%s\\n%s\\n' "$svc" "$acct" "$secret" > "$ITEMS/$(next_index)"
  fi
}

handle() {
  local cmd="\${1:-}"
  shift || true
  local svc="" acct="" inline="" update=0 have_w=0 file
  while [ $# -gt 0 ]; do
    case "$1" in
      -s) svc="\${2:-}"; shift 2 ;;
      -a) acct="\${2:-}"; shift 2 ;;
      -U) update=1; shift ;;
      -w)
        have_w=1
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
      if [ "$have_w" -eq 0 ] && [ "\${MANDIBLE_TEST_SECURITY_FAIL:-}" = "attributes" ]; then
        printf 'stub: simulated keychain failure\\n' >&2
        return 1
      fi
      file="$(find_item "$svc" "$acct")" || return 44
      if [ "$have_w" -eq 1 ]; then
        sed -n 3p "$file"
      else
        printf '    "acct"<blob>="%s"\\n    "svce"<blob>="%s"\\n' \\
          "$(sed -n 2p "$file")" "$(sed -n 1p "$file")"
      fi
      ;;
    add-generic-password)
      if [ -z "$inline" ]; then
        printf 'stub: refusing the interactive getpass protocol\\n' >&2
        return 1
      fi
      if [ -n "\${MANDIBLE_TEST_SECURITY_SHADOW:-}" ]; then
        if ! find_item "$svc" "\$MANDIBLE_TEST_SECURITY_SHADOW" >/dev/null; then
          write_item "$svc" "\$MANDIBLE_TEST_SECURITY_SHADOW" "shadow-token"
        fi
      fi
      if find_item "$svc" "$acct" >/dev/null && [ "$update" -eq 0 ]; then return 45; fi
      write_item "$svc" "$acct" "$inline"
      ;;
    *) return 1 ;;
  esac
}

# security's batch-line parser: whitespace separates, '"' quotes, backslash
# escapes inside quotes.
parse_line() {
  local line="$1" i=0 n=\${#line} ch cur="" quoted=0 started=0 esc=0
  ARGS=()
  while [ $i -lt $n ]; do
    ch="\${line:$i:1}"
    i=$((i + 1))
    if [ $esc -eq 1 ]; then cur="$cur$ch"; esc=0; continue; fi
    if [ "$ch" = "\\\\" ]; then
      if [ $quoted -eq 1 ]; then esc=1; else cur="$cur$ch"; fi
      continue
    fi
    case "$ch" in
      '"') if [ $quoted -eq 1 ]; then quoted=0; else quoted=1; started=1; fi ;;
      ' ')
        if [ $quoted -eq 1 ]; then
          cur="$cur$ch"
        elif [ -n "$cur" ] || [ $started -eq 1 ]; then
          ARGS+=("$cur"); cur=""; started=0
        fi
        ;;
      *) cur="$cur$ch" ;;
    esac
  done
  if [ -n "$cur" ] || [ $started -eq 1 ]; then ARGS+=("$cur"); fi
}

if [ "\${1:-}" = "-i" ]; then
  rc=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    parse_line "$line"
    handle "\${ARGS[@]}" || rc=$?
  done
  exit $rc
fi

handle "$@"
exit $?
`;
}
