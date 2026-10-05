import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
// Issue e2cb93f — the secret-backend seam in cli/api.sh and the one-command
// provisioning flow `mandible user token mint <ref> --store`.
//
// Every test stubs the keychain tool (via MANDIBLE_SECURITY_BIN) and `uname`,
// so nothing here reads or writes the developer machine's real keychain, and
// the macOS-only backend is exercised on a Linux CI runner too.

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
let securityStub = "";
let server: http.Server | null = null;
let authHeaders: string[] = [];
let requestAuth: Array<{ method: string; url: string; auth: string }> = [];

/**
 * A fake keychain tool with the fidelity these tests need. Items are stored one
 * per file under `<store>/items/NNN` as `<service>\n<account>\n<secret>`, with
 * NNN increasing by creation order, so:
 *   - items are keyed by (service, account), and several may share a service;
 *   - a service-only lookup resolves to the OLDEST match, which is what the
 *     real keychain was observed to do;
 *   - a lookup that matches nothing exits 44, the status the real tool uses for
 *     item-not-found and which the seam distinguishes from operational errors.
 *
 * It understands argv invocations and `-i` batch mode, applying security's
 * batch quoting rules (`"` delimits, `\` escapes inside quotes).
 *
 * Injectable behavior, via the environment:
 *   - MANDIBLE_TEST_SECURITY_FAIL=attributes — attribute reads fail with an
 *     operational error (exit 1), never 44.
 *   - MANDIBLE_TEST_SECURITY_SHADOW=<account> — before writing, insert an older
 *     competing item for the same service under <account>, simulating a writer
 *     that raced us and now wins service-only resolution.
 *
 * Two behaviors are deliberate regression guards: every invocation's argv is
 * appended to argvLog so tests can assert no secret reaches a process argument
 * list, and `add-generic-password` with no inline value (the getpass/tty
 * protocol) is refused outright, so reverting to "pipe the password to -w"
 * fails the suite on every platform, not only under a controlling terminal.
 */
function writeSecurityStub(): void {
  securityStub = path.join(stubDir, "security");
  fs.writeFileSync(
    securityStub,
    `#!/usr/bin/env bash
set -u
STORE=${JSON.stringify(storeDir)}
LOG=${JSON.stringify(argvLog)}
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
`,
    { mode: 0o755 },
  );
}

/** A `uname` stub so the Darwin-gated backend is testable on any CI runner. */
function writeUnameStub(kernel: "Darwin" | "Linux"): void {
  fs.writeFileSync(
    path.join(stubDir, "uname"),
    `#!/usr/bin/env bash\nif [[ \"$1\" == \"-s\" ]]; then printf '${kernel}\\n'; else /usr/bin/uname \"$@\"; fi\n`,
    { mode: 0o755 },
  );
}

interface StoredItem {
  service: string;
  account: string;
  secret: string;
}

/** Every item in the stub store, oldest first. */
function storedItems(): StoredItem[] {
  const itemsDir = path.join(storeDir, "items");
  if (!fs.existsSync(itemsDir)) return [];
  return fs
    .readdirSync(itemsDir)
    .sort()
    .map((name) => {
      const [service = "", account = "", secret = ""] = fs
        .readFileSync(path.join(itemsDir, name), "utf8")
        .split("\n");
      return { service, account, secret };
    });
}

/**
 * The item a lookup resolves to: with an account, that exact item; without one,
 * the oldest item for the service — the ambient readers' lookup.
 */
function storedItem(service: string, account?: string): StoredItem | null {
  return (
    storedItems().find(
      (item) => item.service === service && (account === undefined || item.account === account),
    ) ?? null
  );
}

function seedItem(service: string, account: string, secret: string): void {
  const itemsDir = path.join(storeDir, "items");
  fs.mkdirSync(itemsDir, { recursive: true });
  const next = String(fs.readdirSync(itemsDir).length + 1).padStart(3, "0");
  fs.writeFileSync(path.join(itemsDir, next), `${service}\n${account}\n${secret}\n`);
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    MANDIBLE_RUNTIME: process.execPath,
    GIT_OPTIONAL_LOCKS: "0",
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    HOME: homeDir,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    MANDIBLE_SECURITY_BIN: securityStub,
    ...extra,
  };
}

beforeEach(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-secret-stub-"));
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-secret-store-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-secret-home-"));
  argvLog = path.join(stubDir, "argv.log");
  fs.writeFileSync(argvLog, "");
  authHeaders = [];
  requestAuth = [];
  writeSecurityStub();
  writeUnameStub("Darwin");
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
  shellFlags: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const full = [`source ${JSON.stringify(API_HELPER)}`, script].join("\n");
  const result = spawnSync(shell, [...shellFlags, "-c", full], {
    encoding: "utf8",
    env: baseEnv(env),
  });
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
        service: "mandible-agent-test",
        account: "acct-1",
        secret: "tok-round-trip",
      });

      const read = runSeam(shell, "secret_get mandible-agent-test acct-1");
      expect(read.status, read.stderr).toBe(0);
      expect(read.stdout).toBe("tok-round-trip");
    });

    it(`writes through batch mode, never argv, under ${shell}`, () => {
      const written = runSeam(
        shell,
        'printf %s "tok-not-in-argv" | secret_set mandible-agent-test acct-1',
      );
      expect(written.status, written.stderr).toBe(0);

      const argv = fs.readFileSync(argvLog, "utf8");
      // The password must appear in no process argument list at all…
      expect(argv).not.toContain("tok-not-in-argv");
      // …because the write went through `security -i`, whose argv is just -i.
      expect(argv.split("\n")).toContain("-i");
      expect(argv).not.toContain("add-generic-password");
    });

    it(`keys reads and writes on service+account under ${shell}`, () => {
      const written = runSeam(shell, 'printf %s "acct-1-token" | secret_set svc-shared acct-1');
      expect(written.status, written.stderr).toBe(0);

      // Right account resolves; wrong account does not.
      expect(runSeam(shell, "secret_get svc-shared acct-1").stdout).toBe("acct-1-token");
      const wrong = runSeam(shell, 'secret_get svc-shared acct-2; printf "rc=%s" "$?"');
      expect(wrong.stdout).toBe("rc=1");
      // The service-only lookup the ambient readers use still resolves.
      expect(runSeam(shell, "secret_get svc-shared").stdout).toBe("acct-1-token");
      // And the account behind a service-only lookup is discoverable.
      expect(runSeam(shell, "secret_account_for_service svc-shared").stdout).toBe("acct-1");
    });

    it(`resolves a service-only lookup to the oldest item under ${shell}`, () => {
      // Two items share a service. The ambient readers pass no account, so the
      // answer must be the same one the real keychain gives: the older item.
      seedItem("svc-multi", "older", "older-token");
      seedItem("svc-multi", "newer", "newer-token");

      expect(runSeam(shell, "secret_get svc-multi").stdout).toBe("older-token");
      expect(runSeam(shell, "secret_get svc-multi newer").stdout).toBe("newer-token");
      expect(runSeam(shell, "secret_account_for_service svc-multi").stdout).toBe("older");
    });

    it(`separates item-absent from an unreadable keychain under ${shell}`, () => {
      seedItem("svc-present", "acct-1", "token");

      const present = runSeam(shell, 'secret_account_for_service svc-present; printf "rc=%s" "$?"');
      expect(present.stdout).toBe("acct-1rc=0");

      // Nothing there: the backend's not-found status, reported as rc 1.
      const absent = runSeam(shell, 'secret_account_for_service svc-absent; printf "rc=%s" "$?"');
      expect(absent.stdout).toBe("rc=1");

      // Operational failure: never reported as absence.
      const broken = runSeam(
        shell,
        'secret_account_for_service svc-present; printf "rc=%s" "$?"',
        { MANDIBLE_TEST_SECURITY_FAIL: "attributes" },
      );
      expect(broken.stdout).toBe("rc=3");
    });

    it(`refuses multi-line stdin instead of storing the first line under ${shell}`, () => {
      const multiline = runSeam(
        shell,
        'printf "first\\nsecond\\n" | secret_set svc-multiline acct-1; printf "rc=%s" "$?"',
      );
      expect(multiline.stdout).toBe("rc=2");
      expect(storedItem("svc-multiline")).toBeNull();

      // A single trailing newline is still fine.
      const single = runSeam(
        shell,
        'printf "only\\n" | secret_set svc-multiline acct-1; printf "rc=%s" "$?"',
      );
      expect(single.stdout).toBe("rc=0");
      expect(storedItem("svc-multiline")?.secret).toBe("only");
    });

    // Byte-exact fixtures, written by the test rather than through shell
    // printf, whose NUL handling differs per shell. Piped in with `cat` so the
    // stream is non-seekable, which is the seam's calling convention.
    //
    // Every position a NUL can occupy is covered. A TERMINAL NUL is the case
    // neither the value nor the leftover count can see — it is swallowed as
    // read's delimiter, so `tok\0` looks like a clean `tok` with nothing left
    // over — which is why the refusal is driven by the read status itself.
    const nulCases: Array<{ name: string; bytes: number[] }> = [
      { name: "a single terminal NUL", bytes: [0x74, 0x6f, 0x6b, 0x00] },
      { name: "a terminal NUL after the newline", bytes: [0x74, 0x6f, 0x6b, 0x0a, 0x00] },
      { name: "a leading NUL", bytes: [0x00, 0x74, 0x6f, 0x6b, 0x0a] },
      { name: "a NUL inside the line", bytes: [0x74, 0x00, 0x6f, 0x6b, 0x0a] },
      { name: "NUL bytes after the line", bytes: [0x74, 0x6f, 0x6b, 0x0a, 0x00, 0x00] },
      { name: "NUL bytes with no trailing newline", bytes: [0x74, 0x6f, 0x6b, 0x00, 0x00] },
      { name: "NUL-only input", bytes: [0x00] },
    ];
    for (const { name, bytes } of nulCases) {
      it(`refuses ${name} under ${shell}`, () => {
        const fixture = path.join(stubDir, `nul-${bytes.join("-")}`);
        fs.writeFileSync(fixture, Buffer.from(bytes));

        const result = runSeam(
          shell,
          `cat ${JSON.stringify(fixture)} | secret_set svc-nul acct-1; printf "rc=%s" "$?"`,
        );
        expect(result.stdout).toBe("rc=2");
        expect(storedItem("svc-nul")).toBeNull();
      });
    }

    it(`refuses entirely empty stdin under ${shell}`, () => {
      const result = runSeam(
        shell,
        'secret_set svc-empty acct-1 < /dev/null; printf "rc=%s" "$?"',
      );
      expect(result.stdout).toBe("rc=2");
      expect(storedItem("svc-empty")).toBeNull();
    });

    it(`fails closed when the leftover-byte count cannot be taken under ${shell}`, () => {
      // A broken or missing counter must never be read as "nothing left". The
      // stub shadows `wc` on PATH for this call only.
      const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-broken-wc-"));
      try {
        fs.writeFileSync(
          path.join(brokenDir, "wc"),
          "#!/usr/bin/env bash\nprintf 'wc: simulated failure\\n' >&2\nexit 1\n",
          { mode: 0o755 },
        );
        const result = runSeam(
          shell,
          'printf %s "tok" | secret_set svc-nowc acct-1; printf "rc=%s" "$?"',
          { PATH: `${brokenDir}:${stubDir}:${process.env.PATH ?? ""}` },
        );
        expect(result.stdout).toBe("rc=2");
        expect(storedItem("svc-nowc")).toBeNull();
      } finally {
        fs.rmSync(brokenDir, { recursive: true, force: true });
      }
    });

    it(`round-trips values that need batch-line quoting under ${shell}`, () => {
      const awkward = 'has"quote\\slash and space';
      const written = runSeam(
        shell,
        `printf %s ${JSON.stringify(awkward)} | secret_set svc-quoting acct-1`,
      );
      expect(written.status, written.stderr).toBe(0);
      expect(storedItem("svc-quoting")?.secret).toBe(awkward);
    });

    it(`refuses material the backend cannot store faithfully under ${shell}`, () => {
      // Tab (control character) and non-ASCII: `security` stores these as hex
      // rather than the original bytes, so the seam rejects them (exit 2).
      const tabbed = runSeam(
        shell,
        'printf "a\\tb" | secret_set svc-bad acct-1; printf "rc=%s" "$?"',
      );
      expect(tabbed.stdout).toBe("rc=2");
      const unicode = runSeam(
        shell,
        'printf %s "café" | secret_set svc-bad acct-1; printf "rc=%s" "$?"',
      );
      expect(unicode.stdout).toBe("rc=2");
      const badService = runSeam(
        shell,
        'printf %s "tok" | secret_set "svc-bad-$(printf \'\\t\')" acct-1; printf "rc=%s" "$?"',
      );
      expect(badService.stdout).toBe("rc=2");
      expect(storedItem("svc-bad")).toBeNull();
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
      writeUnameStub("Linux");
      const available = runSeam(shell, 'secret_backend_available; printf "rc=%s" "$?"');
      expect(available.stdout).toBe("rc=1");

      const reason = runSeam(shell, "secret_backend_unavailable_reason");
      expect(reason.stdout).toContain("no secret backend available on this platform");
      expect(reason.stdout).toContain("Linux");
      expect(reason.stdout).toContain("e2cb93f");

      const written = runSeam(
        shell,
        'printf %s "tok" | secret_set mandible-agent-test acct-1; printf "rc=%s" "$?"',
      );
      expect(written.stdout).toBe("rc=1");
      expect(storedItem("mandible-agent-test")).toBeNull();
    });

    it(`suppresses and restores xtrace around secret handling under ${shell}`, () => {
      // The value is piped in from a file with `cat`, so the traced caller line
      // itself carries no secret and anything that shows up in the trace came
      // from inside the seam.
      const valueFile = path.join(stubDir, "trace-input");
      fs.writeFileSync(valueFile, "xtrace-secret");
      const result = runSeam(
        shell,
        [
          `cat ${JSON.stringify(valueFile)} | secret_set svc-trace acct-1`,
          "secret_get svc-trace acct-1 >/dev/null",
          "echo marker-after-restore >/dev/null",
        ].join("\n"),
        {},
        ["-x"],
      );
      expect(result.status, result.stderr).toBe(0);
      expect(storedItem("svc-trace")?.secret).toBe("xtrace-secret");
      // The secret never appears in the trace…
      expect(result.stderr).not.toContain("xtrace-secret");
      // …but tracing is still on afterwards, so the guard restored it.
      expect(result.stderr).toContain("marker-after-restore");
    });

    it(`never echoes the operator token through a real request under ${shell}`, async () => {
      // The ambient-reader call chain end to end, under -x: api_client_token →
      // api_keychain_operator_token → secret_get, then the bearer token written
      // into curl's config file. A callee cannot protect its caller (the shell
      // prints `token=<value>` for a command substitution after it returns), so
      // this must be exercised through the real call sites, not by capturing a
      // token-printing function from a test script.
      seedItem("mandible-operator", "mll", "captured-operator-token");
      const port = await startUserServer({ slug: "mll", kind: "human" }, []);

      const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(
          shell,
          ["-x", path.join(process.cwd(), "cli", "user.sh"), "list"],
          {
            cwd: process.cwd(),
            env: {
              ...cliEnv(port),
              MANDIBLE_CLI_DIR: path.join(process.cwd(), "cli"),
              // Keychain reads on: this test is about the reader path.
              MANDIBLE_NO_KEYCHAIN_TOKEN: "",
            },
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => resolve({ status, stderr }));
      });

      expect(result.status).toBe(0);
      // The keychain token really was resolved and sent…
      expect(authHeaders).toContain("Bearer captured-operator-token");
      // …and never appeared in the trace.
      expect(result.stderr).not.toContain("captured-operator-token");
      expect(result.stderr).toContain("+"); // tracing really was on
    }, 20_000);

    it(`never exports an agent token from wrap.sh under ${shell}`, async () => {
      // A stored credential must stay outside the wrapped agent's environment,
      // including under xtrace.
      seedItem("mandible-agent-claude", "claude-code", "wrapped-agent-token");
      const port = await startUserServer({ slug: "claude-code", kind: "agent" }, []);

      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(
            shell,
            [
              "-x",
              path.join(process.cwd(), "cli", "wrap.sh"),
              "--app",
              "claude",
              "--id",
              "secret-store-test-session",
              "--",
              "/bin/sh",
              "-c",
              'printf "token=%s managed=%s" "${MANDIBLE_TOKEN-unset}" "$MANDIBLE_MANAGED_CLIENT"',
            ],
            { cwd: process.cwd(), env: { ...cliEnv(port), MANDIBLE_NO_KEYCHAIN_TOKEN: "" } },
          );
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
        },
      );

      expect(result.stdout).toContain("token=unset managed=1");
      expect(result.stderr).not.toContain("wrapped-agent-token");
    }, 20_000);
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
    writeUnameStub("Linux");
    const noBackend = runSeam("bash", 'api_keychain_operator_token; printf "rc=%s" "$?"');
    expect(noBackend.stdout).toBe("rc=0");
    expect(noBackend.stderr).toBe("");
  });

  it("creates token-bearing temp files as 0600 inside a 0700 root", () => {
    const result = runSeam(
      "bash",
      'f="$(api_temp_file)"; printf "file="; stat -f "%Lp" "$f" 2>/dev/null || stat -c "%a" "$f"; '
        + 'printf "root="; stat -f "%Lp" "$MANDIBLE_API_TEMP_ROOT" 2>/dev/null '
        + '|| stat -c "%a" "$MANDIBLE_API_TEMP_ROOT"',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("file=600");
    expect(result.stdout).toContain("root=700");
  });
});

interface FakeUser {
  slug: string;
  kind: string;
  appNames?: string[];
  whoamiAuthenticated?: boolean;
}

const MINTED_TOKEN = "mandible_pat_test-token-value";
const MAIN_INSTANCE_RESPONSE = MAIN_CLI_INSTANCE_RESPONSE;

async function startUserServer(user: FakeUser, requests: string[]): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/instance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MAIN_INSTANCE_RESPONSE));
      return;
    }
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization) authHeaders.push(req.headers.authorization);
    requestAuth.push({
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization ?? "",
    });
    if (req.method === "GET" && req.url === "/api/client-auth/whoami") {
      const authenticated = user.whoamiAuthenticated !== false && Boolean(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        authenticated,
        user: authenticated ? { id: `user-${user.slug}`, slug: user.slug, kind: user.kind } : null,
      }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/users") && !req.url.startsWith("/api/users/")) {
      // The list route, used by the reader-path trace test.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ users: [] }));
      return;
    }
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

function cliEnv(port: number): NodeJS.ProcessEnv {
  return baseEnv({
    MANDIBLE_BASE: `http://127.0.0.1:${port}`,
    MANDIBLE_PORT: String(port),
    MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
    // Reads are opted out so the stub is exercised only by the explicit --store
    // write; MANDIBLE_NO_KEYCHAIN_TOKEN governs token reads, not provisioning.
    MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
  });
}

function runCli(
  args: string[],
  port: number,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { cwd: process.cwd(), env: { ...cliEnv(port), ...env } });
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

describe("direct CLI agent credential resolution", () => {
  function userListRequest() {
    return requestAuth.find((request) => request.method === "GET" && request.url === "/api/users");
  }

  it("loads the Codex Keychain credential for a direct CODEX_SESSION_ID invocation", async () => {
    seedItem("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    const port = await startUserServer({ slug: "codex-agent", kind: "agent" }, []);

    const result = await runCli(["user", "list", "--json"], port, {
      CODEX_SESSION_ID: "codex-session",
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(userListRequest()?.auth).toBe("Bearer codex-keychain-token");
    expect(fs.readFileSync(argvLog, "utf8")).not.toContain("codex-keychain-token");
  });

  it("uses CODEX_SESSION_ID for the shared ambient provider and session identity", () => {
    const resolved = runSeam(
      "bash",
      'printf "%s|%s" "$(api_ambient_provider)" "$(api_ambient_session_id)"',
      { CODEX_SESSION_ID: "codex-session" },
    );
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.stdout).toBe("codex|codex-session");
  });

  it("accepts duplicate markers for one provider and rejects cross-provider ambiguity", async () => {
    seedItem("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    seedItem("mandible-operator", "mll", "operator-token");
    let port = await startUserServer({ slug: "codex-agent", kind: "agent" }, []);

    let result = await runCli(["user", "list", "--json"], port, {
      CODEX_THREAD_ID: "thread-id",
      CODEX_SESSION_ID: "thread-id",
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(userListRequest()?.auth).toBe("Bearer codex-keychain-token");

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    requestAuth = [];
    port = await startUserServer({ slug: "codex-agent", kind: "agent" }, []);
    result = await runCli(["user", "list", "--json"], port, {
      CODEX_THREAD_ID: "thread-id",
      CLAUDE_SESSION_ID: "claude-id",
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(userListRequest()?.auth).toBe("");
  });

  it("preserves a verified inherited agent token without reading the Keychain secret", async () => {
    seedItem("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    const port = await startUserServer({ slug: "codex-agent", kind: "agent" }, []);

    const result = await runCli(["user", "list", "--json"], port, {
      CODEX_THREAD_ID: "thread-id",
      MANDIBLE_TOKEN: "inherited-agent-token",
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(requestAuth.find((request) => request.url === "/api/client-auth/whoami")?.auth)
      .toBe("Bearer inherited-agent-token");
    expect(userListRequest()?.auth).toBe("Bearer inherited-agent-token");
    expect(fs.readFileSync(argvLog, "utf8")).not.toContain(" -w");
  });

  it.each([
    ["human", { slug: "mll", kind: "human" }],
    ["mismatched", { slug: "other-agent", kind: "agent" }],
    ["invalid", { slug: "codex-agent", kind: "agent", whoamiAuthenticated: false }],
  ] as const)("rejects inherited %s identity without Keychain or operator fallback", async (_case, user) => {
    seedItem("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    seedItem("mandible-operator", "mll", "operator-token");
    const port = await startUserServer(user, []);

    const result = await runCli(["user", "list", "--json"], port, {
      CODEX_THREAD_ID: "thread-id",
      MANDIBLE_TOKEN: "rejected-inherited-token",
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(userListRequest()?.auth).toBe("");
    expect(result.stderr).toContain("ignoring inherited MANDIBLE_TOKEN");
    expect(result.stderr).not.toContain("rejected-inherited-token");
    expect(result.stderr).not.toContain("codex-keychain-token");
    expect(result.stderr).not.toContain("operator-token");
  });

  it("rejects an inherited token when identity verification is unavailable", () => {
    seedItem("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    const result = runSeam("bash", "api_client_token GET", {
      CODEX_SESSION_ID: "codex-session",
      MANDIBLE_TOKEN: "unavailable-inherited-token",
      MANDIBLE_BASE: "http://127.0.0.1:1",
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ignoring inherited MANDIBLE_TOKEN");
    expect(result.stderr).not.toContain("unavailable-inherited-token");
    expect(result.stderr).not.toContain("codex-keychain-token");
  });

  it.each(["missing", "locked"])("does not use operator credentials when the agent Keychain item is %s", async (state) => {
    seedItem("mandible-operator", "mll", "operator-token");
    const port = await startUserServer({ slug: "codex-agent", kind: "agent" }, []);

    const result = await runCli(["user", "list", "--json"], port, {
      CODEX_SESSION_ID: "codex-session",
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
      MANDIBLE_TEST_SECURITY_FAIL: state === "locked" ? "attributes" : "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(userListRequest()?.auth).toBe("");
  });

  it("preserves operator Keychain behavior in an unmarked human shell", async () => {
    seedItem("mandible-operator", "mll", "operator-token");
    const port = await startUserServer({ slug: "mll", kind: "human" }, []);

    const result = await runCli(["user", "list", "--json"], port, {
      MANDIBLE_NO_KEYCHAIN_TOKEN: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(userListRequest()?.auth).toBe("Bearer operator-token");
  });

  it.each(["", "inherited-agent-token"])("does not project %s agent credentials into file transport", (inherited) => {
    seedItem("mandible-agent-codex", "codex-agent", "codex-keychain-token");
    const result = runSeam(
      "bash",
      'api_client_token POST; printf "|source=%s" "$API_CLIENT_CREDENTIAL_SOURCE"',
      {
        CODEX_SESSION_ID: "codex-session",
        MANDIBLE_BASE: `file://${path.join(homeDir, "spool")}`,
        MANDIBLE_TOKEN: inherited,
        MANDIBLE_NO_KEYCHAIN_TOKEN: "",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("|source=");
    if (inherited) expect(result.stderr).not.toContain(inherited);
  });
});

/**
 * Run the CLI with a controlling terminal. `security` collects a missing
 * password with getpass(3), which opens /dev/tty and ignores piped stdin — a
 * write protocol that works headless can hang for an operator in a terminal, so
 * the provisioning flow is exercised under a real PTY as well.
 */
function runCliWithPty(
  args: string[],
  port: number,
): Promise<{ status: number | null; output: string; timedOut: boolean }> {
  const quoted = [CLI, ...args].map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
  // BSD `script` takes the command as trailing argv; util-linux takes -c.
  const scriptArgs =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", "-c", quoted]
      : ["-q", "-e", "-c", quoted, "/dev/null"];
  // Async spawn, never spawnSync: the fake daemon runs on this process's event
  // loop, and a synchronous child would block it and starve its own request.
  return new Promise((resolve) => {
    const child = spawn("script", scriptArgs, {
      env: cliEnv(port),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output, timedOut });
    });
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
      service: "mandible-agent-claude",
      account: "claude-code",
      secret: MINTED_TOKEN,
    });
    expect(fs.readFileSync(argvLog, "utf8")).not.toContain(MINTED_TOKEN);
  });

  it("never echoes the token when the CLI itself runs under xtrace", async () => {
    const port = await startUserServer({ slug: "mll", kind: "human" }, []);
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(
        "zsh",
        ["-x", path.join(process.cwd(), "cli", "user.sh"), "token", "mint", "mll", "--store"],
        {
          cwd: process.cwd(),
          env: { ...cliEnv(port), MANDIBLE_CLI_DIR: path.join(process.cwd(), "cli") },
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stderr }));
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("+"); // tracing really was on
    expect(result.stderr).not.toContain(MINTED_TOKEN);
    expect(storedItem("mandible-operator")?.secret).toBe(MINTED_TOKEN);
  });

  it(
    "stores the token with a controlling terminal attached",
    async () => {
      // Regression guard for the getpass()/tty write protocol: with a PTY
      // present the write must still complete without prompting or hanging.
      const port = await startUserServer({ slug: "mll", kind: "human" }, []);
      const result = await runCliWithPty(["user", "token", "mint", "mll", "--store"], port);

      expect(result.timedOut, `PTY run timed out:\n${result.output}`).toBe(false);
      expect(result.status, result.output).toBe(0);
      expect(result.output).not.toContain("password");
      expect(result.output).not.toContain(MINTED_TOKEN);
      expect(result.output).toContain("service: mandible-operator");
      expect(storedItem("mandible-operator")?.secret).toBe(MINTED_TOKEN);
    },
    30_000,
  );

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

  it("refuses to shadow an item held by a different account", async () => {
    // The ambient readers look this service up without an account, so writing a
    // second item would leave them on the older token.
    seedItem("mandible-operator", "someone-else", "previous-token");
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(["user", "token", "mint", "mll", "--store"], port);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("someone-else");
    expect(result.stderr).toContain("mll");
    expect(result.stderr).toContain("--service");
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false);
    expect(storedItem("mandible-operator")?.secret).toBe("previous-token");
  });

  it("fails closed when the existing item cannot be read", async () => {
    // An unreadable keychain must never be mistaken for an empty one: that is
    // how a shadowing item gets created.
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(CLI, ["user", "token", "mint", "mll", "--store"], {
        cwd: process.cwd(),
        env: { ...cliEnv(port), MANDIBLE_TEST_SECURITY_FAIL: "attributes" },
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stderr }));
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not read the existing secret-store item");
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false);
    expect(storedItems()).toEqual([]);
  });

  it("reports when a racing writer shadows the item it just stored", async () => {
    // The pre-write check passes (nothing there yet), then a competing older
    // item appears at write time and wins service-only resolution.
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(CLI, ["user", "token", "mint", "mll", "--store"], {
          cwd: process.cwd(),
          env: { ...cliEnv(port), MANDIBLE_TEST_SECURITY_SHADOW: "intruder" },
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
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("credential-1");
    expect(result.stderr).toContain("intruder");
    expect(result.stderr).toContain("mll");
    expect(result.stderr).not.toContain(MINTED_TOKEN);
    // The write itself did happen — the failure being reported is that ambient
    // readers would resolve to the shadowing item instead.
    expect(storedItem("mandible-operator", "mll")?.secret).toBe(MINTED_TOKEN);
    expect(storedItem("mandible-operator")?.account).toBe("intruder");
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

  it("rejects an empty --service", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(
      ["user", "token", "mint", "mll", "--store", "--service", "  "],
      port,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--service must name a service");
    expect(requests).toEqual([]);
  });

  it("rejects a --service the backend cannot store faithfully, before minting", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(
      ["user", "token", "mint", "mll", "--store", "--service", "mandible\toperator"],
      port,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("printable ASCII");
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false);
  });

  it("refuses to guess a service name for an agent with no app_name binding", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "gemini", kind: "agent" }, requests);

    const result = await runCli(["user", "token", "mint", "gemini", "--store"], port);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no active app_name binding");
    expect(result.stderr).toContain("--service");
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false);
  });

  it("refuses to guess a service name for a non-human, non-agent user", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "system", kind: "system" }, requests);

    const result = await runCli(["user", "token", "mint", "system", "--store"], port);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("user kind 'system'");
    expect(result.stderr).toContain("--service");
    expect(requests.some((entry) => entry.startsWith("POST"))).toBe(false);
  });

  it("fails before minting when no secret backend is available", async () => {
    const requests: string[] = [];
    const port = await startUserServer({ slug: "mll", kind: "human" }, requests);

    const result = await runCli(["user", "token", "mint", "mll", "--store"], port, {
      MANDIBLE_SECURITY_BIN: path.join(stubDir, "missing-security"),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("keychain tool is missing");
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
    expect(result.stderr).toContain("Arguments do not match");
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
