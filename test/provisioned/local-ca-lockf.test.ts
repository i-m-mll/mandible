// @vitest-environment node
// Provisioned macOS extended proof: process-lifetime lockf, SIGKILL, and a clang-built independent gateway.

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupLocalCa } from "../../scripts/local-ca-trust.mjs";
import { pinnedCaddyBinary } from "../../scripts/pinned-caddy.mjs";
import { localCaFixture } from "../helpers/local-ca-fixture";

if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/clang")) throw new Error("This extended CA lock proof requires macOS and Xcode Command Line Tools (/usr/bin/clang).");

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ca-lockf-"));
  roots.add(home);
  return localCaFixture(home);
}

function compileFakeCaddy(home: string) {
  const binary = pinnedCaddyBinary(home);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const source = path.join(home, "fake-caddy.c");
  fs.writeFileSync(source, "#include <unistd.h>\nint main(void) { for (;;) sleep(1); }\n");
  const result = spawnSync("/usr/bin/clang", [source, "-o", binary], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return binary;
}

async function startInterruptedSetup(home: string, phase: "lock" | "intent" | "spawn") {
  const moduleUrl = new URL("../../scripts/local-ca-trust.mjs", import.meta.url).href;
  const binaryUrl = new URL("../../scripts/pinned-caddy.mjs", import.meta.url).href;
  const script = `import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';\nimport { setupLocalCa, localCaPaths } from ${JSON.stringify(moduleUrl)};\nimport { pinnedCaddyBinary } from ${JSON.stringify(binaryUrl)};\nconst paths = localCaPaths(process.argv[1]);\nawait setupLocalCa(paths, { bootstrap: async (context) => {\n  let gateway = null;\n  if (${JSON.stringify(phase)} !== 'lock') {\n    fs.mkdirSync(path.dirname(paths.rootCert), { recursive: true });\n    fs.writeFileSync(paths.rootCert, '-----BEGIN CERTIFICATE-----\\ntest-root\\n-----END CERTIFICATE-----\\n');\n    fs.writeFileSync(paths.rootKey, 'test-key');\n    const intent = context.publishGatewayIntent(pinnedCaddyBinary(paths.home));\n    fs.writeFileSync(intent.config, 'temporary setup config');\n    if (${JSON.stringify(phase)} === 'spawn') {\n      gateway = spawn(intent.binary, ['run', '--config', intent.config, '--adapter', 'caddyfile'], { stdio: 'ignore' });\n      await new Promise((resolve, reject) => { gateway.once('spawn', resolve); gateway.once('error', reject); });\n    }\n  }\n  process.stdout.write('at-${phase}' + (gateway ? ':' + gateway.pid : '') + '\\n');\n  await new Promise(() => setInterval(() => {}, 1000));\n} });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, home], { stdio: ["ignore", "pipe", "pipe"] });
  let errorOutput = "";
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  try {
    const marker = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`setup child did not reach ${phase}: ${errorOutput}`)), 3000);
      child.stdout.once("data", (chunk) => { clearTimeout(timeout); if (chunk.toString().includes(`at-${phase}`)) resolve(chunk.toString().trim()); else reject(new Error(`unexpected setup marker: ${chunk}`)); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`setup child exited ${code}: ${errorOutput}`)); });
    });
    return { child, marker };
  } catch (error) { child.kill("SIGKILL"); throw error; }
}

function retrySetupChild(home: string) {
  const moduleUrl = new URL("../../scripts/local-ca-trust.mjs", import.meta.url).href;
  const script = `import { setupLocalCa, localCaPaths } from ${JSON.stringify(moduleUrl)};\ntry {\n  const result = await setupLocalCa(localCaPaths(process.argv[1]), {\n    bootstrap: async () => { await new Promise((resolve) => setTimeout(resolve, 500)); return { probePinnedRoot: async () => true, probeNativeTrust: async () => 'trusted', close: async () => {} }; },\n    approveTrust: async () => { throw new Error('unexpected OS approval'); },\n  });\n  process.stdout.write(result.state + '\\n');\n} catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, home], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
}

describe("macOS local CA process-lifetime recovery", () => {
  it("rejects a concurrent setup action before either can ask macOS to trust a root", async () => {
    const fx = fixture();
    const originalBootstrap = fx.effects.bootstrap;
    let release!: () => void;
    let entered!: () => void;
    const atBootstrap = new Promise<void>((resolve) => { entered = resolve; });
    fx.effects.bootstrap = async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return originalBootstrap();
    };
    const first = setupLocalCa(fx.paths, fx.effects);
    await atBootstrap;
    await expect(setupLocalCa(fx.paths, fx.effects)).rejects.toThrow("already in progress");
    release();
    await expect(first).resolves.toMatchObject({ state: "trusted" });
    expect(fx.counts()).toEqual({ approvals: 1, bootstraps: 1, closes: 1 });
  });

  it("retries after SIGKILL between process lock acquisition and gateway intent", async () => {
    const fx = fixture();
    const { child } = await startInterruptedSetup(fx.paths.home, "lock");
    try {
      expect(fs.existsSync(path.join(fx.paths.authorityDir, ".ca-setup.process.lock"))).toBe(true);
      expect(fs.existsSync(path.join(fx.paths.authorityDir, ".ca-setup-intent.json"))).toBe(false);
      child.kill("SIGKILL");
      await once(child, "exit");
      await expect(setupLocalCa(fx.paths, fx.effects)).resolves.toMatchObject({ state: "trusted" });
      expect(fx.counts().approvals).toBe(1);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });

  it("retries after SIGKILL following intent publication but before child spawn", async () => {
    const fx = fixture();
    const { child } = await startInterruptedSetup(fx.paths.home, "intent");
    try {
      const intentFile = path.join(fx.paths.authorityDir, ".ca-setup-intent.json");
      const intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
      expect(fs.existsSync(intent.temp_dir)).toBe(true);
      child.kill("SIGKILL");
      await once(child, "exit");
      await expect(setupLocalCa(fx.paths, fx.effects)).resolves.toMatchObject({ state: "trusted" });
      expect(fs.existsSync(intentFile)).toBe(false);
      expect(fs.existsSync(intent.temp_dir)).toBe(false);
      expect(fs.readFileSync(fx.paths.rootCert, "utf8")).toContain("test-root");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });

  it("serializes simultaneous retries while recovering a live orphan child spawned after its durable intent", async () => {
    const fx = fixture();
    const binary = compileFakeCaddy(fx.paths.home);
    const { child, marker } = await startInterruptedSetup(fx.paths.home, "spawn");
    const gatewayPid = Number(marker.split(":")[1]);
    expect(Number.isInteger(gatewayPid) && gatewayPid > 0).toBe(true);
    const intentFile = path.join(fx.paths.authorityDir, ".ca-setup-intent.json");
    const intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
    const rootBefore = fs.readFileSync(fx.paths.rootCert);
    const keyBefore = fs.readFileSync(fx.paths.rootKey);
    try {
      const running = spawnSync("/bin/ps", ["-ww", "-p", String(gatewayPid), "-o", "command="], { encoding: "utf8" });
      expect(running.stdout).toContain(`${binary} run --config ${intent.config} --adapter caddyfile`);
      child.kill("SIGKILL");
      await once(child, "exit");
      const orphan = spawnSync("/bin/ps", ["-ww", "-p", String(gatewayPid), "-o", "command="], { encoding: "utf8" });
      expect(orphan.stdout).toContain(`${binary} run --config ${intent.config} --adapter caddyfile`);
      const results = await Promise.all([retrySetupChild(fx.paths.home), retrySetupChild(fx.paths.home)]);
      expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
      expect(results.find((result) => result.code === 0)?.stdout).toContain("trusted");
      expect(results.find((result) => result.code === 1)?.stderr).toContain("already in progress");
      expect(fs.existsSync(intentFile)).toBe(false);
      expect(fs.existsSync(intent.temp_dir)).toBe(false);
      expect(fs.readFileSync(fx.paths.rootCert)).toEqual(rootBefore);
      expect(fs.readFileSync(fx.paths.rootKey)).toEqual(keyBefore);
      const stopped = spawnSync("/bin/ps", ["-ww", "-p", String(gatewayPid), "-o", "stat="], { encoding: "utf8" });
      expect(stopped.status === 1 || stopped.stdout.trim().startsWith("Z")).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const current = spawnSync("/bin/ps", ["-ww", "-p", String(gatewayPid), "-o", "command="], { encoding: "utf8" });
      if (current.stdout.trim().startsWith(binary)) process.kill(gatewayPid, "SIGKILL");
    }
  });

});
