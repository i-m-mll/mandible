// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AuthCommandCleanupError, executeAuthCommand } from "../src/auth-executor.js";

describe("executeAuthCommand", () => {
  it("joins the spawned command when the synthetic start callback throws", async () => {
    const realKill = process.kill.bind(process);
    let ownedGroup: number | undefined;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === "SIGTERM") ownedGroup = -pid;
      return realKill(pid, signal);
    });
    try {
      await expect(executeAuthCommand({
        request_id: "failed-start-output", command: "exec sleep 30",
        onOutput: () => { throw new Error("start consumer failed"); },
      })).rejects.toThrow("start consumer failed");
      expect(ownedGroup).toBeDefined();
      expect(processIsAlive(ownedGroup!)).toBe(false);
    } finally {
      kill.mockRestore();
      if (ownedGroup && processIsAlive(ownedGroup)) realKill(-ownedGroup, "SIGKILL");
    }
  });


  it("reports unresolved custody when process-group signaling is refused", async () => {
    const realKill = process.kill.bind(process);
    let ownedGroup: number | undefined;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === "SIGTERM") {
        ownedGroup = -pid;
        throw Object.assign(new Error("signal permission refused"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    try {
      const completed = executeAuthCommand({
        request_id: "refused-cleanup", command: "exec sleep 30", timeoutMs: 50,
      });
      await expect(completed).rejects.toBeInstanceOf(AuthCommandCleanupError);
      await expect(completed).rejects.toMatchObject({ processGroupSettled: false,
        cause: expect.objectContaining({ errors: expect.arrayContaining([
          expect.objectContaining({ message: "Auth command timed out after 0.05s" }),
        ]) }),
      });
      expect(ownedGroup).toBeDefined();
      expect(processIsAlive(ownedGroup!)).toBe(true);
    } finally {
      kill.mockRestore();
      if (ownedGroup) realKill(-ownedGroup, "SIGKILL");
    }
  });


  it("joins TERM-resistant descendants for timeout, output failure, and leader exit", async () => {
    const results = await Promise.allSettled((["timeout", "output", "leader-exit"] as const).map(async (trigger) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-lifetime-"));
      const leaderFile = path.join(root, "leader");
      const descendantFile = path.join(root, "descendant");
      const termFile = path.join(root, "term");
      const descendant = path.join(root, "descendant.cjs");
      const leader = path.join(root, "leader.cjs");
      fs.writeFileSync(descendant, `
        const fs = require('node:fs');
        process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termFile)}, 'received'));
        fs.writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid));
        setInterval(() => {}, 1000);
      `);
      fs.writeFileSync(leader, `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid));
        require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });
        const ready = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(descendantFile)})) return;
          clearInterval(ready);
          ${trigger === "leader-exit" ? "process.exit(7);" : "process.stdout.write('tree-ready'); setInterval(() => {}, 1000);"}
        }, 5);
      `);
      let sawReady = false;
      try {
        const completed = executeAuthCommand({
          request_id: "process-lifetime", command: `exec ${shellQuote(process.execPath)} ${shellQuote(leader)}`,
          timeoutMs: trigger === "timeout" ? 500 : 5000,
          onOutput: chunk => {
            if (chunk.text.includes("tree-ready")) {
              sawReady = true;
              if (trigger === "output") throw new Error("output consumer failed");
            }
          },
        });
        if (trigger === "leader-exit") expect(await completed).toMatchObject({ exit_code: 7 });
        else await expect(completed).rejects.toThrow(trigger === "timeout" ? "timed out" : "output consumer failed");
        if (trigger !== "leader-exit") expect(sawReady).toBe(true);
        expect(fs.existsSync(termFile)).toBe(true);
        for (const file of [leaderFile, descendantFile]) {
          const pid = Number(fs.readFileSync(file, "utf8"));
          expect(processIsAlive(pid), `owned process ${pid} still alive at settlement`).toBe(false);
        }
      } finally {
        for (const file of [leaderFile, descendantFile]) {
          if (fs.existsSync(file)) {
            const pid = Number(fs.readFileSync(file, "utf8"));
            if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
          }
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });


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
    expect(chunks.slice(1)).toEqual([
      { request_id: "req-test-2", stream: "stdout", text: "stdout-line", timestamp: 1234 },
      { request_id: "req-test-2", stream: "stderr", text: "stderr-line", timestamp: 1234 },
    ]);
  });

  // The digest-mismatch and unfetchable-message refusals of the loaded
  // message are asserted in auth-canonical-change-message.
  it("binds canonical merge dispatch to its own CLI despite a stale shim and loads the exact message under strict Bash", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-dispatch-"));
    const socket = path.join(root, "api.sock");
    const cli = path.resolve("cli");
    const seen: string[] = [];
    const message = "Merge bounded repair\n\nWhy: Qualify the executor read path.\n\nVerification:\nPrivate fixture.\n";
    const digest = createHash("sha256").update(message).digest("hex");
    const server = http.createServer((req, res) => {
      seen.push(req.url!); expect(req.headers.authorization).toBeUndefined();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ commit_message: message, commit_message_digest: digest }));
    });
    try {
      for (const name of ["src", "scripts", "bin", "stale", "old-checkout"]) fs.mkdirSync(path.join(root, name));
      fs.copyFileSync(path.resolve("src/auth-executor.ts"), path.join(root, "src/auth-executor.ts"));
      fs.copyFileSync(path.resolve("scripts/process-group-supervisor.mjs"), path.join(root, "scripts/process-group-supervisor.mjs"));
      fs.writeFileSync(path.join(root, "stale/mandible"), '#!/bin/bash\necho stale-shim-selected >&2\nexit 91\n', { mode: 0o700 });
      fs.writeFileSync(path.join(root, "bin/mandible"), [
        "#!/usr/bin/env bash", "set -euo pipefail",
        'printf "bound-cli=%s bash=%s args=%s\\n" "$0" "$BASH_VERSION" "$*" >&2',
        'export MANDIBLE_CLI_DIR="$QUALIFIED_CLI_DIR" MANDIBLE_AUTH_MERGE_SOURCE_ONLY=1',
        'source "$MANDIBLE_CLI_DIR/auth-merge.sh"',
        "load_canonical_change_message",
      ].join("\n") + "\n", { mode: 0o700 });
      await new Promise<void>(resolve => server.listen(socket, resolve));
      const { executeAuthCommand } = await import(/* @vite-ignore */ pathToFileURL(path.join(root, "src/auth-executor.ts")).href);
      const args = ["auth", "merge", "feature/qualified", "--into", "main", "--preserve-head-branch"];
      const options = {
        request_id: "read-only-request", command: `mandible ${args.join(" ")}`, mandibleArgs: args,
        cwd: path.join(root, "old-checkout"), timeoutMs: 5000,
        env: { ...process.env, HOME: root, BASH_ENV: "", QUALIFIED_CLI_DIR: cli,
          PATH: `${root}/stale:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
          MANDIBLE_BASE: "https://app.mandible.localhost:19420", MANDIBLE_TRANSPORT: "",
          MANDIBLE_SOCKET: socket, MANDIBLE_TOKEN: "must-not-travel-on-ordinary-read",
          MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: digest },
      };
      const result = await executeAuthCommand(options);
      expect(result.exit_code, result.stderr).toBe(0);
      expect(result.stderr).toContain(`bound-cli=${root}/bin/mandible`);
      expect(result.stderr).toContain(`args=${args.join(" ")}`);
      expect(result.stderr).toContain(digest);
      expect(result.stderr).not.toContain("stale-shim-selected");
      expect(seen).toEqual(["/api/auth/request/read-only-request"]);
      fs.rmSync(path.join(root, "bin/mandible"));
      await expect(executeAuthCommand(options)).rejects.toThrow("ENOENT");
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
