#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CADDY_VERSION, installPinnedCaddy, pinnedCaddyBinary } from "./pinned-caddy.mjs";

const SCHEMA = "mandible-local-ca-trust@1";
const LOCK_SCHEMA = "mandible-local-ca-setup-lock@1";
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

export function probeCurrentMacOsTrust(paths) {
  if (assertLocalCaIdentity(paths).state !== "trusted") throw new Error("The installation-owned Caddy root has not passed explicit secure-local-connections setup.");
  if (process.platform !== "darwin") throw new Error("Current local CA trust verification requires macOS.");
  const result = spawnSync("/usr/bin/security", ["verify-cert", "-c", paths.rootCert, "-p", "ssl", "-l", "-L", "-q"], { encoding: "utf8" });
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

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("CA setup owner PID is invalid.");
  const read = (field) => spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", `${field}=`], { encoding: "utf8" });
  const started = read("lstart");
  const command = read("command");
  const state = read("stat");
  if ([started, command, state].every((result) => result.status === 1 && !result.stdout.trim() && !result.stderr.trim())) return null;
  if ([started, command, state].some((result) => result.status !== 0 || !result.stdout.trim())) throw new Error(`Cannot verify CA setup process identity for PID ${pid}; preserving its lock.`);
  if (state.stdout.trim().startsWith("Z")) return null;
  return { pid, process_start: started.stdout.trim(), command: command.stdout.trim() };
}

function ownerFile(lock) { return path.join(lock, "owner.json"); }

function readOwner(lock, paths) {
  const owner = JSON.parse(regularBytes(ownerFile(lock), "CA setup lock owner").toString("utf8"));
  if (owner.schema !== LOCK_SCHEMA || !/^[0-9a-f-]{36}$/.test(owner.id ?? "") || owner.home !== paths.home || owner.home_digest !== digest(paths.home) || !Number.isInteger(owner.pid) || !owner.process_start || !owner.command) throw new Error("CA setup lock ownership is incompatible or ambiguous; preserving the lock.");
  return owner;
}

function writeOwner(lock, owner) {
  const temp = path.join(lock, `.owner-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, ownerFile(lock));
  } finally { if (existsEntry(temp)) fs.rmSync(temp, { force: true }); }
}

async function cleanupOwnedGateway(owner) {
  const gateway = owner.gateway;
  if (!gateway) return;
  if (path.dirname(gateway.temp_dir ?? "") !== os.tmpdir() || !/^mandible-ca-setup-[A-Za-z0-9]{6}$/.test(path.basename(gateway.temp_dir ?? "")) || gateway.config !== path.join(gateway.temp_dir, "Caddyfile") || gateway.binary !== pinnedCaddyBinary(owner.home) || !Number.isInteger(gateway.pid) || !gateway.process_start) throw new Error("Interrupted setup gateway ownership is ambiguous; preserving it and the lock.");
  if (existsEntry(gateway.temp_dir)) {
    const marker = path.join(gateway.temp_dir, "owner-token");
    if (regularBytes(marker, "temporary setup ownership marker").toString("utf8") !== owner.id) throw new Error("Temporary setup gateway ownership marker drifted; preserving it and the lock.");
  }
  const current = processIdentity(gateway.pid);
  if (current && current.process_start === gateway.process_start) {
    if (!current.command.startsWith(`${gateway.binary} run --config ${gateway.config} --adapter caddyfile`)) throw new Error("Temporary setup gateway process no longer matches its ownership receipt; preserving it and the lock.");
    process.kill(gateway.pid, "SIGTERM");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && processIdentity(gateway.pid)?.process_start === gateway.process_start) await new Promise((resolve) => setTimeout(resolve, 80));
    if (processIdentity(gateway.pid)?.process_start === gateway.process_start) {
      process.kill(gateway.pid, "SIGKILL");
      if (processIdentity(gateway.pid)?.process_start === gateway.process_start) throw new Error("Interrupted setup gateway did not stop; preserving its lock and temporary files.");
    }
  }
  if (existsEntry(gateway.temp_dir)) fs.rmSync(gateway.temp_dir, { recursive: true, force: true });
}

async function recoverStaleLock(lock, paths) {
  const before = fs.lstatSync(lock);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("CA setup lock is not an owned directory; preserving it.");
  const owner = readOwner(lock, paths);
  const ownerDigest = digest(regularBytes(ownerFile(lock), "CA setup lock owner"));
  const current = processIdentity(owner.pid);
  if (current?.process_start === owner.process_start && current.command === owner.command) throw new Error(`Secure-local-connections setup is already in progress under PID ${owner.pid}; preserving its lock.`);
  const quarantine = `${lock}.stale-${randomUUID()}`;
  fs.renameSync(lock, quarantine);
  try {
    const moved = fs.lstatSync(quarantine);
    if (moved.dev !== before.dev || moved.ino !== before.ino || digest(regularBytes(ownerFile(quarantine), "CA setup lock owner")) !== ownerDigest || readOwner(quarantine, paths).id !== owner.id) throw new Error("CA setup lock changed during stale-owner recovery; preserving it.");
    await cleanupOwnedGateway(owner);
    if (fs.readdirSync(quarantine).some((entry) => entry !== "owner.json")) throw new Error("Interrupted CA setup lock contains unknown files; preserving it.");
    fs.rmSync(ownerFile(quarantine));
    fs.rmdirSync(quarantine);
  } catch (error) {
    if (!existsEntry(lock)) fs.renameSync(quarantine, lock);
    throw error;
  }
}

async function acquireSetupLock(paths) {
  fs.mkdirSync(paths.authorityDir, { recursive: true, mode: 0o700 });
  const lock = path.join(paths.authorityDir, ".ca-setup.lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    await recoverStaleLock(lock, paths);
    fs.mkdirSync(lock, { mode: 0o700 });
  }
  try {
    const identity = processIdentity(process.pid);
    if (!identity) throw new Error("Cannot verify this CA setup process identity.");
    const owner = { schema: LOCK_SCHEMA, id: randomUUID(), home: paths.home, home_digest: digest(paths.home), ...identity };
    writeOwner(lock, owner);
    return { lock, owner, updateGateway: (gateway) => { const next = { ...owner, gateway }; writeOwner(lock, next); } };
  } catch (error) { fs.rmdirSync(lock); throw error; }
}

export async function setupLocalCa(paths, effects = systemTrustEffects(paths)) {
  const context = await acquireSetupLock(paths);
  try { return await reconcileLocalCa(paths, effects, context); }
  finally {
    if (!context.preserveLock) {
      if (readOwner(context.lock, paths).id !== context.owner.id) throw new Error("CA setup lock owner changed; preserving its lock.");
      fs.rmSync(ownerFile(context.lock));
      fs.rmdirSync(context.lock);
    }
  }
}

async function reconcileLocalCa(paths, effects, context) {
  const prior = assertLocalCaIdentity(paths);
  if (!existsEntry(paths.installationAuthority)) throw new Error("Installation authority is not initialized; run npm run local-front-door -- initialize before secure-local-connections setup.");
  const installationDigest = digest(regularBytes(paths.installationAuthority, "installation authority"));
  const existingRoot = prior.state === "untracked_root" ? rootDigest(paths) : null;
  const existingKey = prior.state === "untracked_root" ? keyDigest(paths) : null;
  const session = await effects.bootstrap(context);
  try {
    const root = rootDigest(paths);
    const key = keyDigest(paths);
    if ((prior.root_digest && prior.root_digest !== root) || (existingRoot && existingRoot !== root) || (existingKey && existingKey !== key)) throw new Error("Caddy root or signing key changed while the setup gateway started.");
    if (prior.state === "not_set_up" || prior.state === "untracked_root") writeReceipt(paths, {
      schema: SCHEMA, state: "prepared", caddy_version: CADDY_VERSION, storage_root: paths.storageRoot,
      installation_digest: installationDigest, root_digest: root, key_digest: key, created_at: new Date().toISOString(),
    });
    assertLocalCaIdentity(paths);
    if (!await session.probePinnedRoot()) throw new Error("Setup gateway did not serve a certificate signed by the pinned Caddy root.");
    let native = await session.probeNativeTrust();
    if (native === "untrusted") {
      const record = readReceipt(paths);
      writeReceipt(paths, { ...record, state: "prepared" });
      await effects.approveTrust(root);
      native = await session.probeNativeTrust();
    }
    if (native !== "trusted") throw new Error("macOS did not trust the exact Mandible root after setup; inspect system certificate approval and retry this action.");
    assertLocalCaIdentity(paths);
    const record = readReceipt(paths);
    writeReceipt(paths, { ...record, state: "trusted", verified_at: new Date().toISOString() });
    return assertLocalCaIdentity(paths);
  } finally {
    try { await session.close(); }
    catch (error) { context.preserveLock = true; throw error; }
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ca-setup-"));
  const config = path.join(tempDir, "Caddyfile");
  fs.writeFileSync(path.join(tempDir, "owner-token"), context.owner.id, { flag: "wx", mode: 0o600 });
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
      if (running()) throw new Error("Temporary Caddy setup gateway did not stop; preserving its ownership lock and files.");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    let childIdentity = null;
    const identityDeadline = Date.now() + 1_000;
    while (!childIdentity && child.exitCode === null && Date.now() < identityDeadline) {
      childIdentity = processIdentity(child.pid);
      if (!childIdentity) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (!childIdentity) throw new Error("Temporary Caddy setup gateway exited before its ownership could be recorded.");
    context.updateGateway({ pid: child.pid, process_start: childIdentity.process_start, binary, config, temp_dir: tempDir });
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
    try { await close(); }
    catch (cleanupError) { context.preserveLock = true; throw cleanupError; }
    throw error;
  }
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function osascript(script) {
  const result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`macOS certificate setup was declined or failed: ${(result.stderr || result.stdout).trim()}`);
}

function systemTrustEffects(paths) {
  return {
    bootstrap: (context) => bootstrapCaddy(paths, context),
    approveTrust: async (rootDigestValue) => {
      assertLocalCaIdentity(paths);
      if (rootDigest(paths) !== rootDigestValue) throw new Error("Caddy root changed before macOS approval; no trust was installed.");
      const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ca-approval-"));
      const snapshot = path.join(snapshotDir, "root.crt");
      try {
        fs.writeFileSync(snapshot, regularBytes(paths.rootCert, "Caddy root certificate"), { flag: "wx", mode: 0o600 });
        if (digest(regularBytes(snapshot, "approval certificate snapshot")) !== rootDigestValue) throw new Error("Caddy root changed before the approval snapshot; no trust was installed.");
        osascript(`display dialog ${JSON.stringify(`Mandible will trust its local HTTPS certificate authority in the macOS System Keychain. This is a computer-wide trust change, not browser sign-in. Root SHA-256: ${rootDigestValue}. Continue only if you requested secure local connections.`)} buttons {"Cancel", "Continue"} default button "Cancel" with icon caution`);
        const command = ["/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "ssl", "-k", "/Library/Keychains/System.keychain", snapshot].map(shellQuote).join(" ");
        osascript(`do shell script ${JSON.stringify(command)} with administrator privileges`);
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
