// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSessionAuthority } from "../src/client-auth/session-authority.js";
import { localCaPaths } from "../scripts/local-ca-trust.mjs";
import { pinnedCaddyBinary } from "../scripts/pinned-caddy.mjs";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fakeTrustedCa(home: string) {
  const ca = localCaPaths(home);
  fs.mkdirSync(path.dirname(ca.installationAuthority), { recursive: true });
  fs.mkdirSync(path.dirname(ca.rootCert), { recursive: true });
  fs.writeFileSync(ca.installationAuthority, "install_test");
  fs.writeFileSync(ca.rootCert, "-----BEGIN CERTIFICATE-----\ntest-root\n-----END CERTIFICATE-----\n");
  fs.writeFileSync(ca.rootKey, "test-key");
  const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(ca.receipt, JSON.stringify({ schema: "mandible-local-ca-trust@1", state: "trusted", caddy_version: "2.11.3", storage_root: ca.storageRoot, installation_digest: digest(ca.installationAuthority), root_digest: digest(ca.rootCert), key_digest: digest(ca.rootKey) }));
  return ca;
}

describe("local HTTPS front door", () => {
  it("installs the gateway before certificate trust is configured", () => {
    const home = fs.mkdtempSync(path.join("/tmp", "mandible-front-door-install-")); roots.add(home);
    const binary = pinnedCaddyBinary(home);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "already installed");
    const result = spawnSync(process.execPath, [path.resolve("scripts/local-front-door.mjs"), "install"], {
      env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, "config", "local-sessions", "Caddyfile"))).toBe(false);
  });

  it("forwards every preview request through scoped local authorization without cookies", () => {
    const home = fs.mkdtempSync(path.join("/tmp", "mandible-front-door-")); roots.add(home);
    const authority = new LocalSessionAuthority(path.join(home, "config", "local-sessions"), "install_test", { initialize: true });
    authority.registerInstance({
      instance_id: "production", installation_id: "install_test", role: "main",
      public_origin: "https://app.mandible.localhost:19420", backend_origin: "http://127.0.0.1:29420",
      backend_generation: "main-1", effect_ceiling: ["ledger:read", "ledger:write"], writable_roots: [],
    });
    authority.registerInstance({
      instance_id: "preview-existing", installation_id: "install_test", role: "preview",
      public_origin: "https://preview-existing.mandible.localhost:19421", backend_origin: "http://127.0.0.1:29421",
      backend_generation: "preview-1", effect_ceiling: ["ledger:read", "ledger:write", "files:preview"], writable_roots: [],
    });
    authority.close();
    fakeTrustedCa(home);
    const script = path.resolve("scripts/local-front-door.mjs");
    const result = spawnSync(process.execPath, [script, "configure"], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const config = fs.readFileSync(path.join(home, "config", "local-sessions", "Caddyfile"), "utf8");
    const installedCaddy = pinnedCaddyBinary(path.join(os.homedir(), ".mandible"));
    if (fs.existsSync(installedCaddy)) {
      const adapted = spawnSync(installedCaddy, ["adapt", "--config", "-", "--adapter", "caddyfile"], {
        input: config, encoding: "utf8",
      });
      expect(adapted.status, adapted.stderr).toBe(0);
    }
    expect(config).toContain("skip_install_trust");
    expect(config).toContain("https://app.mandible.localhost:19420 {");
    expect(config).toContain("https://preview-existing.mandible.localhost:19421 {");
    expect(config).toContain("uri /api/client-auth/forward-auth");
    expect(config).toContain("header_up X-Mandible-Target-Instance preview-existing");
    expect(config).toContain("copy_headers X-Mandible-Session-Context");
    expect(config).toContain("header_up -Cookie");
    expect(config).not.toContain("preview-bootstrap");
    expect(config).not.toContain("legacy-conversion");
    expect(config).not.toContain("recovery/");
  });

  it("routes multiple previews with their distinct target contexts", () => {
    const home = fs.mkdtempSync(path.join("/tmp", "mandible-front-door-multiple-")); roots.add(home);
    const authority = new LocalSessionAuthority(path.join(home, "config", "local-sessions"), "install_test", { initialize: true });
    authority.registerInstance({
      instance_id: "production", installation_id: "install_test", role: "main",
      public_origin: "https://app.mandible.localhost:19420", backend_origin: "http://127.0.0.1:29420",
      backend_generation: "main-1", effect_ceiling: ["ledger:read", "ledger:write"], writable_roots: [],
    });
    for (const [suffix, port] of [["first", 29421], ["second", 29422]] as const) {
      authority.registerInstance({
        instance_id: `preview-${suffix}`, installation_id: "install_test", role: "preview",
        public_origin: `https://preview-${suffix}.mandible.localhost:19421`, backend_origin: `http://127.0.0.1:${port}`,
        backend_generation: `${suffix}-1`, effect_ceiling: ["ledger:read", "files:preview"], writable_roots: [],
      });
    }
    authority.close();
    fakeTrustedCa(home);
    const script = path.resolve("scripts/local-front-door.mjs");
    const ordinary = spawnSync(process.execPath, [script, "configure"], {
      env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8",
    });
    expect(ordinary.status, ordinary.stderr).toBe(0);
    const config = fs.readFileSync(path.join(home, "config", "local-sessions", "Caddyfile"), "utf8");
    expect(config).toContain("https://preview-first.mandible.localhost:19421 {");
    expect(config).toContain("https://preview-second.mandible.localhost:19421 {");
    expect(config).toMatch(/https:\/\/preview-first\.mandible\.localhost:19421 \{[\s\S]*?reverse_proxy http:\/\/127\.0\.0\.1:29421/);
    expect(config).toMatch(/https:\/\/preview-second\.mandible\.localhost:19421 \{[\s\S]*?reverse_proxy http:\/\/127\.0\.0\.1:29422/);

    expect(config).toContain("header_up X-Mandible-Target-Instance preview-first");
    expect(config).toContain("header_up X-Mandible-Target-Instance preview-second");
  });

  it("keeps the last valid gateway config when registration points back at a public listener", () => {
    const home = fs.mkdtempSync(path.join("/tmp", "mandible-front-door-self-route-")); roots.add(home);
    const authority = new LocalSessionAuthority(path.join(home, "config", "local-sessions"), "install_test", { initialize: true });
    const production = {
      instance_id: "production", installation_id: "install_test", role: "main" as const,
      public_origin: "https://app.mandible.localhost:19420", backend_origin: "http://127.0.0.1:29420",
      backend_generation: "main-1", effect_ceiling: ["ledger:read" as const], writable_roots: [],
    };
    authority.registerInstance(production);
    fakeTrustedCa(home);
    const script = path.resolve("scripts/local-front-door.mjs");
    const configPath = path.join(home, "config", "local-sessions", "Caddyfile");
    const configure = () => spawnSync(process.execPath, [script, "configure"], {
      env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8",
    });
    const valid = configure();
    expect(valid.status, valid.stderr).toBe(0);
    const originalConfig = fs.readFileSync(configPath, "utf8");

    authority.registerInstance({ ...production, backend_origin: "http://127.0.0.1:19420" });
    authority.close();
    const poisoned = configure();
    expect(poisoned.status).toBe(1);
    expect(poisoned.stderr).toContain("Refusing gateway self-route");
    expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);

    // Exercise default URL ports through the stored-data boundary. Registration
    // requires explicit ports, but the gateway must still reject corrupted rows.
    const db = new SqliteDatabase(path.join(home, "config", "local-sessions", "sessions.db"));
    try {
      const update = db.prepare("UPDATE instance_registrations SET public_origin = ?, backend_origin = ? WHERE instance_id = 'production'");
      update.run("https://app.mandible.localhost", "http://127.0.0.1:443");
      const defaultPortLoop = configure();
      expect(defaultPortLoop.status).toBe(1);
      expect(defaultPortLoop.stderr).toContain("backend port 443 is a public listener port");
      expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);

      update.run("https://app.mandible.localhost", "http://127.0.0.1");
      const distinctDefaults = configure();
      expect(distinctDefaults.status, distinctDefaults.stderr).toBe(0);
      expect(fs.readFileSync(configPath, "utf8")).toContain("reverse_proxy http://127.0.0.1");
    } finally {
      db.close();
    }
  });

  it("refuses an old-storage gateway reload before writing empty pinned storage or a new Caddyfile", () => {
    const home = fs.mkdtempSync(path.join("/tmp", "mandible-front-door-old-storage-")); roots.add(home);
    const authority = new LocalSessionAuthority(path.join(home, "config", "local-sessions"), "install_test", { initialize: true });
    authority.close();
    const oldStorage = path.join(home, "old-caddy-storage");
    fs.mkdirSync(oldStorage, { recursive: true });
    fs.writeFileSync(path.join(oldStorage, "root.crt"), "old-root");
    const config = path.join(home, "config", "local-sessions", "Caddyfile");
    fs.writeFileSync(config, `1024 bytes of old gateway config: storage file_system ${JSON.stringify(oldStorage)}\n`);
    const script = path.resolve("scripts/local-front-door.mjs");
    for (const command of ["configure", "run"]) {
      const result = spawnSync(process.execPath, [script, command], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Secure local connections are not set up");
      expect(fs.readFileSync(config, "utf8")).toContain(oldStorage);
      expect(fs.existsSync(localCaPaths(home).storageRoot)).toBe(false);
    }
    const ca = fakeTrustedCa(home);
    const receipt = JSON.parse(fs.readFileSync(ca.receipt, "utf8"));
    receipt.state = "prepared";
    fs.writeFileSync(ca.receipt, JSON.stringify(receipt));
    const prepared = spawnSync(process.execPath, [script, "configure"], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8" });
    expect(prepared.status).toBe(1);
    expect(fs.readFileSync(config, "utf8")).toContain(oldStorage);
  });
});
