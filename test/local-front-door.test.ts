// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  it("includes legacy ingress only during the explicit migration phase", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-front-door-")); roots.add(home);
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
    for (const [command, contains] of [["configure-migration", true], ["configure", false]] as const) {
      const result = spawnSync(process.execPath, [script, command], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8" });
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
      expect(config).toContain(`storage file_system ${JSON.stringify(path.join(home, "config", "local-sessions", "caddy-storage"))}`);
      expect(config.includes("legacy-conversion/complete")).toBe(contains);
      if (contains) {
        expect(config).toContain("http://127.0.0.1:19420, http://localhost:19420");
        expect(config).toContain("http://127.0.0.1:19421, http://localhost:19421");
        expect(config).toContain("https://preview-existing.mandible.localhost:19419");
        expect(config).toContain("header_up X-Mandible-Target-Instance preview-existing");
        expect(config).toContain("header_up X-Mandible-Legacy-Migration complete-v1");
        expect(config).toContain("path /api/client-auth/legacy-conversion/verify /api/client-auth/legacy-conversion/prepared");
        expect(config).toContain("path /api/client-auth/recovery/start");
        expect(config).toContain("header_up X-Mandible-Legacy-Recovery state-v1");
        expect(config).toContain("path /api/client-auth/recovery/approve /api/client-auth/recovery/verify /api/client-auth/pairing/complete");
        expect(config).not.toContain("header_up -X-Mandible-Legacy-Recovery");
        expect(config).not.toContain("header_up -X-Mandible-Legacy-Migration");
        expect(config).toContain("header_up X-Mandible-Legacy-Origin http://127.0.0.1:19420");
        expect(config).toContain("header_up X-Mandible-Legacy-Origin http://127.0.0.1:19421");
        expect(config).not.toContain("header_up X-Mandible-Legacy-Origin {http.request.header.Origin}");
        expect(config).toContain("header_up Host {http.request.hostport}");
        expect(config).toContain("header Origin http://127.0.0.1:19420\n    header Origin http://localhost:19420");
        expect(config).toContain("header Origin http://127.0.0.1:19421\n    header Origin http://localhost:19421");
        expect(config).toContain("header Sec-Fetch-Site cross-site");
        expect(config).toMatch(/http:\/\/127\.0\.0\.1:19420, http:\/\/localhost:19420 \{[\s\S]*?reverse_proxy http:\/\/127\.0\.0\.1:29420[\s\S]*?X-Mandible-Target-Instance production/);
        expect(config).toMatch(/http:\/\/127\.0\.0\.1:19421, http:\/\/localhost:19421 \{[\s\S]*?reverse_proxy http:\/\/127\.0\.0\.1:29421[\s\S]*?X-Mandible-Target-Instance preview-existing/);
        expect(config).not.toContain("https://app.mandible.localhost:19420 {");
        expect(config).toContain("header_up -Authorization");
      } else {
        expect(config).not.toContain("X-Mandible-Legacy-Recovery");
        expect(config).toContain("https://app.mandible.localhost:19420 {");
        expect(config).not.toContain("http://127.0.0.1:19420");
        expect(config).toContain("https://preview-existing.mandible.localhost:19421 {");
        expect(config).toContain("rewrite * /api/client-auth/preview-bootstrap");
        expect(config).toContain("not header Cookie *__Host-mandible-session=*");
        expect(config).toContain("header_up X-Mandible-Session-Context {http.request.header.X-Mandible-Session-Context}");
        expect(config).not.toContain("header_up -X-Mandible-Session-Context\n      header_up X-Mandible-Session-Context {http.request.header.X-Mandible-Session-Context}");
        expect(config.indexOf("rewrite * /api/client-auth/preview-bootstrap"))
          .toBeLessThan(config.indexOf("forward_auth"));
      }
    }
  });

  it("routes multiple previews normally but refuses ambiguous legacy preview migration", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-front-door-multiple-")); roots.add(home);
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

    const migration = spawnSync(process.execPath, [script, "configure-migration"], {
      env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8",
    });
    expect(migration.status).toBe(1);
    expect(migration.stderr).toContain("Legacy port 19421 is ambiguous across registered previews.");
  });

  it("refuses an old-storage gateway reload before writing empty pinned storage or a new Caddyfile", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-front-door-old-storage-")); roots.add(home);
    const authority = new LocalSessionAuthority(path.join(home, "config", "local-sessions"), "install_test", { initialize: true });
    authority.close();
    const oldStorage = path.join(home, "old-caddy-storage");
    fs.mkdirSync(oldStorage, { recursive: true });
    fs.writeFileSync(path.join(oldStorage, "root.crt"), "old-root");
    const config = path.join(home, "config", "local-sessions", "Caddyfile");
    fs.writeFileSync(config, `1024 bytes of old gateway config: storage file_system ${JSON.stringify(oldStorage)}\n`);
    const script = path.resolve("scripts/local-front-door.mjs");
    for (const command of ["configure", "configure-migration", "run", "run-migration"]) {
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
