import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const API_HELPER = path.join(process.cwd(), "cli", "api.sh");

describe("sourced API shell portability", () => {
  for (const shell of ["bash", "zsh"]) {
    it(`matches generated route templates under ${shell}`, () => {
      const script = [
        `source ${JSON.stringify(API_HELPER)}`,
        'api_route_template_matches "/api/artifacts/bundles/:id/members" "/api/artifacts/bundles/bundle-1/members"',
        '! api_route_template_matches "/api/artifacts/bundles/:id/members" "/api/artifacts/bundles//members"',
        '! api_route_template_matches "/api/artifacts/:id" "/api/artifacts/one/extra"',
      ].join("\n");
      const result = spawnSync(shell, ["-c", script], { encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    });
  }
});

// Issue a9ede3c defect 2: the operator bootstrap token is a one-shot enrollment
// proof, not a read credential. api_client_token must not attach it to GET
// requests (any unmarked background poller would otherwise consume the key on
// sight), but must still attach it to mutations and honor an explicit
// MANDIBLE_TOKEN on every method.
describe("api_client_token bootstrap attachment by method", () => {
  let configDir = "";

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-api-token-"));
    fs.mkdirSync(path.join(configDir, "client-auth"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "client-auth", "bootstrap-token"), "bootstrap-proof\n");
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function runToken(
    method: string,
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string } {
    const script = [
      `source ${JSON.stringify(API_HELPER)}`,
      `api_client_token ${JSON.stringify(method)}`,
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        MANDIBLE_CONFIG_DIR: configDir,
        // These cases exercise the bootstrap-vs-GET behavior only; disable the
        // keychain fallback so they never depend on (or read) the developer
        // machine's real `mandible-operator` keychain item.
        MANDIBLE_NO_KEYCHAIN_TOKEN: "1",
        ...env,
      },
    });
    return { status: result.status, stdout: result.stdout };
  }

  it("does not attach the bootstrap file to GET requests", () => {
    const { status, stdout } = runToken("GET");
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("attaches the bootstrap file to mutating requests", () => {
    const { status, stdout } = runToken("POST");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bootstrap-proof");
  });

  it("attaches the bootstrap file when no method is passed (direct enrollment callers)", () => {
    const { status, stdout } = runToken("");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bootstrap-proof");
  });

  it("still honors an explicit MANDIBLE_TOKEN on GET requests", () => {
    const { status, stdout } = runToken("GET", { MANDIBLE_TOKEN: "explicit-token" });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("explicit-token");
  });
});

// Issue 9283a50: the durable `mandible-operator` keychain credential lets a
// plain operator terminal act as the operator with zero setup. Unlike the
// one-shot bootstrap proof it behaves like an explicit token — it attaches on
// every method, GET included — but it is still fenced off managed agents by the
// same marker guard and honors the MANDIBLE_NO_KEYCHAIN_TOKEN opt-out. These
// tests stub the keychain binary (MANDIBLE_SECURITY_BIN, issue e2cb93f) and
// `uname`, so they never touch the real keychain and still exercise the
// Darwin-gated backend on a Linux CI runner.
describe("api_client_token keychain operator fallback", () => {
  const KEYCHAIN_TOKEN = "keychain-operator-token";
  let stubDir = "";
  let securityStub = "";
  let configDir = "";

  beforeEach(() => {
    // A stub keychain tool that only answers for service `mandible-operator`.
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-security-stub-"));
    securityStub = path.join(stubDir, "security");
    fs.writeFileSync(
      securityStub,
      [
        "#!/usr/bin/env bash",
        "for arg in \"$@\"; do",
        `  if [[ "$arg" == "mandible-operator" ]]; then`,
        `    printf '%s\\n' ${JSON.stringify(KEYCHAIN_TOKEN)}`,
        "    exit 0",
        "  fi",
        "done",
        "exit 44",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(stubDir, "uname"),
      "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n",
      { mode: 0o755 },
    );

    // A config dir with a bootstrap-token present, so keychain-before-bootstrap
    // ordering is genuinely exercised (keychain must win over this file).
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-keychain-cfg-"));
    fs.mkdirSync(path.join(configDir, "client-auth"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "client-auth", "bootstrap-token"), "bootstrap-proof\n");
  });

  afterEach(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function runToken(
    method: string,
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string } {
    const script = [
      `source ${JSON.stringify(API_HELPER)}`,
      `api_client_token ${JSON.stringify(method)}`,
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        MANDIBLE_SECURITY_BIN: securityStub,
        MANDIBLE_CONFIG_DIR: configDir,
        ...env,
      },
    });
    return { status: result.status, stdout: result.stdout };
  }

  it("uses the keychain token when unmarked and no env token (winning over bootstrap)", () => {
    const { status, stdout } = runToken("POST");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(KEYCHAIN_TOKEN);
  });

  it("attaches the keychain token to GET requests, unlike the bootstrap proof", () => {
    const { status, stdout } = runToken("GET");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(KEYCHAIN_TOKEN);
  });

  it("suppresses the keychain token for managed agents (marker guard)", () => {
    for (const marker of [
      "MANDIBLE_MANAGED_CLIENT",
      "CODEX_THREAD_ID",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_SESSION_ID",
      "MANDIBLE_SESSION_ID",
    ]) {
      // A marked GET must yield nothing: keychain is suppressed and the
      // bootstrap proof never attaches on GET.
      const { status, stdout } = runToken("GET", { [marker]: "x" });
      expect(status, `marker ${marker}`).toBe(0);
      expect(stdout, `marker ${marker}`).toBe("");
    }
  });

  it("suppresses the keychain token when MANDIBLE_NO_KEYCHAIN_TOKEN=1", () => {
    // Opted out on GET: keychain suppressed, bootstrap never attaches on GET.
    const { status, stdout } = runToken("GET", { MANDIBLE_NO_KEYCHAIN_TOKEN: "1" });
    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("falls back to the bootstrap proof on mutations when keychain is opted out", () => {
    // With keychain disabled, an unmarked mutation still gets the bootstrap file.
    const { status, stdout } = runToken("POST", { MANDIBLE_NO_KEYCHAIN_TOKEN: "1" });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bootstrap-proof");
  });

  it("honors an explicit MANDIBLE_TOKEN over the keychain credential", () => {
    const { status, stdout } = runToken("POST", { MANDIBLE_TOKEN: "explicit-token" });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("explicit-token");
  });
});
