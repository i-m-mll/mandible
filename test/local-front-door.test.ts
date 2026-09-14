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
    authority.close();
    const script = path.resolve("scripts/local-front-door.mjs");
    for (const [command, contains] of [["configure-migration", true], ["configure", false]] as const) {
      const result = spawnSync(process.execPath, [script, command], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const config = fs.readFileSync(path.join(home, "config", "local-sessions", "Caddyfile"), "utf8");
      expect(config.includes("legacy-conversion/complete")).toBe(contains);
      if (contains) {
        expect(config).toContain("http://127.0.0.1:19420, http://localhost:19420");
        expect(config).not.toContain("https://app.mandible.localhost:19420 {");
        expect(config).toContain("header_up -Authorization");
      } else {
        expect(config).toContain("https://app.mandible.localhost:19420 {");
        expect(config).not.toContain("http://127.0.0.1:19420");
      }
    }
  });
});
