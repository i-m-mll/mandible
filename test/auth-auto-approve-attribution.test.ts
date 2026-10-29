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
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-delegated-attribution-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    setupOperator(db, { slug: "delegated-operator", display_name: "Delegated Operator" }, 1);
    originalPath = process.env.PATH;
    binDir = path.join(tempDir, "bin");
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
    delete process.env.MANDIBLE_TEST_KILL_MARKER;
    delete process.env.MANDIBLE_TEST_KILL_ATTEMPTS;
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not seed settings when constructed for a read-only preview", () => {
    db.prepare(
      "DELETE FROM settings WHERE key = 'auth_auto_approve_duration_minutes'",
    ).run();

    new AuthAutoApproveManager({
      db,
      seedDefaultDurationSetting: false,
    });

    expect(db.prepare(
      "SELECT value FROM settings WHERE key = 'auth_auto_approve_duration_minutes'",
    ).get()).toBeUndefined();
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

  it("removes delegated signing files idempotently and reports the refreshed status", async () => {
    const configDir = path.join(tempDir, "delegated-signing");
    const events: unknown[] = [];
    const manager = new AuthAutoApproveManager({
      db,
      configDir,
      broadcast: (event) => events.push(event),
    });
    await manager.setupDelegatedSigning({ ageRecipient: "age1yubikeytest", overwrite: true });

    expect((await manager.removeDelegatedSigning()).signing.configured).toBe(false);
    expect((await manager.removeDelegatedSigning()).signing.configured).toBe(false);
    expect(fs.existsSync(path.join(configDir, "id_ed25519_mandible_delegated"))).toBe(false);
    expect(events).toHaveLength(2);
  });

  it("expires an enabled lease and awaits ssh-agent shutdown before removing files", async () => {
    const configDir = path.join(tempDir, "delegated-signing");
    const marker = path.join(tempDir, "agent-stopped");
    process.env.MANDIBLE_TEST_KILL_MARKER = marker;
    writeTool(binDir, "kill", `
      const fs = require("node:fs");
      setTimeout(() => fs.writeFileSync(process.env.MANDIBLE_TEST_KILL_MARKER, "stopped"), 40);
    `);
    const manager = new AuthAutoApproveManager({ db, configDir, broadcast: () => undefined });
    await manager.setupDelegatedSigning({ ageRecipient: "age1yubikeytest", overwrite: true });
    const enabled = await manager.enable(1);

    const removed = await manager.removeDelegatedSigning();

    expect(fs.readFileSync(marker, "utf8")).toBe("stopped");
    expect(removed).toMatchObject({ enabled: false, lease_id: null, signing: { configured: false } });
    const persisted = db.prepare(
      "SELECT expires_at FROM delegated_signing_leases WHERE id = ?",
    ).get(enabled.lease_id) as { expires_at: number };
    expect(persisted.expires_at).toBeLessThan(enabled.enabled_until!);
  });

  it("retains termination state and key files when shutdown fails, then removes on retry", async () => {
    const configDir = path.join(tempDir, "delegated-signing");
    const attemptsFile = path.join(tempDir, "kill-attempts");
    process.env.MANDIBLE_TEST_KILL_ATTEMPTS = attemptsFile;
    writeTool(binDir, "kill", `
      const fs = require("node:fs");
      const file = process.env.MANDIBLE_TEST_KILL_ATTEMPTS;
      const attempts = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
      fs.writeFileSync(file, String(attempts + 1));
      if (attempts === 0) {
        process.stderr.write("kill: operation not permitted\\n");
        process.exitCode = 2;
      }
    `);
    const manager = new AuthAutoApproveManager({ db, configDir, broadcast: () => undefined });
    await manager.setupDelegatedSigning({ ageRecipient: "age1yubikeytest", overwrite: true });
    const enabled = await manager.enable(1);

    await expect(manager.removeDelegatedSigning()).rejects.toThrow(/operation not permitted/);
    expect(manager.getStatus()).toMatchObject({
      enabled: false,
      lease_id: null,
      signing: { configured: true },
    });
    expect(fs.existsSync(path.join(configDir, "id_ed25519_mandible_delegated"))).toBe(true);
    const expired = db.prepare(
      "SELECT expires_at FROM delegated_signing_leases WHERE id = ?",
    ).get(enabled.lease_id) as { expires_at: number };
    expect(expired.expires_at).toBeLessThan(enabled.enabled_until!);

    const removed = await manager.removeDelegatedSigning();
    expect(removed).toMatchObject({ enabled: false, signing: { configured: false } });
    expect(fs.readFileSync(attemptsFile, "utf8")).toBe("2");
  });

  it("retains the active lease and key files when durable expiry fails, then removes on retry", async () => {
    const configDir = path.join(tempDir, "delegated-signing");
    const manager = new AuthAutoApproveManager({ db, configDir, broadcast: () => undefined });
    await manager.setupDelegatedSigning({ ageRecipient: "age1yubikeytest", overwrite: true });
    await manager.enable(1);
    db.exec(`
      CREATE TRIGGER fail_delegated_lease_expiry
      BEFORE UPDATE OF expires_at ON delegated_signing_leases
      BEGIN
        SELECT RAISE(ABORT, 'simulated expiry failure');
      END;
    `);

    await expect(manager.removeDelegatedSigning()).rejects.toThrow(/simulated expiry failure/);
    expect(manager.getStatus()).toMatchObject({ enabled: true, signing: { configured: true } });
    expect(fs.existsSync(path.join(configDir, "id_ed25519_mandible_delegated"))).toBe(true);

    db.exec("DROP TRIGGER fail_delegated_lease_expiry");
    expect((await manager.removeDelegatedSigning()).signing.configured).toBe(false);
  });

  it("treats an already-gone ssh-agent as successful removal", async () => {
    const configDir = path.join(tempDir, "delegated-signing");
    const manager = new AuthAutoApproveManager({ db, configDir, broadcast: () => undefined });
    await manager.setupDelegatedSigning({ ageRecipient: "age1yubikeytest", overwrite: true });
    await manager.enable(1);

    expect((await manager.removeDelegatedSigning()).signing.configured).toBe(false);
  });

  it("times out a delegated presence command without creating an active lease", async () => {
    const configDir = path.join(tempDir, "delegated-signing");
    const manager = new AuthAutoApproveManager({
      db,
      configDir,
      broadcast: () => undefined,
      presenceCommandTimeoutMs: 30,
    });
    await manager.setupDelegatedSigning({ ageRecipient: "age1yubikeytest", overwrite: true });
    writeTool(binDir, "age-plugin-yubikey", `setInterval(() => undefined, 1000);`);

    await expect(manager.enable(1)).rejects.toThrow(/timed out after 30ms/);
    expect(manager.getStatus()).toMatchObject({ enabled: false, lease_id: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM delegated_signing_leases").get())
      .toEqual({ count: 0 });
  });
});

function writeTool(binDir: string, name: string, body: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body.trim()}\n`, { mode: 0o755 });
}
