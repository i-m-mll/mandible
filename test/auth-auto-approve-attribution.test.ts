import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { openDb, type Db } from "../src/db.js";
import { setupOperator } from "../src/users/store.js";

describe("delegated signing attribution persistence", () => {
  let tempDir: string;
  let db: Db;
  let originalPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-delegated-attribution-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    setupOperator(db, { slug: "delegated-operator", display_name: "Delegated Operator" }, 1);
    originalPath = process.env.PATH;
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    writeTool(binDir, "ssh-keygen", `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      if (args.includes("-lf")) {
        process.stdout.write("256 SHA256:${"A".repeat(43)} delegated (ED25519)\\n");
      } else {
        const target = args[args.indexOf("-f") + 1];
        fs.writeFileSync(target, "private-key");
        fs.writeFileSync(target + ".pub", "ssh-ed25519 AAAATEST delegated");
      }
    `);
    writeTool(binDir, "age", `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        if (args.includes("--decrypt")) process.stdout.write(input);
        else fs.writeFileSync(args[args.indexOf("-o") + 1], input);
      });
    `);
    writeTool(binDir, "age-plugin-yubikey", `
      if (process.argv.includes("--identity")) process.stdout.write("AGE-PLUGIN-YUBIKEY-IDENTITY\\n");
    `);
    writeTool(binDir, "ssh-agent", `
      process.stdout.write("SSH_AUTH_SOCK=/tmp/mandible-test-agent.sock; export SSH_AUTH_SOCK;\\n");
      process.stdout.write("SSH_AGENT_PID=999999; export SSH_AGENT_PID;\\n");
    `);
    writeTool(binDir, "ssh-add", `process.stdin.resume();`);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers public credentials and persists the freshly authorized lease", async () => {
    const manager = new AuthAutoApproveManager({
      db,
      configDir: path.join(tempDir, "delegated-signing"),
      now: () => 10_000,
      broadcast: () => undefined,
    });
    await manager.setupDelegatedSigning({ ageRecipient: "age1yubikeytest", overwrite: true });
    const enabled = await manager.enable(1);

    const credentials = db.prepare(
      `SELECT type, fingerprint, user_id, status
       FROM user_credentials
       WHERE type IN ('delegated_ssh_key', 'yubikey_recipient')
       ORDER BY type`,
    ).all() as Array<{ type: string; fingerprint: string; user_id: string; status: string }>;
    expect(credentials).toEqual([
      expect.objectContaining({ type: "delegated_ssh_key", fingerprint: `SHA256:${"A".repeat(43)}`, status: "active" }),
      expect.objectContaining({ type: "yubikey_recipient", fingerprint: "age1yubikeytest", status: "active" }),
    ]);
    expect(
      db.prepare(
        `SELECT id, owner_user_id, credential_id, minted_at, expires_at, mint_method
         FROM delegated_signing_leases WHERE id = ?`,
      ).get(enabled.lease_id),
    ).toEqual(expect.objectContaining({
      id: enabled.lease_id,
      owner_user_id: credentials[0].user_id,
      credential_id: expect.any(String),
      minted_at: 10_000,
      expires_at: 70_000,
      mint_method: "fresh_presence",
    }));
    manager.disable("test_complete");
  });
});

function writeTool(binDir: string, name: string, body: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body.trim()}\n`, { mode: 0o755 });
}
