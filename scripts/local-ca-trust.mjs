#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CADDY_VERSION, installPinnedCaddy } from "./pinned-caddy.mjs";

const SCHEMA = "mandible-local-ca-trust@1";
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

export async function setupLocalCa(paths, effects = systemTrustEffects(paths)) {
  fs.mkdirSync(paths.authorityDir, { recursive: true, mode: 0o700 });
  const lock = path.join(paths.authorityDir, ".ca-setup.lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Secure-local-connections setup is already in progress or has a stale lock at ${lock}; inspect that exact lock before retrying.`);
    throw error;
  }
  try { return await reconcileLocalCa(paths, effects); }
  finally { fs.rmdirSync(lock); }
}

async function reconcileLocalCa(paths, effects) {
  const prior = assertLocalCaIdentity(paths);
  if (!existsEntry(paths.installationAuthority)) throw new Error("Installation authority is not initialized; run npm run local-front-door -- initialize before secure-local-connections setup.");
  const installationDigest = digest(regularBytes(paths.installationAuthority, "installation authority"));
  const existingRoot = prior.state === "untracked_root" ? rootDigest(paths) : null;
  const existingKey = prior.state === "untracked_root" ? keyDigest(paths) : null;
  const session = await effects.bootstrap();
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

async function bootstrapCaddy(paths) {
  if (process.platform !== "darwin") throw new Error("Secure local connections setup currently requires macOS.");
  const binary = installPinnedCaddy(paths.home);
  fs.mkdirSync(paths.storageRoot, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(paths.storageRoot).isDirectory()) throw new Error("Installation Caddy storage is not a directory.");
  const adminPort = await freePort();
  const sitePort = await freePort();
  if (adminPort === sitePort || [19419, 19420, 19421, 2019].includes(adminPort) || [19419, 19420, 19421, 2019].includes(sitePort)) throw new Error("Temporary setup ports collided with a public or ordinary gateway port; retry setup.");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ca-setup-"));
  const config = path.join(tempDir, "Caddyfile");
  fs.writeFileSync(config, setupCaddyfile(paths.storageRoot, adminPort, sitePort), { mode: 0o600 });
  const child = spawn(binary, ["run", "--config", config, "--adapter", "caddyfile"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  const close = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  try {
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

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function osascript(script) {
  const result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`macOS certificate setup was declined or failed: ${(result.stderr || result.stdout).trim()}`);
}

function systemTrustEffects(paths) {
  return {
    bootstrap: () => bootstrapCaddy(paths),
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
