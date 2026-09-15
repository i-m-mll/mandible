// @vitest-environment node

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runCutoverCommand } from "../scripts/local-session-cutover.mjs";
import { LocalSessionAuthority } from "../src/client-auth/session-authority.js";
import { localCaPaths } from "../scripts/local-ca-trust.mjs";

const capturedLegacyHealth = JSON.parse(fs.readFileSync(new URL("./fixtures/local-session-legacy-health-9c742815.json", import.meta.url), "utf8"));

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function renderServicePlist(definition: { Label: string; KeepAlive: boolean; ProgramArguments: string[]; EnvironmentVariables: Record<string, string>; StandardOutPath: string; StandardErrorPath: string }) {
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(definition.Label)}</string><key>KeepAlive</key><true/><key>ProgramArguments</key><array>${definition.ProgramArguments.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${Object.entries(definition.EnvironmentVariables).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict><key>StandardOutPath</key><string>${xml(definition.StandardOutPath)}</string><key>StandardErrorPath</key><string>${xml(definition.StandardErrorPath)}</string></dict></plist>\n`;
}

function fixture({ supervisedMain = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-session-cutover-"));
  roots.add(root);
  const configPath = path.join(root, "Caddyfile");
  const metadataPath = path.join(root, "metadata.json");
  const currentDbPath = path.join(root, "current.db");
  const oldDb = path.join(root, "old.db");
  const candidateDb = path.join(root, "candidate.db");
  const servicePlistPath = path.join(root, "com.mll.mandible.plist");
  let serviceDefinition = { Label: "com.mll.mandible", KeepAlive: true, ProgramArguments: [process.execPath, path.join(root, "production-daemon.js")], EnvironmentVariables: { MANDIBLE_PORT: "19420", MANDIBLE_DB: path.join(root, "production.db"), PATH: process.env.PATH ?? "/usr/bin:/bin" }, StandardOutPath: path.join(root, "launchd-stdout.log"), StandardErrorPath: path.join(root, "launchd-stderr.log") };
  if (supervisedMain) fs.writeFileSync(servicePlistPath, renderServicePlist(serviceDefinition));
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
        ...(role === "main" && supervisedMain ? { lifecycle: { kind: "launchd", domain: `gui/${process.getuid?.()}`, label: "com.mll.mandible", plist_path: servicePlistPath } } : { lifecycle: { kind: "unmanaged" } }),
        expected: {
          role,
          startup_epoch: `legacy-${role}`,
          startup_commit_hash: `legacy-commit-${role}`,
          db_path: role === "preview" ? oldDb : path.join(root, "production.db"),
        },
        ...(role === "main" && supervisedMain ? {} : { restore: { command: "/usr/bin/true", args: [], env: { MANDIBLE_INSTANCE_ROLE: role } } }),
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

  const authorityDirectory = path.join(root, "config", "local-sessions");
  const authorityDb = path.join(authorityDirectory, "sessions.db");
  const authority = new LocalSessionAuthority(authorityDirectory, "authority-test", { initialize: true, now: () => 7 });
  authority.registerInstance({
    instance_id: "production", installation_id: "authority-test", role: "main",
    public_origin: "https://app.mandible.localhost:19420", backend_origin: "http://127.0.0.1:0",
    backend_generation: "legacy-main", effect_ceiling: [], writable_roots: [],
  });
  authority.close();
  const caPaths = localCaPaths(root);
  fs.mkdirSync(path.dirname(caPaths.installationAuthority), { recursive: true });
  fs.mkdirSync(path.dirname(caPaths.rootCert), { recursive: true });
  fs.writeFileSync(caPaths.installationAuthority, "installation-test");
  fs.writeFileSync(caPaths.rootCert, "-----BEGIN CERTIFICATE-----\ntest-root\n-----END CERTIFICATE-----\n");
  fs.writeFileSync(caPaths.rootKey, "test-key");
  const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(caPaths.receipt, JSON.stringify({ schema: "mandible-local-ca-trust@1", state: "trusted", caddy_version: "2.11.3", storage_root: caPaths.storageRoot, installation_digest: sha256(caPaths.installationAuthority), root_digest: sha256(caPaths.rootCert), key_digest: sha256(caPaths.rootKey) }));

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
  return { root, configPath, metadataPath, currentDbPath, oldDb, candidateDb, authorityDb, caPaths, manifest, manifestPath, journalPath, servicePlistPath, supervisedMain,
    readPlistDefinition() {
      if (fs.readFileSync(servicePlistPath, "utf8") !== renderServicePlist(serviceDefinition)) throw new Error("fake plist inspector found unrecognized plist bytes");
      return structuredClone(serviceDefinition);
    },
    writePlistDefinition(definition: typeof serviceDefinition) {
      serviceDefinition = structuredClone(definition);
      fs.writeFileSync(servicePlistPath, renderServicePlist(serviceDefinition));
    },
  };
}

function lifecycle(fx: ReturnType<typeof fixture>) {
  type Listener = { pid: number; fingerprint: string; kind: "legacy" | "candidate" | "gateway"; role?: "main" | "preview"; mode?: "migration" | "normal"; epoch?: string; token?: string };
  const listeners = new Map<number, Listener>();
  const intentProcesses = new Map<string, Listener>();
  const events: string[] = [];
  let nextPid = 100;
  let interruptAfterStartRole: string | null = null;
  let interruptBeforeBindRole: string | null = null;
  let interruptAfterNextStop = false;
  let failReloadOnce = false;
  let wrongGatewayStorage = false;
  let nativeCaTrusted = true;
  const unhealthyRoles = new Set<string>();
  const supervisor = { loaded: fx.supervisedMain, enabled: fx.supervisedMain, plist_path: fx.servicePlistPath, definition: fx.supervisedMain ? fx.readPlistDefinition() : null };
  let interruptSupervisorEffect: "disable" | "bootout" | "bootstrap" | null = null;
  let interruptBeforeSupervisorDisable = false;
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
      ...capturedLegacyHealth,
      startup_epoch: listener.epoch,
      startup_commit: { ...capturedLegacyHealth.startup_commit, hash: `legacy-commit-${instance.role}` },
      instance: {
        ...capturedLegacyHealth.instance,
        role: listener.role,
        db_path: instance.legacy.expected.db_path,
      },
    };
    const candidate = candidateHealth(instance, listener.mode ?? "migration");
    return unhealthyRoles.has(instance.role) ? { ...candidate, ready: false, warm: false } : candidate;
  };

  return {
    events,
    listeners,
    interruptAfter(role: string) { interruptAfterStartRole = role; },
    interruptBeforeBind(role: string) { interruptBeforeBindRole = role; },
    interruptNextStop() { interruptAfterNextStop = true; },
    failNextReload() { failReloadOnce = true; },
    misconfigureStorage() { wrongGatewayStorage = true; },
    revokeNativeCaTrust() { nativeCaTrusted = false; },
    dropGateway() { for (const [port, listener] of listeners) if (listener.kind === "gateway") listeners.delete(port); },
    replaceGatewayWithoutRuntime() {
      for (const [port, listener] of listeners) if (listener.kind === "gateway") listeners.delete(port);
      const replacement = { pid: ++nextPid, fingerprint: `process-${nextPid}`, kind: "gateway" as const };
      for (const instance of fx.manifest.instances) listeners.set(instance.public_port, replacement);
      return { pid: replacement.pid, fingerprint: replacement.fingerprint };
    },
    makeCandidateUnhealthy(role: string) { unhealthyRoles.add(role); },
    interruptSupervisor(effect: "disable" | "bootout" | "bootstrap") { interruptSupervisorEffect = effect; },
    interruptBeforeDisable() { interruptBeforeSupervisorDisable = true; },
    supervisorState() { return { ...supervisor }; },
    driftSupervisorPath() { supervisor.plist_path = `${fx.servicePlistPath}.other`; },
    exitSupervisedProcess() { listeners.delete(19420); events.push("supervisor:process-exit"); },
    replaceSupervisedProcess() {
      const pid = ++nextPid;
      const replacement = { pid, fingerprint: `process-${pid}`, kind: "legacy" as const, role: "main" as const, epoch: `respawn-main-${pid}` };
      listeners.set(19420, replacement);
      events.push("supervisor:replacement");
      return replacement;
    },
    occupyPublicPort() { const pid = ++nextPid; listeners.set(19420, { pid, fingerprint: `process-${pid}`, kind: "candidate", role: "main" }); },
    effects: {
      probeCurrentCaTrust: () => { if (!nativeCaTrusted) throw new Error("macOS no longer trusts the pinned local CA for HTTPS"); },
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
        const process = intentProcesses.get(token) ?? [...listeners.values()].find((listener) => listener.token === token);
        return process ? { pid: process.pid, fingerprint: process.fingerprint } : null;
      },
      matchesProcess: () => true,
      portOpen: async (port: number) => listeners.has(port),
      waitPort: async (port: number) => { if (!listeners.has(port)) throw new Error(`missing listener ${port}`); },
      validateGateway: () => undefined,
      configureGateway: (_gateway: unknown, mode: "migration" | "normal") => fs.writeFileSync(fx.configPath, `{\n skip_install_trust\n storage file_system ${JSON.stringify(wrongGatewayStorage ? `${fx.caPaths.storageRoot}.other` : fx.caPaths.storageRoot)}\n}\n${mode === "migration" ? "/api/client-auth/legacy-conversion/complete" : "normal"}\n`),
      reloadGateway: () => { if (failReloadOnce) { failReloadOnce = false; throw new Error("reload failed"); } },
      startProcess: async (spec: { env?: Record<string, string> }, overlay: Record<string, string>) => {
        const role = spec.env?.MANDIBLE_INSTANCE_ROLE as "main" | "preview" | undefined;
        const pid = ++nextPid;
        if (role) {
          const instance = fx.manifest.instances.find((entry) => entry.role === role)!;
          const mode = overlay.MANDIBLE_LEGACY_CONVERSION === "allow" ? "migration" : "normal";
          const candidate = { pid, fingerprint: `process-${pid}`, kind: "candidate" as const, role, mode, token: overlay.MANDIBLE_CUTOVER_INTENT };
          const authority = new Database(fx.authorityDb);
          authority.prepare("UPDATE instance_registrations SET updated_at = updated_at + 1 WHERE instance_id = ?").run(instance.candidate.instance_id);
          authority.close();
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
          const gateway = { pid, fingerprint: `process-${pid}`, kind: "gateway" as const, token: overlay.MANDIBLE_CUTOVER_INTENT };
          for (const instance of fx.manifest.instances) listeners.set(instance.public_port, gateway);
          events.push("start:gateway");
        }
      },
      stopPid: async (pid: number, fingerprint: string) => {
        events.push(`stop:${pid}`);
        for (const [port, listener] of listeners) if (listener.pid === pid && listener.fingerprint === fingerprint) listeners.delete(port);
        for (const [token, process] of intentProcesses) if (process.pid === pid && process.fingerprint === fingerprint) intentProcesses.delete(token);
        if (fx.supervisedMain && supervisor.loaded && supervisor.enabled && pid === 101) {
          const replacementPid = ++nextPid;
          listeners.set(19420, { pid: replacementPid, fingerprint: `process-${replacementPid}`, kind: "legacy", role: "main", epoch: `respawn-main-${replacementPid}` });
          events.push("respawn:main");
        }
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
      inspectSupervisorPlist: async () => fx.readPlistDefinition(),
      supervisorStatus: async () => {
        if (interruptBeforeSupervisorDisable && fs.existsSync(fx.journalPath) && JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).runtime.intents["legacy.main.stop"]?.status === "pending") {
          interruptBeforeSupervisorDisable = false;
          const error = new Error("simulated interruption after stop intent before disable") as Error & { cutoverInterruption: boolean };
          error.cutoverInterruption = true;
          throw error;
        }
        return { loaded: supervisor.loaded, enabled: supervisor.enabled, pid: supervisor.loaded ? (listeners.get(19420)?.kind === "legacy" ? listeners.get(19420)!.pid : null) : null, plist_path: supervisor.loaded ? supervisor.plist_path : null,
          definition: supervisor.loaded && supervisor.definition ? { program: supervisor.definition.ProgramArguments[0], arguments: supervisor.definition.ProgramArguments, environment: { ...Object.fromEntries(Object.entries(supervisor.definition.EnvironmentVariables).reverse()), OSLogRateLimit: "64", XPC_SERVICE_NAME: "com.mll.mandible" }, stdout_path: supervisor.definition.StandardOutPath, stderr_path: supervisor.definition.StandardErrorPath, keepalive: supervisor.definition.KeepAlive } : null };
      },
      waitSupervisorStopped: async () => { if (supervisor.loaded || supervisor.enabled || listeners.has(19420)) throw new Error("supervised service or port did not stop"); },
      supervisorDisable: async () => {
        supervisor.enabled = false;
        events.push("supervisor:disable");
        if (interruptSupervisorEffect === "disable") { interruptSupervisorEffect = null; const error = new Error("simulated supervisor disable interruption") as Error & { cutoverInterruption: boolean }; error.cutoverInterruption = true; throw error; }
      },
      supervisorBootout: async () => {
        supervisor.loaded = false;
        listeners.delete(19420);
        events.push("supervisor:bootout");
        if (interruptSupervisorEffect === "bootout") { interruptSupervisorEffect = null; const error = new Error("simulated supervisor bootout interruption") as Error & { cutoverInterruption: boolean }; error.cutoverInterruption = true; throw error; }
      },
      supervisorEnable: async () => { supervisor.enabled = true; events.push("supervisor:enable"); },
      supervisorBootstrap: async () => {
        supervisor.definition = fx.readPlistDefinition();
        supervisor.loaded = true;
        const pid = ++nextPid;
        listeners.set(19420, { pid, fingerprint: `process-${pid}`, kind: "legacy", role: "main", epoch: `restored-main-${pid}` });
        events.push("supervisor:bootstrap");
        if (interruptSupervisorEffect === "bootstrap") { interruptSupervisorEffect = null; const error = new Error("simulated supervisor bootstrap interruption") as Error & { cutoverInterruption: boolean }; error.cutoverInterruption = true; throw error; }
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
  it("refuses removed macOS CA trust before stopping any old public listener", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.revokeNativeCaTrust();
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("macOS no longer trusts");
    expect(life.events).not.toContain("supervisor:disable");
    expect(life.events).not.toContain("supervisor:bootout");
    expect(life.events).not.toContain("stop:preview");
    expect(life.events).not.toContain("start:gateway");
  });
  it("requires the explicit installation CA trust receipt before activation effects", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    fs.rmSync(fx.caPaths.receipt);
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("has not passed explicit secure-local-connections setup");
    expect(life.events).not.toContain("supervisor:disable");
    expect(life.events).not.toContain("supervisor:bootout");
  });

  it("refuses root drift and wrong Caddy storage instead of opening a new trust path", async () => {
    const drift = fixture({ supervisedMain: true });
    const driftLife = lifecycle(drift);
    await runCutoverCommand({ command: "prepare", manifest: drift.manifestPath, journal: drift.journalPath }, driftLife.effects);
    fs.appendFileSync(drift.caPaths.rootCert, "drift");
    await expect(runCutoverCommand({ command: "activate", journal: drift.journalPath, confirmCaTrusted: true }, driftLife.effects)).rejects.toThrow("Caddy root changed");
    expect(driftLife.events).not.toContain("supervisor:disable");

    const storage = fixture({ supervisedMain: true });
    const storageLife = lifecycle(storage);
    await runCutoverCommand({ command: "prepare", manifest: storage.manifestPath, journal: storage.journalPath }, storageLife.effects);
    storageLife.misconfigureStorage();
    await expect(runCutoverCommand({ command: "activate", journal: storage.journalPath, confirmCaTrusted: true }, storageLife.effects)).rejects.toThrow("Gateway Caddy storage");
    expect(storageLife.events).not.toContain("start:gateway");
  });

  it("suspends a KeepAlive production service instead of stopping its PID and restores through launchd", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await life.effects.stopPid(101, "process-101");
    expect(life.events).toContain("respawn:main");
    const respawned = life.listeners.get(19420)!;
    fx.manifest.instances[0].legacy.expected.startup_epoch = respawned.epoch!;
    fs.writeFileSync(fx.manifestPath, JSON.stringify(fx.manifest));
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    const prepared = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(prepared.legacy.main.supervisor).toMatchObject({ domain: `gui/${process.getuid?.()}`, label: "com.mll.mandible", loaded: true, enabled: true });
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    expect(life.events).toEqual(expect.arrayContaining(["supervisor:disable", "supervisor:bootout"]));
    expect(life.events.filter((event) => event === "stop:101")).toHaveLength(1);
    expect(life.events.filter((event) => event === "respawn:main")).toHaveLength(1);
    expect(life.supervisorState()).toMatchObject({ loaded: false, enabled: false });
    await runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects);
    expect(life.events).toEqual(expect.arrayContaining(["supervisor:enable", "supervisor:bootstrap"]));
    expect(life.supervisorState()).toMatchObject({ loaded: true, enabled: true });
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).legacy.main.restored_epoch).toMatch(/^restored-main-/);
  });

  it("reconciles supervisor disable and bootout effects interrupted before receipts", async () => {
    for (const effect of ["disable", "bootout"] as const) {
      const fx = fixture({ supervisedMain: true });
      const life = lifecycle(fx);
      await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
      life.interruptSupervisor(effect);
      await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow(`simulated supervisor ${effect} interruption`);
      await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).resolves.toMatchObject({ state: "migration" });
      expect(life.events.filter((event) => event === `supervisor:${effect}`)).toHaveLength(1);
      await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    }
  });

  it("rolls back directly after supervisor disable without bootout or a fake restart", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptSupervisor("disable");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated supervisor disable interruption");
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events).toContain("supervisor:enable");
    expect(life.events).not.toContain("supervisor:bootstrap");
    expect(life.supervisorState()).toMatchObject({ loaded: true, enabled: true });
  });

  it("replays a not-applied stop receipt after interruption before the rolled-back transition", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptSupervisor("disable");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated supervisor disable interruption");
    await runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects);
    const interrupted = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(interrupted.runtime.intents["legacy.main.stop"].effect).toBe("not-applied");
    interrupted.state = "rolling_back";
    delete interrupted.rolled_back_at;
    fs.writeFileSync(fx.journalPath, JSON.stringify(interrupted));
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events).not.toContain("supervisor:bootstrap");
    expect(life.events.filter((event) => event === "supervisor:enable")).toHaveLength(1);
  });

  it("records and replays a verified launchd replacement after stop intent but before disable", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptBeforeDisable();
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated interruption after stop intent before disable");
    const interrupted = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(interrupted.runtime.intents["legacy.main.stop"].status).toBe("pending");
    expect(life.events).not.toContain("supervisor:disable");
    const replacement = life.replaceSupervisedProcess();
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    const firstRollback = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(firstRollback.runtime.intents["legacy.main.stop"]).toMatchObject({ status: "done", effect: "restored-replacement", listener: { pid: replacement.pid, fingerprint: replacement.fingerprint }, startup_epoch: replacement.epoch });
    expect(firstRollback.legacy.main.restored_epoch).toBe(replacement.epoch);
    firstRollback.state = "rolling_back";
    delete firstRollback.rolled_back_at;
    fs.writeFileSync(fx.journalPath, JSON.stringify(firstRollback));
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events).not.toContain("supervisor:disable");
    expect(life.events).not.toContain("supervisor:bootout");
    expect(life.events).not.toContain("supervisor:bootstrap");
  });

  it("reconciles a loaded launchd service whose process exited during disable", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptSupervisor("disable");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated supervisor disable interruption");
    life.exitSupervisedProcess();
    expect((await life.effects.supervisorStatus()).pid).toBeNull();
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).resolves.toMatchObject({ state: "migration" });
    expect(life.events.filter((event) => event === "supervisor:bootout")).toHaveLength(1);
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events.filter((event) => event === "supervisor:bootstrap")).toHaveLength(1);
  });

  it("rolls back a loaded launchd service without a PID instead of assuming HTTP readiness", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptSupervisor("disable");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated supervisor disable interruption");
    life.exitSupervisedProcess();
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events).toEqual(expect.arrayContaining(["supervisor:bootout", "supervisor:bootstrap"]));
  });

  it("refuses a foreign public listener while launchd has no PID", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptSupervisor("disable");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated supervisor disable interruption");
    life.exitSupervisedProcess();
    life.occupyPublicPort();
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).rejects.toThrow("unexpected process");
    expect(life.events).not.toContain("supervisor:bootout");
    expect(life.events).not.toContain("supervisor:bootstrap");
  });

  it("rolls back directly after launchd bootout before its receipt", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptSupervisor("bootout");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated supervisor bootout interruption");
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events.filter((event) => event === "supervisor:bootout")).toHaveLength(1);
    expect(life.events.filter((event) => event === "supervisor:bootstrap")).toHaveLength(1);
  });

  it("reconciles launchd bootstrap interrupted before its receipt", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    life.interruptSupervisor("bootstrap");
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).rejects.toThrow("simulated supervisor bootstrap interruption");
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events.filter((event) => event === "supervisor:bootstrap")).toHaveLength(1);
  });

  it("refuses supervised plist drift before changing launchd state", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    fs.appendFileSync(fx.servicePlistPath, "drift");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("plist drifted");
    expect(life.events).not.toContain("supervisor:disable");
    expect(life.events).not.toContain("supervisor:bootout");
  });

  it("refuses a supervisor record that does not own the health-verified listener", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    life.driftSupervisorPath();
    await expect(runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects)).rejects.toThrow("not owned by its exact launchd service");
    expect(life.events).not.toContain("supervisor:disable");
  });

  it("refuses an edited plist whose executable, arguments, or complete configured environment differ from the loaded definition", async () => {
    for (const mutation of ["executable", "arguments", "environment", "environment-removal"] as const) {
      const fx = fixture({ supervisedMain: true });
      const life = lifecycle(fx);
      const edited = fx.readPlistDefinition();
      if (mutation === "executable") edited.ProgramArguments[0] = "/usr/bin/other-node";
      if (mutation === "arguments") edited.ProgramArguments[1] = "/tmp/other-daemon.js";
      if (mutation === "environment") edited.EnvironmentVariables.PATH = "/changed/path";
      if (mutation === "environment-removal") delete (edited.EnvironmentVariables as Record<string, string | undefined>).MANDIBLE_DB;
      fx.writePlistDefinition(edited);
      await expect(runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects)).rejects.toThrow("loaded launchd");
      expect(life.events).not.toContain("supervisor:disable");
    }
  });

  it("records production service suspension while the normal gateway owns 19420", async () => {
    const fx = fixture({ supervisedMain: true });
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    await expect(runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects)).resolves.toMatchObject({ state: "complete" });
    const completed = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(completed.legacy.main.supervisor_suspended).toBe(true);
    expect(life.supervisorState()).toMatchObject({ loaded: false, enabled: false });
  });

  it("guards registration semantics while candidate startup refreshes updated_at", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    const prepared = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(prepared.runtime.intents["registrations.stage"].status).toBe("done");
    expect(prepared.registrations.find((entry: { instance_id: string }) => entry.instance_id === "production").before).toMatchObject({ backend_origin: "http://127.0.0.1:0", updated_at: 7 });
    expect(registration(fx, "production")).toMatchObject({ backend_origin: "http://127.0.0.1:29420" });
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    const refreshedAt = (registration(fx, "production") as { updated_at: number }).updated_at;
    await runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects);
    expect(registration(fx, "production")).toMatchObject({ backend_origin: "http://127.0.0.1:0", updated_at: refreshedAt });
    expect(registration(fx, "preview-existing")).toBeUndefined();
  });

  it("accepts the captured pre-cutover health shape without invented identity fields", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    expect(capturedLegacyHealth.instance).not.toHaveProperty("instance_id");
    expect(capturedLegacyHealth.instance).not.toHaveProperty("installation_id");
    await expect(runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "prepared" });
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

  it("retains newly referenced registrations and restores legacy listeners under the real authority schema", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    const db = new Database(fx.authorityDb);
    db.pragma("foreign_keys = ON");
    db.prepare(`INSERT INTO browser_sessions (
      family_id, root_family_id, token_digest, csrf_digest, user_id, slug, audience,
      effect_ceiling_json, evidence_json, created_at, last_activity_at, expires_at,
      absolute_expires_at, revoked_at, legacy_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run("family-preview", "family-preview", "token", "csrf", "user", "operator", "preview-existing", "[]", "{}", 1, 1, 10, 20, "legacy-proof");
    db.prepare(`INSERT INTO legacy_conversions (
      reference, secret_digest, legacy_fingerprint, user_id, slug, target_audience,
      return_path, browser_state_json, authenticated_at, created_at, expires_at,
      issued_family_id, verified_at, retired_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run("conversion", "secret", "conversion-proof", "user", "operator", "preview-existing", "/", "{}", 1, 1, 10, "family-preview", 2);
    db.close();
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(registration(fx, "preview-existing")).toMatchObject({ backend_origin: "http://127.0.0.1:29421" });
    expect(life.events).toEqual(expect.arrayContaining(["restore:main", "restore:preview"]));
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

  it("reconciles a normal candidate started before its receipt without selecting the migration receipt", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    life.interruptAfter("main");
    await expect(runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects)).rejects.toThrow("simulated process interruption");
    const interrupted = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(interrupted.runtime.intents["candidate.main.migration.start"].status).toBe("done");
    expect(interrupted.runtime.intents["candidate.main.normal.start"].status).toBe("pending");
    await expect(runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects)).resolves.toMatchObject({ state: "complete" });
    expect(life.events.filter((event) => event === "start:main:normal")).toHaveLength(1);
  });

  it("rolls back directly after a stop effect interrupted before its receipt", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptNextStop();
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated stop interruption");
    const rolledBack = await runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects);
    expect(rolledBack.state).toBe("rolled_back");
    expect(life.events).toContain("restore:main");
  });

  it("rejects invalid activation states before backward recovery", async () => {
    for (const state of ["migration", "normal_pending", "complete", "recovery_failed"]) {
      const fx = fixture();
      const life = lifecycle(fx);
      await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
      const journal = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
      journal.state = state;
      if (state === "recovery_failed") journal.recovery_direction = "forward";
      fs.writeFileSync(fx.journalPath, JSON.stringify(journal));
      const stopCount = life.events.filter((event) => event.startsWith("stop:")).length;
      await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow(`Cutover is ${state}`);
      expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).state).toBe(state);
      expect(life.events.filter((event) => event.startsWith("stop:")).length).toBe(stopCount);
    }
  });

  it("stops journal-owned candidates during rollback even when health is unready", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    life.interruptAfter("main");
    await expect(runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects)).rejects.toThrow("simulated process interruption");
    life.makeCandidateUnhealthy("main");
    await expect(runCutoverCommand({ command: "rollback", journal: fx.journalPath }, life.effects)).resolves.toMatchObject({ state: "rolled_back" });
    expect(life.events).toContain("restore:main");
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
    life.dropGateway();
    await runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects);
    expect(life.events.filter((event) => event === "start:gateway")).toHaveLength(2);
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

  it("recovers a completed gateway intent whose runtime receipt was not yet updated", async () => {
    const fx = fixture();
    const life = lifecycle(fx);
    await runCutoverCommand({ command: "prepare", manifest: fx.manifestPath, journal: fx.journalPath }, life.effects);
    await runCutoverCommand({ command: "activate", journal: fx.journalPath, confirmCaTrusted: true }, life.effects);
    life.failNextReload();
    await expect(runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects)).rejects.toThrow("forward-only");
    const replacement = life.replaceGatewayWithoutRuntime();
    const interrupted = JSON.parse(fs.readFileSync(fx.journalPath, "utf8"));
    expect(interrupted.runtime.gateway).not.toEqual(replacement);
    interrupted.runtime.intents["gateway.start.normal"] = {
      ...interrupted.runtime.intents["gateway.start.normal"],
      status: "done",
      listener: replacement,
    };
    fs.writeFileSync(fx.journalPath, JSON.stringify(interrupted));
    await expect(runCutoverCommand({ command: "complete", journal: fx.journalPath, confirmBrowserConversion: true }, life.effects)).resolves.toMatchObject({ state: "complete" });
    expect(JSON.parse(fs.readFileSync(fx.journalPath, "utf8")).runtime.gateway).toEqual(replacement);
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
