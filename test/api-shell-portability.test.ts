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
