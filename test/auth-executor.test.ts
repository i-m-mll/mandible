import { describe, expect, it } from "vitest";

import { executeAuthCommand } from "../src/auth-executor.js";

describe("executeAuthCommand", () => {
  it("strips ambient agent signing overrides and exposes the request id", async () => {
    const originalEnv = {
      CLAUDECODE: process.env.CLAUDECODE,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };

    process.env.CLAUDECODE = "1";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.signingkey";
    process.env.GIT_CONFIG_VALUE_0 = "/tmp/agent-key.pub";

    try {
      const result = await executeAuthCommand({
        request_id: "req-test-1",
        command: [
          "node",
          "-e",
          JSON.stringify(
            "console.log(JSON.stringify({ requestId: process.env.MANDIBLE_AUTH_REQUEST_ID, claude: process.env.CLAUDECODE ?? null, count: process.env.GIT_CONFIG_COUNT ?? null, key0: process.env.GIT_CONFIG_KEY_0 ?? null, value0: process.env.GIT_CONFIG_VALUE_0 ?? null }))"
          ),
        ].join(" "),
        now: () => 1000,
        timeoutMs: 5000,
      });

      expect(result.exit_code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        requestId: "req-test-1",
        claude: null,
        count: null,
        key0: null,
        value0: null,
      });
    } finally {
      restoreEnv("CLAUDECODE", originalEnv.CLAUDECODE);
      restoreEnv("GIT_CONFIG_COUNT", originalEnv.GIT_CONFIG_COUNT);
      restoreEnv("GIT_CONFIG_KEY_0", originalEnv.GIT_CONFIG_KEY_0);
      restoreEnv("GIT_CONFIG_VALUE_0", originalEnv.GIT_CONFIG_VALUE_0);
    }
  });

  it("streams start and process output chunks", async () => {
    const chunks: Array<{ stream: string; text: string; timestamp: number }> = [];
    const result = await executeAuthCommand({
      request_id: "req-test-2",
      command: "printf stdout-line && >&2 printf stderr-line",
      now: () => 1234,
      timeoutMs: 5000,
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("stdout-line");
    expect(result.stderr).toBe("stderr-line");
    expect(chunks[0]).toMatchObject({
      request_id: "req-test-2",
      stream: "stdout",
      timestamp: 1234,
    });
    expect(chunks[0].text).toContain("Executing merge command");
    expect(chunks.slice(1)).toEqual([
      { request_id: "req-test-2", stream: "stdout", text: "stdout-line", timestamp: 1234 },
      { request_id: "req-test-2", stream: "stderr", text: "stderr-line", timestamp: 1234 },
    ]);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
