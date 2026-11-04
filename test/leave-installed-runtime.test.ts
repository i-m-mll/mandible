// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerEnvironment } from "../src/conversation-control/structured-process.js";

const installed = {
  MANDIBLE_INSTALLED_KEYS: "MANDIBLE_RELEASE_ROOT MANDIBLE_RUNTIME MANDIBLE_SQLITE_LIBRARY",
  MANDIBLE_RELEASE_ROOT: "/App/Contents/Resources",
  MANDIBLE_RUNTIME: "/App/Contents/MacOS/mandible-bun",
  MANDIBLE_SQLITE_LIBRARY: "/App/Contents/Frameworks/libsqlite3.dylib",
  PATH: "/App/Contents/MacOS:/App/Contents/Resources/bin:/usr/bin:/bin:/opt/homebrew/bin",
};
const callerPath = "/App/Contents/Resources/bin:/usr/bin:/bin:/opt/homebrew/bin";
const selectors = Object.keys(installed).filter((key) => key !== "PATH");

describe("processes launched from an installed Mandible", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("identity exec hands its command the caller's environment", () => {
    const result = spawnSync("/bin/zsh", [path.resolve("cli/main.zsh"), "identity", "exec", "--", "/usr/bin/env"], {
      env: { ...process.env, ...installed, MANDIBLE_SESSION_ID: "" }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines.filter((line) => selectors.includes(line.split("=")[0]))).toEqual([]);
    expect(lines).toContain(`PATH=${callerPath}`);
  });

  it("provider launches omit the runtime selection and keep the public command", () => {
    for (const [key, value] of Object.entries(installed)) vi.stubEnv(key, value);
    const env = providerEnvironment();
    expect(selectors.filter((key) => key in env)).toEqual([]);
    expect(env.PATH).toBe(callerPath);
  });
});
