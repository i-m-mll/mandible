// @vitest-environment node

import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLocalCaIdentity, localCaPaths, setupCaddyfile, setupLocalCa } from "../scripts/local-ca-trust.mjs";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ca-trust-"));
  roots.add(home);
  const paths = localCaPaths(home);
  fs.mkdirSync(path.dirname(paths.installationAuthority), { recursive: true });
  fs.writeFileSync(paths.installationAuthority, "installation-test");
  let nativeTrusted = false;
  let approvals = 0;
  let bootstraps = 0;
  let closes = 0;
  let deny = false;
  const effects = {
    bootstrap: async () => {
      bootstraps++;
      fs.mkdirSync(path.dirname(paths.rootCert), { recursive: true });
      if (!fs.existsSync(paths.rootCert)) fs.writeFileSync(paths.rootCert, "-----BEGIN CERTIFICATE-----\ntest-root\n-----END CERTIFICATE-----\n");
      if (!fs.existsSync(paths.rootKey)) fs.writeFileSync(paths.rootKey, "test-key");
      return {
        probePinnedRoot: async () => true,
        probeNativeTrust: async () => nativeTrusted ? "trusted" : "untrusted",
        close: async () => { closes++; },
      };
    },
    approveTrust: async () => {
      approvals++;
      if (deny) throw new Error("operator declined macOS approval");
      nativeTrusted = true;
    },
  };
  return { paths, effects, counts: () => ({ approvals, bootstraps, closes }), setDenied: () => { deny = true; }, setNativeTrusted: (value: boolean) => { nativeTrusted = value; } };
}

describe("one-time local CA trust", () => {
  it("renders only temporary loopback setup listeners with pinned storage and no automatic trust", () => {
    const fx = fixture();
    const config = setupCaddyfile(fx.paths.storageRoot, 30111, 30112);
    expect(config).toContain(`storage file_system ${JSON.stringify(fx.paths.storageRoot)}`);
    expect(config).toContain("skip_install_trust");
    expect(config).toContain("admin 127.0.0.1:30111");
    expect(config).toContain("bind 127.0.0.1");
    expect(config).not.toMatch(/:1941[9]|:19420|:19421|:2019/);
  });
  it("pins an installation-owned root after explicit approval and never prompts for a routine repeat", async () => {
    const fx = fixture();
    expect(assertLocalCaIdentity(fx.paths)).toMatchObject({ state: "not_set_up" });
    const first = await setupLocalCa(fx.paths, fx.effects);
    expect(first).toMatchObject({ state: "trusted", storage_root: fx.paths.storageRoot });
    expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 1, closes: 1 });
    fs.mkdirSync(path.join(fx.paths.storageRoot, "certificates"), { recursive: true });
    fs.writeFileSync(path.join(fx.paths.storageRoot, "certificates", "renewed-leaf.crt"), "new-leaf");
    await setupLocalCa(fx.paths, fx.effects);
    expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 2, closes: 2 });
  });

  it("refuses root and installation authority drift before bootstrapping or asking for trust", async () => {
    for (const drift of ["root", "key", "authority"] as const) {
      const fx = fixture();
      await setupLocalCa(fx.paths, fx.effects);
      fs.writeFileSync(drift === "root" ? fx.paths.rootCert : drift === "key" ? fx.paths.rootKey : fx.paths.installationAuthority, drift === "root" ? "-----BEGIN CERTIFICATE-----\ndrift\n-----END CERTIFICATE-----\n" : "drift");
      expect(() => assertLocalCaIdentity(fx.paths)).toThrow(drift === "root" ? "Caddy root changed" : drift === "key" ? "private key changed" : "Installation authority changed");
      await expect(setupLocalCa(fx.paths, fx.effects)).rejects.toThrow("changed");
      expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 1, closes: 1 });
    }
  });

  it("keeps a prepared receipt when the operator declines and retries only on another explicit action", async () => {
    const fx = fixture();
    fx.setDenied();
    await expect(setupLocalCa(fx.paths, fx.effects)).rejects.toThrow("operator declined");
    expect(assertLocalCaIdentity(fx.paths)).toMatchObject({ state: "prepared" });
    expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 1, closes: 1 });
    fx.setNativeTrusted(true);
    await expect(setupLocalCa(fx.paths, fx.effects)).resolves.toMatchObject({ state: "trusted" });
    expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 2, closes: 2 });
  });

  it("rejects a concurrent setup action before either can ask macOS to trust a root", async () => {
    const fx = fixture();
    const originalBootstrap = fx.effects.bootstrap;
    let release!: () => void;
    fx.effects.bootstrap = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return originalBootstrap();
    };
    const first = setupLocalCa(fx.paths, fx.effects);
    await expect(setupLocalCa(fx.paths, fx.effects)).rejects.toThrow("already in progress");
    release();
    await expect(first).resolves.toMatchObject({ state: "trusted" });
    expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 1, closes: 1 });
  });

  it("recovers a killed setup owner and retries without replacing its root", async () => {
    const fx = fixture();
    const moduleUrl = new URL("../scripts/local-ca-trust.mjs", import.meta.url).href;
    const binaryUrl = new URL("../scripts/pinned-caddy.mjs", import.meta.url).href;
    const script = `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';\nimport { setupLocalCa, localCaPaths } from ${JSON.stringify(moduleUrl)};\nimport { pinnedCaddyBinary } from ${JSON.stringify(binaryUrl)};\nconst paths = localCaPaths(process.argv[1]);\nawait setupLocalCa(paths, { bootstrap: async (context) => {\n  fs.mkdirSync(path.dirname(paths.rootCert), { recursive: true });\n  fs.writeFileSync(paths.rootCert, '-----BEGIN CERTIFICATE-----\\ntest-root\\n-----END CERTIFICATE-----\\n');\n  fs.writeFileSync(paths.rootKey, 'test-key');\n  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-ca-setup-'));\n  const config = path.join(tempDir, 'Caddyfile');\n  fs.writeFileSync(path.join(tempDir, 'owner-token'), context.owner.id);\n  fs.writeFileSync(config, 'temporary setup config');\n  context.updateGateway({ pid: process.pid, process_start: context.owner.process_start, binary: pinnedCaddyBinary(paths.home), config, temp_dir: tempDir });\n  process.stdout.write('locked\\n');\n  await new Promise(() => setInterval(() => {}, 1000));\n} });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, fx.paths.home], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const [signal] = await once(child.stdout, "data");
      expect(signal.toString()).toContain("locked");
      const lock = path.join(fx.paths.authorityDir, ".ca-setup.lock");
      const previousOwner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
      expect(previousOwner.pid).toBe(child.pid);
      expect(fs.existsSync(previousOwner.gateway.temp_dir)).toBe(true);
      child.kill("SIGKILL");
      await once(child, "exit");
      await expect(setupLocalCa(fx.paths, fx.effects)).resolves.toMatchObject({ state: "trusted" });
      expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 1, closes: 1 });
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(previousOwner.gateway.temp_dir)).toBe(false);
      expect(fs.readFileSync(fx.paths.rootCert, "utf8")).toContain("test-root");
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
  });

  it("preserves the owner lock when its temporary gateway cannot be cleaned", async () => {
    const fx = fixture();
    const originalBootstrap = fx.effects.bootstrap;
    fx.effects.bootstrap = async () => {
      const session = await originalBootstrap();
      return { ...session, close: async () => { throw new Error("temporary gateway still running"); } };
    };
    await expect(setupLocalCa(fx.paths, fx.effects)).rejects.toThrow("temporary gateway still running");
    const lock = path.join(fx.paths.authorityDir, ".ca-setup.lock");
    expect(fs.existsSync(path.join(lock, "owner.json"))).toBe(true);
    await expect(setupLocalCa(fx.paths, fx.effects)).rejects.toThrow("already in progress");
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("refuses a partial untracked CA instead of silently generating a replacement root", async () => {
    const fx = fixture();
    fs.mkdirSync(path.dirname(fx.paths.rootCert), { recursive: true });
    fs.writeFileSync(fx.paths.rootCert, "-----BEGIN CERTIFICATE-----\npartial\n-----END CERTIFICATE-----\n");
    await expect(setupLocalCa(fx.paths, fx.effects)).rejects.toThrow();
    expect(fx.counts()).toEqual({ approvals: 0, bootstraps: 0, closes: 0 });
  });

  it("treats dangling certificate and receipt links as custody errors", async () => {
    const root = fixture();
    fs.mkdirSync(path.dirname(root.paths.rootCert), { recursive: true });
    fs.symlinkSync(path.join(root.paths.home, "missing-certificate"), root.paths.rootCert);
    expect(assertLocalCaIdentity(root.paths)).toMatchObject({ state: "untracked_root" });
    await expect(setupLocalCa(root.paths, root.effects)).rejects.toThrow("not a regular file");
    expect(root.counts().bootstraps).toBe(0);

    const receipt = fixture();
    fs.mkdirSync(receipt.paths.authorityDir, { recursive: true });
    fs.symlinkSync(path.join(receipt.paths.home, "missing-receipt"), receipt.paths.receipt);
    expect(() => assertLocalCaIdentity(receipt.paths)).toThrow("not a regular file");
    await expect(setupLocalCa(receipt.paths, receipt.effects)).rejects.toThrow("not a regular file");
    expect(receipt.counts().bootstraps).toBe(0);
  });
});
