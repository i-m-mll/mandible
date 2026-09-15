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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-session-cutover-"));
  roots.add(root);
  const configPath = path.join(root, "Caddyfile");
  const metadataPath = path.join(root, "metadata.json");
  const currentDbPath = path.join(root, "current.db");
  const oldDb = path.join(root, "old.db");
  const candidateDb = path.join(root, "candidate.db");
  fs.writeFileSync(oldDb, "old");
  fs.writeFileSync(candidateDb, "candidate");
  fs.writeFileSync(metadataPath, `${JSON.stringify({ daemon: "legacy" })}\n`);
  fs.symlinkSync(oldDb, currentDbPath);

  const instances = (["main", "preview"] as const).map((role, index) => {
    const credentialDirectory = path.join(root, role, "client-auth");
    fs.mkdirSync(credentialDirectory, { recursive: true });
    const backendPort = 29420 + index;
    const publicPort = 19420 + index;
    const pidFile = path.join(root, `${role}.pid`);
    const instanceId = role === "main" ? "production" : "preview-existing";
    const publicOrigin = role === "main" ? "https://app.mandible.localhost:19420" : "https://preview-existing.mandible.localhost:19421";
    return {
      role,
      public_port: publicPort,
      legacy: {
        credential_directory: credentialDirectory,
        expected: {
          role,
          startup_epoch: `legacy-${role}`,
          startup_commit_hash: `legacy-commit-${role}`,
          instance_id: instanceId,
          installation_id: "authority-test",
          public_origin: publicOrigin,
          backend_generation: `legacy-${role}`,
          db_path: role === "preview" ? oldDb : path.join(root, "production.db"),
        },
        restore: { command: "/usr/bin/true", args: [], env: { MANDIBLE_INSTANCE_ROLE: role } },
      },
      candidate: {
        backend_port: backendPort,
        instance_id: instanceId,
        credential_directory: credentialDirectory,
        commit: `candidate-${role}`,
        process: {
          command: process.execPath,
          args: ["stand-in.js"],
          cwd: root,
          env: {
            PATH: process.env.PATH,
            MANDIBLE_PORT: String(backendPort),
            MANDIBLE_DB: role === "preview" ? candidateDb : path.join(root, "production.db"),
            MANDIBLE_PID_FILE: pidFile,
            MANDIBLE_INSTANCE_ROLE: role,
            MANDIBLE_INSTANCE_ID: instanceId,
            MANDIBLE_INSTALLATION_ID: "authority-test",
            MANDIBLE_PUBLIC_ORIGIN: publicOrigin,
            MANDIBLE_CLIENT_AUTH_DIR: credentialDirectory,
            MANDIBLE_BACKEND_GENERATION: `candidate-${role}`,
            MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(role === "main" ? ["ledger:read", "ledger:write"] : ["ledger:read", "files:preview"]),
            MANDIBLE_WRITABLE_ROOTS: JSON.stringify(role === "main" ? [] : [root]),
            ...(role === "preview" ? { MANDIBLE_PREVIEW_ROOT: root } : {}),
          },
        },
      },
    };
  });
  fs.writeFileSync(instances[0].candidate.process.env.MANDIBLE_DB, "production");

  const authorityDb = path.join(root, "sessions.db");
  const authority = new Database(authorityDb);
  authority.exec(`CREATE TABLE instance_registrations (
    instance_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, role TEXT NOT NULL,
    public_origin TEXT NOT NULL UNIQUE, backend_origin TEXT NOT NULL,
    backend_generation TEXT NOT NULL, effect_ceiling_json TEXT NOT NULL,
    writable_roots_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  authority.prepare(`INSERT INTO instance_registrations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "production", "authority-test", "main", "https://app.mandible.localhost:19420",
    "http://127.0.0.1:0", "legacy-main", "[]", "[]", 7,
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
    rollback_files: [metadataPath, currentDbPath, configPath],
    preview_promotion: {
      metadata_path: metadataPath,
      current_db_path: currentDbPath,
      current_db_target: candidateDb,
      metadata: {
        daemon: "candidate",
        port: instances[1].candidate.backend_port,
        db: candidateDb,
        pidFile: instances[1].candidate.process.env.MANDIBLE_PID_FILE,
        previewRoot: root,
        instanceEnv: instances[1].candidate.process.env,
      },
    },
  };
  const manifestPath = path.join(root, "manifest.json");
  const journalPath = path.join(root, "journal.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, configPath, metadataPath, currentDbPath, oldDb, candidateDb, authorityDb, manifest, manifestPath, journalPath };
}

function lifecycle(fx: ReturnType<typeof fixture>) {
  type Listener = { pid: number; fingerprint: string; kind: "legacy" | "candidate" | "gateway"; role?: "main" | "preview"; mode?: "migration" | "normal"; epoch?: string };
  const listeners = new Map<number, Listener>();
  const intentProcesses = new Map<string, Listener>();
  const events: string[] = [];
  let nextPid = 100;
  let interruptAfterStartRole: string | null = null;
  let interruptBeforeBindRole: string | null = null;
  let interruptAfterNextStop = false;
  let failReloadOnce = false;
  for (const instance of fx.manifest.instances) listeners.set(instance.public_port, { pid: ++nextPid, fingerprint: `process-${nextPid}`, kind: "legacy", role: instance.role, epoch: instance.legacy.expected.startup_epoch });

  const candidateHealth = (instance: (typeof fx.manifest.instances)[number], mode: "migration" | "normal") => ({
    ready: true,
    warm: true,
    startup_epoch: `${mode}-${instance.role}`,
    startup_commit: { hash: instance.candidate.commit },
    instance: {
      role: instance.role,
      instance_id: instance.candidate.instance_id,
      installation_id: "authority-test",
      public_origin: instance.candidate.process.env.MANDIBLE_PUBLIC_ORIGIN,
      backend_generation: instance.candidate.process.env.MANDIBLE_BACKEND_GENERATION,
      allowed_effects: JSON.parse(instance.candidate.process.env.MANDIBLE_ALLOWED_EFFECTS),
      writable_roots: JSON.parse(instance.candidate.process.env.MANDIBLE_WRITABLE_ROOTS),
      db_path: instance.candidate.process.env.MANDIBLE_DB,
    },
    client_auth: { credential_directory: instance.candidate.credential_directory, legacy_conversion: mode === "migration" },
  });

  const health = async (port: number) => {
    const listener = listeners.get(port);
    if (!listener) return null;
    const instance = fx.manifest.instances.find((entry) => entry.public_port === port || entry.candidate.backend_port === port)!;
    if (listener.kind === "legacy") return {
      ready: true,
      warm: true,
      startup_epoch: listener.epoch,
      startup_commit: { hash: `legacy-commit-${instance.role}` },
      instance: {
        role: listener.role,
        instance_id: instance.candidate.instance_id,
        installation_id: instance.legacy.expected.installation_id,
        public_origin: instance.legacy.expected.public_origin,
        backend_generation: instance.legacy.expected.backend_generation,
        db_path: instance.legacy.expected.db_path,
      },
    };
    return candidateHealth(instance, listener.mode ?? "migration");
  };

  return {
    events,
    listeners,
    interruptAfter(role: string) { interruptAfterStartRole = role; },
    interruptBeforeBind(role: string) { interruptBeforeBindRole = role; },
    interruptNextStop() { interruptAfterNextStop = true; },
    failNextReload() { failReloadOnce = true; },
    effects: {
      health,
      waitHealth: async (port: number) => {
        if (!listeners.has(port)) {
          const instance = fx.manifest.instances.find((entry) => entry.candidate.backend_port === port);
          const pending = [...intentProcesses.entries()].find(([, process]) => process.role === instance?.role);
          if (pending && instance) {
            listeners.set(port, pending[1]);
            intentProcesses.delete(pending[0]);
          }
        }
        return health(port);
      },
      discoverListener: async (port: number) => {
        const listener = listeners.get(port);
        return listener ? { pid: listener.pid, fingerprint: listener.fingerprint } : null;
      },
      discoverIntentProcess: async (token: string) => {
        const process = intentProcesses.get(token);
        return process ? { pid: process.pid, fingerprint: process.fingerprint } : null;
      },
      matchesProcess: () => true,
      portOpen: async (port: number) => listeners.has(port),
      waitPort: async (port: number) => { if (!listeners.has(port)) throw new Error(`missing listener ${port}`); },
      validateGateway: () => undefined,
      configureGateway: (_gateway: unknown, mode: "migration" | "normal") => fs.writeFileSync(fx.configPath, mode === "migration" ? "{\n skip_install_trust\n}\n/api/client-auth/legacy-conversion/complete\n" : "{\n skip_install_trust\n}\nnormal\n"),
      reloadGateway: () => { if (failReloadOnce) { failReloadOnce = false; throw new Error("reload failed"); } },
      startProcess: async (spec: { env?: Record<string, string> }, overlay: Record<string, string>) => {
        const role = spec.env?.MANDIBLE_INSTANCE_ROLE as "main" | "preview" | undefined;
        const pid = ++nextPid;
        if (role) {
          const instance = fx.manifest.instances.find((entry) => entry.role === role)!;
          const mode = overlay.MANDIBLE_LEGACY_CONVERSION === "allow" ? "migration" : "normal";
          const candidate = { pid, fingerprint: `process-${pid}`, kind: "candidate" as const, role, mode };
          events.push(`start:${role}:${mode}`);
          if (interruptBeforeBindRole === role) {
            interruptBeforeBindRole = null;
            intentProcesses.set(overlay.MANDIBLE_CUTOVER_INTENT, candidate);
            const error = new Error("simulated pre-bind interruption") as Error & { cutoverInterruption: boolean };
            error.cutoverInterruption = true;
            throw error;
          }
          listeners.set(instance.candidate.backend_port, candidate);
          if (interruptAfterStartRole === role) {
            interruptAfterStartRole = null;
            const error = new Error("simulated process interruption") as Error & { cutoverInterruption: boolean };
            error.cutoverInterruption = true;
            throw error;
          }
        } else {
          const gateway = { pid, fingerprint: `process-${pid}`, kind: "gateway" as const };
          for (const instance of fx.manifest.instances) listeners.set(instance.public_port, gateway);
          events.push("start:gateway");
        }
      },
      stopPid: async (pid: number, fingerprint: string) => {
        events.push(`stop:${pid}`);
        for (const [port, listener] of listeners) if (listener.pid === pid && listener.fingerprint === fingerprint) listeners.delete(port);
        for (const [token, process] of intentProcesses) if (process.pid === pid && process.fingerprint === fingerprint) intentProcesses.delete(token);
        if (interruptAfterNextStop) {
          interruptAfterNextStop = false;
          const error = new Error("simulated stop interruption") as Error & { cutoverInterruption: boolean };
          error.cutoverInterruption = true;
          throw error;
        }
      },
      startControl: async (control: { env: { MANDIBLE_INSTANCE_ROLE: "main" | "preview" } }) => {
        const role = control.env.MANDIBLE_INSTANCE_ROLE;
        const instance = fx.manifest.instances.find((entry) => entry.role === role)!;
        const pid = ++nextPid;
        listeners.set(instance.public_port, { pid, fingerprint: `process-${pid}`, kind: "legacy", role, epoch: `restored-${role}-${pid}` });
        events.push(`restore:${role}`);
      },
    },
  };
}

function registration(fx: ReturnType<typeof fixture>, instanceId: string) {
  const db = new Database(fx.authorityDb, { readonly: true });
  try { return db.prepare("SELECT * FROM instance_registrations WHERE instance_id = ?").get(instanceId); }
  finally { db.close(); }
}

describe("local session first cutover", () => {
  it("journals registration custody before CAS staging and restores the exact prior rows", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    const prepared = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(prepared.runtime.intents["registrations.stage"].status).toBe("done");
    expect(prepared.registrations.find((entry: { instance_id: string }) => entry.instance_id === "production").before).toMatchObject({ backend_origin: "http://127.0.0.1:0", updated_at: 7 });
    expect(registration(fx, "production")).toMatchObject({ backend_origin: "http://127.0.0.1:29420" });
    await runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects);
    expect(registration(fx, "production")).toMatchObject({ backend_origin: "http://127.0.0.1:0", updated_at: 7 });
    expect(registration(fx, "preview-existing")).toBeUndefined();
  });

  it("fails closed instead of overwriting registration drift during rollback", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    const db = new Database(fx.authorityDb);
    db.prepare("UPDATE instance_registrations SET backend_generation = ? WHERE instance_id = ?").run("external-drift", "production");
    db.close();
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).rejects.toThrow("Registration CAS drift");
    expect(registration(fx, "production")).toMatchObject({ backend_generation: "external-drift" });
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8"))).toMatchObject({ state: "recovery_failed", recovery_direction: "rollback" });
  });

  it("reconciles stopped and started processes after write-ahead intents without repeating effects", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptNextStop();
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated stop interruption");
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).runtime.intents["legacy.main.stop"].status).toBe("pending");
    life.interruptBeforeBind("main");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated pre-bind interruption");
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).runtime.intents["candidate.main.migration.start"].status).toBe("pending");
    const active = await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    expect(active).toMatchObject({ state: "migration", gateway_mode: "migration" });
    expect(life.events.filter((event) => event === "stop:101")).toHaveLength(1);
    expect(life.events.filter((event) => event === "start:main:migration")).toHaveLength(1);
  });

  it("persists the forward-only boundary before reload and journals preview promotion", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    life.failNextReload();
    await expect(runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects)).rejects.toThrow("forward-only");
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8"))).toMatchObject({ state: "recovery_failed", recovery_direction: "forward", runtime: { gateway_mode: "normal_pending" } });
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).rejects.toThrow("forward-only");
    await runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects);
    const interruptedPromotion = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    interruptedPromotion.state = "normal_pending";
    interruptedPromotion.revision += 1;
    interruptedPromotion.runtime.intents["preview.promote"].status = "pending";
    fs.writeFileSync(fx.journalPath, JSON.stringify(interruptedPromotion));
    fs.writeFileSync(fx.metadataPath, `${JSON.stringify({ daemon: "legacy" })}\n`);
    fs.rmSync(fx.currentDbPath);
    fs.symlinkSync(fx.oldDb, fx.currentDbPath);
    const completed = await runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects);
    expect(completed).toMatchObject({ state: "complete", gateway_mode: "normal" });
    expect(JSON.parse(fs.readFileSync(fx.metadataPath, "utf8"))).toEqual(fx.manifest.preview_promotion.metadata);
    expect(fs.realpathSync(fx.currentDbPath)).toBe(fs.realpathSync(fx.candidateDb));
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).runtime.intents["preview.promote"].status).toBe("done");
  });

  it("restores stable legacy facts with a new startup epoch and resumes rolling_back", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptAfter("main");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow();
    const journal = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    journal.state = "rolling_back";
    journal.revision += 1;
    fs.writeFileSync(fx.journalPath, JSON.stringify(journal));
    const rolledBack = await runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects);
    expect(rolledBack.state).toBe("rolled_back");
    const finalJournal = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(finalJournal.legacy.main.restored_epoch).toMatch(/^restored-main-/);
    expect(finalJournal.legacy.main.restored_epoch).not.toBe("legacy-main");
  });
});
