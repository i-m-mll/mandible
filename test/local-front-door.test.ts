// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSessionAuthority } from "../src/client-auth/session-authority.js";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

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
    const script = path.resolve("scripts/local-front-door.mjs");
    for (const [command, contains] of [["configure-migration", true], ["configure", false]] as const) {
      const result = spawnSync(process.execPath, [script, command], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const config = fs.readFileSync(path.join(home, "config", "local-sessions", "Caddyfile"), "utf8");
      expect(config).toContain("skip_install_trust");
      expect(config).toContain(`storage file_system ${JSON.stringify(path.join(home, "config", "local-sessions", "caddy-storage"))}`);
      expect(config.includes("legacy-conversion/complete")).toBe(contains);
      if (contains) {
        expect(config).toContain("http://127.0.0.1:19420, http://localhost:19420");
        expect(config).toContain("http://127.0.0.1:19421, http://localhost:19421");
        expect(config).toContain("https://preview-existing.mandible.localhost:19419");
        expect(config).toContain("header_up X-Mandible-Target-Instance preview-existing");
        expect(config).toContain("header_up X-Mandible-Legacy-Migration complete-v1");
        expect(config).toContain("header Origin http://127.0.0.1:19420 http://localhost:19420");
        expect(config).toContain("header Origin http://127.0.0.1:19421 http://localhost:19421");
        expect(config).toContain("header Sec-Fetch-Site cross-site");
        expect(config).toMatch(/http:\/\/127\.0\.0\.1:19420, http:\/\/localhost:19420 \{[\s\S]*?reverse_proxy http:\/\/127\.0\.0\.1:29420[\s\S]*?X-Mandible-Target-Instance production/);
        expect(config).toMatch(/http:\/\/127\.0\.0\.1:19421, http:\/\/localhost:19421 \{[\s\S]*?reverse_proxy http:\/\/127\.0\.0\.1:29421[\s\S]*?X-Mandible-Target-Instance preview-existing/);
        expect(config).not.toContain("https://app.mandible.localhost:19420 {");
        expect(config).toContain("header_up -Authorization");
      } else {
        expect(config).toContain("https://app.mandible.localhost:19420 {");
        expect(config).not.toContain("http://127.0.0.1:19420");
        expect(config).toContain("https://preview-existing.mandible.localhost:19421 {");
        expect(config).toContain("rewrite * /api/client-auth/preview-bootstrap");
        expect(config).toContain("not header Cookie *__Host-mandible-session=*");
        expect(config.indexOf("rewrite * /api/client-auth/preview-bootstrap"))
          .toBeLessThan(config.indexOf("forward_auth"));
      }
    }
    const untrustedRun = spawnSync(process.execPath, [script, "run"], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8" });
    expect(untrustedRun.status).toBe(1);
    expect(untrustedRun.stderr).toContain("Secure local connections are not set up");
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
});
