// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

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
    for (const name of ["src", "bin", "stale", "old-checkout"]) fs.mkdirSync(path.join(root, name));
    fs.copyFileSync(path.resolve("src/auth-executor.ts"), path.join(root, "src/auth-executor.ts"));
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
    const drifted = await executeAuthCommand({ ...options, env: { ...options.env, MANDIBLE_AUTH_CHANGE_MESSAGE_DIGEST: "0".repeat(64) } });
    expect(drifted.exit_code).not.toBe(0);
    expect(drifted.stderr).toContain("changed after approval");
    const failed = await executeAuthCommand({ ...options, env: { ...options.env, MANDIBLE_SOCKET: `${socket}.missing`, MANDIBLE_HTTP_RETRIES: "0" } });
    expect(failed.exit_code).not.toBe(0);
    expect(failed.stderr).toContain("could not be fetched; no ref or worktree was changed");
    fs.rmSync(path.join(root, "bin/mandible"));
    await expect(executeAuthCommand(options)).rejects.toThrow("ENOENT");
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
