// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runCutoverCommand } from "../scripts/local-session-cutover.mjs";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-session-cutover-")); roots.add(root);
  const configPath = path.join(root, "Caddyfile");
  const rollbackPath = path.join(root, "metadata.json");
  fs.writeFileSync(rollbackPath, "legacy metadata\n");
  const instances = (["main", "preview"] as const).map((role, index) => {
    const credentialDirectory = path.join(root, role, "client-auth");
    fs.mkdirSync(credentialDirectory, { recursive: true });
    const backendPort = 29420 + index;
    const publicPort = 19420 + index;
    return {
      role,
      public_port: publicPort,
      legacy: {
        credential_directory: credentialDirectory,
        expected: { role, startup_epoch: `legacy-${role}` },
        stop: { type: "command", command: "/usr/bin/true", args: [] },
        restore: { type: "command", command: "/usr/bin/true", args: [] },
      },
      candidate: {
        backend_port: backendPort,
        instance_id: role === "main" ? "production" : "preview-existing",
        credential_directory: credentialDirectory,
        process: {
          command: process.execPath,
          args: ["stand-in.js"],
          cwd: root,
          env: {
            PATH: process.env.PATH,
            MANDIBLE_PORT: String(backendPort),
            MANDIBLE_INSTANCE_ROLE: role,
            MANDIBLE_INSTANCE_ID: role === "main" ? "production" : "preview-existing",
            MANDIBLE_INSTALLATION_ID: "authority-test",
            MANDIBLE_PUBLIC_ORIGIN: role === "main"
              ? "https://app.mandible.localhost:19420"
              : "https://preview-existing.mandible.localhost:19421",
            MANDIBLE_CLIENT_AUTH_DIR: credentialDirectory,
            MANDIBLE_BACKEND_GENERATION: `candidate-${role}`,
            MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(role === "main" ? ["ledger:read", "ledger:write"] : ["ledger:read", "ledger:write", "files:preview"]),
            MANDIBLE_WRITABLE_ROOTS: JSON.stringify(role === "main" ? [] : [root]),
          },
        },
      },
    };
  });
  const authorityDb = path.join(root, "sessions.db");
  const authority = new Database(authorityDb);
  authority.exec(`CREATE TABLE instance_registrations (
    instance_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, role TEXT NOT NULL,
    public_origin TEXT NOT NULL UNIQUE, backend_origin TEXT NOT NULL,
    backend_generation TEXT NOT NULL, effect_ceiling_json TEXT NOT NULL,
    writable_roots_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  authority.prepare(`INSERT INTO instance_registrations (
    instance_id, installation_id, role, public_origin, backend_origin,
    backend_generation, effect_ceiling_json, writable_roots_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "production", "authority-test", "main", "https://app.mandible.localhost:19420",
    "http://127.0.0.1:0", "legacy-main", "[]", "[]", Date.now(),
  );
  authority.close();
  const manifest = {
    schema: "mandible-local-session-cutover@1",
    id: "cutover-test",
    authority_db: authorityDb,
    instances,
    gateway: {
      config_path: configPath,
      configure: { command: process.execPath, args: [], migration_args: ["migration"], normal_args: ["normal"] },
      process: { command: process.execPath, args: ["gateway.js"], cwd: root, env: { PATH: process.env.PATH } },
      reload: { command: "/usr/bin/true", args: [] },
    },
    rollback_files: [rollbackPath],
  };
  const manifestPath = path.join(root, "manifest.json");
  const journalPath = path.join(root, "journal.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, configPath, rollbackPath, manifest, manifestPath, journalPath };
}

function fakeEffects(fx: ReturnType<typeof fixture>, options: {
  failPreviewCandidate?: boolean;
  failRestore?: boolean;
  occupiedCandidatePort?: number;
} = {}) {
  const events: string[] = [];
  let sequence = 100;
  return {
    events,
    effects: {
      health: async (port: number) => {
        const instance = fx.manifest.instances.find((entry) => entry.public_port === port || entry.candidate.backend_port === port)!;
        const legacy = instance.public_port === port;
        return {
          ready: true,
          warm: true,
          ...(legacy ? { startup_epoch: instance.legacy.expected.startup_epoch } : {}),
          instance: { role: instance.role, instance_id: instance.candidate.instance_id },
          client_auth: {
            credential_directory: instance.candidate.credential_directory,
            legacy_conversion: true,
          },
        };
      },
      waitHealth: async (port: number, expected: Record<string, unknown>) => {
        events.push(`health:${port}:${expected.legacy_conversion ?? "legacy"}`);
        if (options.failPreviewCandidate && port === 29421) throw new Error("preview candidate failed");
      },
      portOpen: async (port: number) => port === options.occupiedCandidatePort,
      waitPort: async (port: number) => { events.push(`public:${port}`); },
      validateGateway: () => { events.push("gateway:validated"); },
      configureGateway: (_gateway: unknown, mode: "migration" | "normal") => {
        events.push(`gateway:configure:${mode}`);
        fs.writeFileSync(fx.configPath, mode === "migration"
          ? "{\n skip_install_trust\n}\n/api/client-auth/legacy-conversion/complete\n"
          : "{\n skip_install_trust\n}\nnormal\n");
      },
      reloadGateway: () => { events.push("gateway:reload"); },
      startProcess: async (spec: { env?: Record<string, string> }, overlay: Record<string, string>) => {
        events.push(`start:${spec.env?.MANDIBLE_INSTANCE_ROLE ?? "gateway"}:${overlay.MANDIBLE_LEGACY_CONVERSION ?? "normal"}`);
        return { launcher_pid: ++sequence, daemon_pid: spec.env?.MANDIBLE_INSTANCE_ROLE ? ++sequence : null };
      },
      controlIdentity: async (control: { command?: string }) => `control:${control.command ?? "pid"}`,
      stopControl: async (control: { type: string }) => { events.push(`stop-legacy:${control.type}`); },
      startControl: async (control: { type: string }) => {
        events.push(`restore-legacy:${control.type}`);
        if (options.failRestore) throw new Error("legacy restore failed");
      },
      stopPid: async (pid: number | null) => { events.push(`stop:${pid}`); },
    },
  };
}

describe("local session first cutover", () => {
  it("refuses an occupied candidate backend before stopping either legacy listener", async () => {
    const fx = fixture();
    const fake = fakeEffects(fx, { occupiedCandidatePort: 29421 });
    await expect(runCutoverCommand({
      command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath,
    }, fake.effects)).rejects.toThrow("Candidate preview backend port 29421 is occupied");
    expect(fake.events.some((entry) => entry.startsWith("stop-legacy:"))).toBe(false);
    expect(fs.existsSync(fx.journalPath)).toBe(false);
  });

  it("holds migration mode until an explicit browser-conversion confirmation", async () => {
    const fx = fixture();
    const fake = fakeEffects(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, fake.effects);
    const registrations = new Database(fx.manifest.authority_db, { readonly: true });
    expect(registrations.prepare("SELECT backend_origin FROM instance_registrations WHERE instance_id = ?")
      .get("production")).toEqual({ backend_origin: "http://127.0.0.1:29420" });
    registrations.close();
    const active = await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, fake.effects);
    expect(active).toMatchObject({ state: "migration", gateway_mode: "migration" });
    expect(fs.readFileSync(fx.configPath, "utf8")).toContain("legacy-conversion/complete");
    await expect(runCutoverCommand({ command: "complete", journal: fx.journalPath }, fake.effects))
      .rejects.toThrow("--confirm-browser-conversion");
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).state).toBe("migration");

    const complete = await runCutoverCommand({
      command: "complete", journal: fx.journalPath, confirmBrowserConversion: true,
    }, fake.effects);
    expect(complete).toMatchObject({ state: "complete", gateway_mode: "normal" });
    expect(fake.events).toContain("start:main:allow");
    expect(fake.events).toContain("start:preview:allow");
    expect(fake.events).toContain("start:main:normal");
    expect(fake.events).toContain("start:preview:normal");
  });

  it("restores rollback bytes and both old listeners when activation fails", async () => {
    const fx = fixture();
    const fake = fakeEffects(fx, { failPreviewCandidate: true });
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, fake.effects);
    fs.writeFileSync(fx.rollbackPath, "candidate metadata\n");
    await expect(runCutoverCommand({
      command: "activate", journal: fx.journalPath, confirmCaTrusted: true,
    }, fake.effects)).rejects.toThrow("legacy listeners were restored");
    expect(fs.readFileSync(fx.rollbackPath, "utf8")).toBe("legacy metadata\n");
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).state).toBe("rolled_back");
    expect(fake.events.filter((entry) => entry.startsWith("restore-legacy:"))).toHaveLength(2);
  });

  it("can roll back from a journal checkpoint left mid-activation", async () => {
    const fx = fixture();
    const fake = fakeEffects(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, fake.effects);
    const journal = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    journal.state = "activating";
    journal.revision += 1;
    journal.runtime = {
      stopped_roles: ["main"],
      candidates: { main: { launcher_pid: 201, daemon_pid: 202 } },
      gateway_pid: null,
      gateway_mode: null,
    };
    fs.writeFileSync(fx.journalPath, JSON.stringify(journal));
    fs.writeFileSync(fx.rollbackPath, "interrupted candidate metadata\n");

    const rolledBack = await runCutoverCommand({ command: "rollback", journal: fx.journalPath }, fake.effects);
    expect(rolledBack.state).toBe("rolled_back");
    expect(fs.readFileSync(fx.rollbackPath, "utf8")).toBe("legacy metadata\n");
    expect(fake.events).toContain("stop:202");
    expect(fake.events.filter((entry) => entry.startsWith("restore-legacy:"))).toHaveLength(1);
  });

  it("records a durable recovery failure when explicit rollback cannot restore legacy", async () => {
    const fx = fixture();
    const fake = fakeEffects(fx, { failRestore: true });
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, fake.effects);
    const journal = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    journal.state = "activating";
    journal.revision += 1;
    journal.runtime = {
      stopped_roles: ["main"], candidates: {}, gateway_pid: null, gateway_mode: null,
    };
    fs.writeFileSync(fx.journalPath, JSON.stringify(journal));

    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, fake.effects))
      .rejects.toThrow("Cutover rollback failed: legacy restore failed");
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8"))).toMatchObject({
      state: "recovery_failed",
      recovery_failure: "legacy restore failed",
    });
  });
});
