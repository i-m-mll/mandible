import { waitUntil } from "./helpers/wait-until.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI API route coverage", () => {
  it("removes tracked token-bearing temporary files on TERM", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-cli-cleanup-"));
    const trackedPath = path.join(tempDir, "spool-token.request.json.tmp");
    const helperPath = path.join(process.cwd(), "cli", "api.sh");
    try {
      const result = spawnSync(
        "zsh",
        [
          "-c",
          'source "$API_HELPER_PATH"; printf secret > "$TRACKED_PATH"; '
            + 'api_track_temp "$TRACKED_PATH"; kill -TERM $$',
        ],
        {
          env: {
            ...process.env,
            API_HELPER_PATH: helperPath,
            TRACKED_PATH: trackedPath,
            TMPDIR: tempDir,
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(143);
      expect(fs.existsSync(trackedPath)).toBe(false);
      expect(
        fs.readdirSync(tempDir).filter((entry) => entry.startsWith("mandible-api.")),
      ).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("privatizes and removes the real published file-RPC request on interrupt", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-rpc-signal-"));
    const spoolDir = path.join(tempDir, "spool");
    const child = spawn(
      "zsh",
      [
        "-c",
        'source "$API_HELPER_PATH"; output=$(api_temp_file); '
          + 'api_file_rpc_exchange POST /api/test "{}" "$output" >/dev/null',
      ],
      {
        env: {
          ...process.env,
          API_HELPER_PATH: path.join(process.cwd(), "cli", "api.sh"),
          MANDIBLE_BASE: `file://${spoolDir}`,
          MANDIBLE_TOKEN: "file-rpc-secret",
          CODEX_THREAD_ID: "",
          CODEX_SESSION_ID: "",
          CLAUDE_CODE_SESSION_ID: "",
          CLAUDE_SESSION_ID: "",
          GEMINI_SESSION_ID: "",
          MANDIBLE_MANAGED_CLIENT: "",
          MANDIBLE_SESSION_ID: "",
          MANDIBLE_FILE_RPC_TIMEOUT: "30",
          TMPDIR: tempDir,
        },
        stdio: "ignore",
      },
    );
    try {
      const requestPath = await waitForFile(spoolDir, ".request.json");
      expect(fs.statSync(spoolDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(requestPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(requestPath, "utf8")).toContain("file-rpc-secret");

      child.kill("SIGTERM");
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      expect(exitCode).toBe(143);
      expect(fs.existsSync(requestPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForFile(dir: string, suffix: string): Promise<string> {
  const match = await waitUntil(
    () => fs.existsSync(dir) && fs.readdirSync(dir).find((entry) => entry.endsWith(suffix)),
    `${suffix} in ${dir}`, 20);
  return path.join(dir, match);
}
