#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireProcessLock as acquireKernelProcessLock } from "./process-lock.mjs";
import { CADDY_VERSION, installPinnedCaddy, pinnedCaddyBinary } from "./pinned-caddy.mjs";

const SCHEMA = "mandible-local-ca-trust@1";
const INTENT_SCHEMA = "mandible-local-ca-gateway-intent@1";
const SETUP_HOST = "setup.mandible.localhost";

export function setupCaddyfile(storageRoot, adminPort, sitePort) {
  if (![adminPort, sitePort].every((port) => Number.isInteger(port) && port > 0 && port < 65536) || adminPort === sitePort) throw new Error("Temporary setup ports must be distinct valid loopback ports.");
  return `{\n  admin 127.0.0.1:${adminPort}\n  storage file_system ${JSON.stringify(storageRoot)}\n  local_certs\n  skip_install_trust\n  auto_https disable_redirects\n}\n\nhttps://${SETUP_HOST}:${sitePort} {\n  bind 127.0.0.1\n  tls internal\n  respond "mandible-local-ca-ready"\n}\n`;
}

export function localCaPaths(home) {
  const authorityDir = path.join(path.resolve(home), "config", "local-sessions");
  const storageRoot = path.join(authorityDir, "caddy-storage");
  const caDir = path.join(storageRoot, "pki", "authorities", "local");
  return {
    home: path.resolve(home), authorityDir, storageRoot,
    rootCert: path.join(caDir, "root.crt"), rootKey: path.join(caDir, "root.key"),
    receipt: path.join(authorityDir, "ca-trust.json"),
    installationAuthority: path.join(path.resolve(home), "config", "client-auth", "authority-id"),
  };
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function existsEntry(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function regularBytes(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") throw new Error(`${label} is missing: ${file}`); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${file}`);
  return fs.readFileSync(file);
}

function rootDigest(paths) {
  const cert = regularBytes(paths.rootCert, "Caddy root certificate");
  if (!cert.toString("utf8").includes("-----BEGIN CERTIFICATE-----")) throw new Error("Caddy root certificate is not PEM material.");
  return digest(cert);
}

function keyDigest(paths) { return digest(regularBytes(paths.rootKey, "Caddy root private key")); }

function readReceipt(paths) {
  if (!existsEntry(paths.receipt)) return null;
  const record = JSON.parse(regularBytes(paths.receipt, "CA trust receipt").toString("utf8"));
  if (record.schema !== SCHEMA || !["prepared", "trusted"].includes(record.state) || record.caddy_version !== CADDY_VERSION || record.storage_root !== paths.storageRoot || !/^[a-f0-9]{64}$/.test(record.root_digest ?? "") || !/^[a-f0-9]{64}$/.test(record.key_digest ?? "") || !/^[a-f0-9]{64}$/.test(record.installation_digest ?? "")) throw new Error("Installation CA trust receipt is incompatible or ambiguous.");
  return record;
}

export function assertLocalCaIdentity(paths) {
  const record = readReceipt(paths);
  if (!record) return { state: existsEntry(paths.rootCert) || existsEntry(paths.rootKey) ? "untracked_root" : "not_set_up", storage_root: paths.storageRoot };
  const installationDigest = digest(regularBytes(paths.installationAuthority, "installation authority"));
  if (installationDigest !== record.installation_digest) throw new Error("Installation authority changed after local CA setup; refusing a different root.");
  if (rootDigest(paths) !== record.root_digest) throw new Error("Installation-owned Caddy root changed after local CA setup; refusing a different root.");
  if (keyDigest(paths) !== record.key_digest) throw new Error("Installation-owned Caddy root private key changed after local CA setup; refusing a different root.");
  return { state: record.state, storage_root: paths.storageRoot, root_digest: record.root_digest, verified_at: record.verified_at ?? null };
}

export function probeCurrentMacOsTrust(paths, { timeoutMs = 5000 } = {}) {
  if (assertLocalCaIdentity(paths).state !== "trusted") throw new Error("The installation-owned Caddy root has not passed explicit secure-local-connections setup.");
  if (process.platform !== "darwin") throw new Error("Current local CA trust verification requires macOS.");
  const result = spawnSync("/usr/bin/security", ["verify-cert", "-c", paths.rootCert, "-p", "ssl", "-l", "-L", "-q"], { encoding: "utf8", timeout: timeoutMs });
  if (result.status !== 0) throw new Error(`macOS no longer trusts the pinned local CA for HTTPS; no public listener was stopped. Reopen the explicit secure-local-connections setup action. ${(result.stderr || result.stdout).trim()}`);
  assertLocalCaIdentity(paths);
  return true;
}

function writeReceipt(paths, record) {
  fs.mkdirSync(paths.authorityDir, { recursive: true, mode: 0o700 });
  const temp = path.join(paths.authorityDir, `.ca-trust-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, paths.receipt);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function intentPath(paths) { return path.join(paths.authorityDir, ".ca-setup-intent.json"); }

function readIntent(paths) {
  if (!existsEntry(intentPath(paths))) return null;
  const intent = JSON.parse(regularBytes(intentPath(paths), "temporary gateway start intent").toString("utf8"));
  if (intent.schema !== INTENT_SCHEMA || !/^[0-9a-f-]{36}$/.test(intent.id ?? "") || intent.home !== paths.home || intent.binary !== pinnedCaddyBinary(paths.home) || intent.temp_dir !== path.join(os.tmpdir(), `mandible-ca-setup-${intent.id}`) || intent.config !== path.join(intent.temp_dir, "Caddyfile")) throw new Error("Temporary gateway start intent is ambiguous; preserving it for inspection.");
  return intent;
}

function writeIntent(paths, intent) {
  if (existsEntry(intentPath(paths))) throw new Error("A previous temporary gateway intent remains; recover it before starting another.");
  const temp = path.join(paths.authorityDir, `.ca-setup-intent-${intent.id}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(intent)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, intentPath(paths));
  } finally { if (existsEntry(temp)) fs.rmSync(temp, { force: true }); }
}

function gatewayMatches(intent) {
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=", "-o", "stat=", "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot inspect temporary gateway processes; preserving the start intent.");
  const expected = `${intent.binary} run --config ${intent.config} --adapter caddyfile`;
  const matches = result.stdout.split("\n").map((line) => /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line)).filter((match) => match?.[3] === expected && !match[2].startsWith("Z")).map((match) => Number(match[1]));
  if (matches.length > 1) throw new Error("Several processes match the exact temporary gateway intent; preserving it.");
  return matches[0] ?? null;
}

function signalGateway(intent, pid, signal) {
  if (gatewayMatches(intent) !== pid) return;
  try { process.kill(pid, signal); }
  catch (error) { if (error.code !== "ESRCH" || gatewayMatches(intent) === pid) throw error; }
}

async function recoverGatewayIntent(paths, context) {
  context.assertHeld();
  const intent = readIntent(paths);
  if (!intent) return;
  if (existsEntry(intent.temp_dir)) {
    const stat = fs.lstatSync(intent.temp_dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Temporary gateway directory changed; preserving its intent.");
    const marker = path.join(intent.temp_dir, "owner-token");
    if (existsEntry(marker)) {
      if (regularBytes(marker, "temporary gateway marker").toString("utf8") !== intent.id) throw new Error("Temporary gateway marker drifted; preserving its intent.");
    } else if (fs.readdirSync(intent.temp_dir).length !== 0) throw new Error("Unmarked temporary gateway directory has unknown bytes; preserving it.");
  }
  const pid = gatewayMatches(intent);
  if (pid) {
    context.assertHeld();
    signalGateway(intent, pid, "SIGTERM");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && gatewayMatches(intent) === pid) { context.assertHeld(); await new Promise((resolve) => setTimeout(resolve, 80)); }
    if (gatewayMatches(intent) === pid) {
      context.assertHeld();
      signalGateway(intent, pid, "SIGKILL");
      if (gatewayMatches(intent) === pid) throw new Error("Temporary gateway did not stop; preserving its intent and files.");
    }
  }
  context.assertHeld();
  if (existsEntry(intent.temp_dir)) {
    if (existsEntry(path.join(intent.temp_dir, "owner-token"))) fs.rmSync(intent.temp_dir, { recursive: true, force: true });
    else fs.rmdirSync(intent.temp_dir);
  }
  fs.rmSync(intentPath(paths));
}

async function acquireProcessLock(paths) {
  if (process.platform !== "darwin") throw new Error("Secure local connections setup currently requires macOS.");
  fs.mkdirSync(paths.authorityDir, { recursive: true, mode: 0o700 });
  if (existsEntry(path.join(paths.authorityDir, ".ca-setup.lock"))) throw new Error("A legacy CA setup directory lock remains; inspect that exact prior attempt before using the new setup action.");
  const kernel = await acquireKernelProcessLock(path.join(paths.authorityDir, ".ca-setup.process.lock"), {
    ownerFile: path.join(paths.authorityDir, ".ca-setup.process.owner"), label: "Secure-local-connections setup",
  });
  const { assertHeld } = kernel;
  try {
    return {
      assertHeld,
      publishGatewayIntent: (binary) => {
        assertHeld();
        if (binary !== pinnedCaddyBinary(paths.home)) throw new Error("Pinned Caddy binary changed before gateway intent publication.");
        const id = randomUUID();
        const temp_dir = path.join(os.tmpdir(), `mandible-ca-setup-${id}`);
        const intent = { schema: INTENT_SCHEMA, id, home: paths.home, binary, temp_dir, config: path.join(temp_dir, "Caddyfile") };
        writeIntent(paths, intent);
        fs.mkdirSync(temp_dir, { mode: 0o700 });
        fs.writeFileSync(path.join(temp_dir, "owner-token"), id, { flag: "wx", mode: 0o600 });
        return intent;
      },
      closeGatewayIntent: () => recoverGatewayIntent(paths, { assertHeld }),
      release: kernel.release,
    };
  } catch (error) { await kernel.release(); throw error; }
}

// The CLI and desktop use the real macOS lock; mocked state tests supply their own adapter.
export async function setupLocalCa(paths, effects = systemTrustEffects(paths), acquireLock = acquireProcessLock) {
  const context = await acquireLock(paths);
  try {
    context.assertHeld();
    await recoverGatewayIntent(paths, context);
    context.assertHeld();
    return await reconcileLocalCa(paths, effects, context);
  } finally { await context.release(); }
}

async function reconcileLocalCa(paths, effects, context) {
  const prior = assertLocalCaIdentity(paths);
  if (!existsEntry(paths.installationAuthority)) throw new Error("Installation authority is not initialized; run bun run local-front-door -- initialize before secure-local-connections setup.");
  const installationDigest = digest(regularBytes(paths.installationAuthority, "installation authority"));
  const existingRoot = prior.state === "untracked_root" ? rootDigest(paths) : null;
  const existingKey = prior.state === "untracked_root" ? keyDigest(paths) : null;
  const session = await effects.bootstrap(context);
  try {
    context.assertHeld();
    const root = rootDigest(paths);
    const key = keyDigest(paths);
    if ((prior.root_digest && prior.root_digest !== root) || (existingRoot && existingRoot !== root) || (existingKey && existingKey !== key)) throw new Error("Caddy root or signing key changed while the setup gateway started.");
    if (prior.state === "not_set_up" || prior.state === "untracked_root") writeReceipt(paths, {
      schema: SCHEMA, state: "prepared", caddy_version: CADDY_VERSION, storage_root: paths.storageRoot,
      installation_digest: installationDigest, root_digest: root, key_digest: key, created_at: new Date().toISOString(),
    });
    assertLocalCaIdentity(paths);
    context.assertHeld();
    if (!await session.probePinnedRoot()) throw new Error("Setup gateway did not serve a certificate signed by the pinned Caddy root.");
    let native = await session.probeNativeTrust();
    if (native === "untrusted") {
      const record = readReceipt(paths);
      context.assertHeld();
      writeReceipt(paths, { ...record, state: "prepared" });
      await effects.approveTrust(root, context);
      native = await session.probeNativeTrust();
    }
    if (native !== "trusted") throw new Error("macOS did not trust the exact Mandible root after setup; inspect system certificate approval and retry this action.");
    assertLocalCaIdentity(paths);
    context.assertHeld();
    const record = readReceipt(paths);
    writeReceipt(paths, { ...record, state: "trusted", verified_at: new Date().toISOString() });
    return assertLocalCaIdentity(paths);
  } finally {
    await session.close();
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function curlProbe(port, certPath = null) {
  const args = ["--silent", "--show-error", "--fail", "--max-time", "3", "--noproxy", "*", "--resolve", `${SETUP_HOST}:${port}:127.0.0.1`, certPath ? "--cacert" : "--ca-native", certPath ?? "", `https://${SETUP_HOST}:${port}/`].filter(Boolean);
  const result = spawnSync("/usr/bin/curl", args, { encoding: "utf8", env: { ...process.env, CURL_CA_BUNDLE: "", SSL_CERT_FILE: "", SSL_CERT_DIR: "" } });
  if (result.status === 0 && result.stdout.trim() === "mandible-local-ca-ready") return "trusted";
  if (!certPath && result.status === 60) return "untrusted";
  throw new Error(`Secure setup connection failed (curl ${result.status}): ${(result.stderr || result.stdout).trim()}`);
}

async function bootstrapCaddy(paths, context) {
  if (process.platform !== "darwin") throw new Error("Secure local connections setup currently requires macOS.");
  const binary = installPinnedCaddy(paths.home);
  fs.mkdirSync(paths.storageRoot, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(paths.storageRoot).isDirectory()) throw new Error("Installation Caddy storage is not a directory.");
  const adminPort = await freePort();
  const sitePort = await freePort();
  if (adminPort === sitePort || [19419, 19420, 19421, 2019].includes(adminPort) || [19419, 19420, 19421, 2019].includes(sitePort)) throw new Error("Temporary setup ports collided with a public or ordinary gateway port; retry setup.");
  context.assertHeld();
  const intent = context.publishGatewayIntent(binary);
  const tempDir = intent.temp_dir;
  const config = intent.config;
  fs.writeFileSync(config, setupCaddyfile(paths.storageRoot, adminPort, sitePort), { mode: 0o600 });
  const child = spawn(binary, ["run", "--config", config, "--adapter", "caddyfile"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  const close = async () => {
    const running = () => child.exitCode === null && child.signalCode === null;
    if (child.pid && running()) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (running()) {
        child.kill("SIGKILL");
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
      }
      if (running()) throw new Error("Temporary Caddy setup gateway did not stop; preserving its start intent and files.");
    }
    await context.closeGatewayIntent();
  };
  try {
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    context.assertHeld();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Temporary Caddy setup gateway exited: ${output.trim()}`);
      if (existsEntry(paths.rootCert)) {
        try { if (curlProbe(sitePort, paths.rootCert) === "trusted") return { probePinnedRoot: async () => curlProbe(sitePort, paths.rootCert) === "trusted", probeNativeTrust: async () => curlProbe(sitePort), close }; }
        catch { /* The temporary listener or leaf may still be starting. */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`Temporary Caddy setup gateway did not become ready: ${output.trim()}`);
  } catch (error) {
    await close();
    throw error;
  }
}

function nativeTrustHelper() {
  if (process.platform !== "darwin") throw new Error("Native HTTPS trust setup is unsupported on this platform.");
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(scriptDir, "local-ca-trust-helper"), // packaged desktop resource
    path.join(scriptDir, "..", "src-tauri", "resources", "local-ca-trust-helper"), // source checkout
  ];
  const helper = candidates.find((candidate) => existsEntry(candidate));
  if (!helper) throw new Error("Native macOS trust helper is missing; rebuild the desktop app or run scripts/build-local-ca-trust-helper.sh in the source checkout.");
  const stat = fs.lstatSync(helper);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw new Error("Native macOS trust helper is not an executable regular file.");
  return helper;
}

function systemTrustEffects(paths) {
  return {
    bootstrap: (context) => bootstrapCaddy(paths, context),
    approveTrust: async (rootDigestValue, context) => {
      context.assertHeld();
      assertLocalCaIdentity(paths);
      if (rootDigest(paths) !== rootDigestValue) throw new Error("Caddy root changed before macOS approval; no trust was installed.");
      const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ca-approval-"));
      const snapshot = path.join(snapshotDir, "root.crt");
      try {
        fs.writeFileSync(snapshot, regularBytes(paths.rootCert, "Caddy root certificate"), { flag: "wx", mode: 0o600 });
        if (digest(regularBytes(snapshot, "approval certificate snapshot")) !== rootDigestValue) throw new Error("Caddy root changed before the approval snapshot; no trust was installed.");
        context.assertHeld();
        // Human authorization is not an automated readiness timeout.
        const result = spawnSync(nativeTrustHelper(), [snapshot, rootDigestValue], { encoding: "utf8" });
        if (result.error || result.status !== 0) throw new Error(`This Mac did not complete secure local connections setup. macOS owns any account authentication; Mandible does not ask for a password. ${(result.stderr || result.stdout || result.error?.message || "Approval was declined or unavailable.").trim()}`);
        context.assertHeld();
        if (rootDigest(paths) !== rootDigestValue) throw new Error("Caddy root changed during macOS approval; the prepared setup remains pinned but cannot be marked trusted.");
      } finally {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      }
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const paths = localCaPaths(process.env.MANDIBLE_HOME || path.join(os.homedir(), ".mandible"));
  try {
    const command = process.argv[2] ?? "status";
    const result = command === "status" ? assertLocalCaIdentity(paths) : command === "setup" ? await setupLocalCa(paths) : null;
    if (!result) throw new Error("Usage: local-ca-trust.mjs status|setup");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
