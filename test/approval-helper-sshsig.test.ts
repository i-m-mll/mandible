import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

const root = path.join(testRuntimeRoot, "approval-helper-sshsig");
const run = (file: string, args: string[], options: { cwd?: string; input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync(file, args, { ...options, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });

function softwareSigner(namespace: string, messages: Buffer[]) {
  const signer = path.join(root, "signer");
  if (!fs.existsSync(signer)) {
    run("/usr/bin/xcrun", ["swiftc", "-Onone", "-module-cache-path", path.join(root, "module-cache"),
      "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx15.0`,
      "src-tauri/approval-helper/SSHSignature.swift", "test/fixtures/approval-helper/main.swift", "-o", signer]);
  }
  const files = messages.map((message, index) => {
    const file = path.join(root, `message-${namespace}-${index}`);
    fs.writeFileSync(file, message);
    return file;
  });
  const [publicKey, ...signatures] = run(signer, [namespace, ...files]).split("\0");
  return { publicKey, signatures };
}

it("produces SSH signatures that stock ssh-keygen verifies and that git accepts as a commit gpgsig", () => {
  fs.mkdirSync(root, { recursive: true });
  const messages = Array.from({ length: 12 }, (_, index) => Buffer.from(`message ${index}\n\u0000ÿ binary tail`));
  const { publicKey, signatures } = softwareSigner("mandible-test", messages);
  const allowed = path.join(root, "allowed_signers");
  fs.writeFileSync(allowed, `operator ${publicKey}\n`);
  messages.forEach((message, index) => {
    const signature = path.join(root, `signature-${index}`);
    fs.writeFileSync(signature, signatures[index]);
    run("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "operator", "-n", "mandible-test", "-s", signature], { input: message });
  });
  expect(() => run("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "operator", "-n", "git", "-s", path.join(root, "signature-0")], { input: messages[0] }))
    .toThrow();

  const repo = path.join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.invalid", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.invalid" };
  run("git", ["init", "-q", repo], { env });
  const tree = run("git", ["write-tree"], { cwd: repo, env }).trim();
  const unsigned = run("git", ["commit-tree", tree, "-m", "signed by the approval key"], { cwd: repo, env }).trim();
  const payload = run("git", ["cat-file", "commit", unsigned], { cwd: repo, env });
  const { publicKey: gitKey, signatures: [gpgsig] } = softwareSigner("git", [Buffer.from(payload)]);
  const header = `gpgsig ${gpgsig.trimEnd().split("\n").join("\n ")}\n`;
  const signed = payload.replace(/\n\n/, `\n${header}\n`);
  const commit = run("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, env, input: signed }).trim();
  fs.writeFileSync(allowed, `operator@example.invalid ${gitKey}\n`);
  const verified = spawnSync("git", ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", commit],
    { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
  expect(verified.status, verified.stderr).toBe(0);
});
