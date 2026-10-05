import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type OperatorProofResult =
  | { ok: true; credentialId: string; signature: string }
  | { ok: false; reason: "missing_key" | "timeout" | "cancelled" | "signing_failed" | "untrusted_signature"; detail: string };

export function operatorGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as NodeJS.ProcessEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_CONFIG_") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG"].includes(name)) delete env[name];
  }
  return env;
}

function isExecutable(program: string): boolean {
  try { accessSync(program, constants.X_OK); return true; } catch { return false; }
}

export function operatorSigningProgram(configured: string | null, executable = isExecutable): string | null {
  if (configured) return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  return ["/opt/homebrew/opt/openssh/bin/ssh-keygen", "/usr/local/opt/openssh/bin/ssh-keygen", "/usr/bin/ssh-keygen", "/bin/ssh-keygen"]
    .find(executable) ?? null;
}

export async function signOperatorChallenge(
  cwd: string | null,
  challenge: string,
  allowedSigners: string[],
  signal?: AbortSignal,
): Promise<OperatorProofResult> {
  const gitEnv = operatorGitEnv();
  const config = spawnSync("git", ["config", "--get", "user.signingkey"], {
    cwd: cwd ?? undefined, encoding: "utf8", timeout: 5_000,
    env: gitEnv,
  });
  const configuredKey = config.stdout?.trim();
  const key = configuredKey?.startsWith("~/") ? join(homedir(), configuredKey.slice(2)) : configuredKey;
  if (!key || allowedSigners.length === 0) {
    return { ok: false, reason: "missing_key", detail: "Configure and register the operator signing key before approving." };
  }
  const signerConfig = spawnSync("git", ["config", "--includes", "--null", "--show-scope", "--get-all", "gpg.ssh.program"], {
    cwd: cwd ?? undefined, encoding: "utf8", timeout: 5_000, env: gitEnv,
  });
  if (signerConfig.status !== 0 && signerConfig.status !== 1) {
    return { ok: false, reason: "signing_failed", detail: "Could not read the operator's Git signing program configuration." };
  }
  const output = signerConfig.stdout ?? "";
  const entries = output ? output.slice(0, -1).split("\0") : [];
  if ((output && !output.endsWith("\0")) || entries.length % 2 !== 0
    || entries.some((value, index) => index % 2 === 0 && !["system", "global", "local", "worktree", "command"].includes(value))) {
    return { ok: false, reason: "signing_failed", detail: "Git returned malformed signing program scope metadata." };
  }
  let configuredSigner: string | null = null;
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (entries[index] === "global" || entries[index] === "system") configuredSigner = entries[index + 1]!.trim() || null;
  }
  const signer = operatorSigningProgram(configuredSigner);
  if (!signer) {
    return { ok: false, reason: "signing_failed", detail: "No executable OpenSSH signer is available; configure the operator's global gpg.ssh.program with a FIDO-capable signer for security keys." };
  }
  const signed = await new Promise<{ code: number | null; timedOut: boolean; signature: string; error: string }>((resolve) => {
    const child = spawn(signer, ["-Y", "sign", "-n", "mandible-auth", "-f", key], {
      cwd: cwd ?? undefined, stdio: ["pipe", "pipe", "pipe"], env: gitEnv,
    });
    let signature = "";
    let error = "";
    let timedOut = false;
    const cancel = () => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
    child.stdout.on("data", (data) => { signature += data.toString(); });
    child.stderr.on("data", (data) => { error += data.toString(); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: null, timedOut, signature, error: err.message }); });
    child.on("close", (code) => { signal?.removeEventListener("abort", cancel); clearTimeout(timer); resolve({ code, timedOut, signature, error }); });
    child.stdin.on("error", (err) => { error += err.message; });
    child.stdin.end(challenge);
  });
  if (signed.code !== 0 || signal?.aborted) {
    return { ok: false, reason: signal?.aborted ? "cancelled" : signed.timedOut ? "timeout" : "signing_failed", detail: `${signer}: ${signed.error.trim() || "Operator signing was cancelled or failed."}` };
  }
  const dir = mkdtempSync(join(tmpdir(), "mandible-operator-proof-"));
  try {
    const signaturePath = join(dir, "signature");
    const allowedPath = join(dir, "allowed-signers");
    writeFileSync(signaturePath, signed.signature, { mode: 0o600 });
    writeFileSync(allowedPath, allowedSigners.join("\n") + "\n", { mode: 0o600 });
    for (const line of allowedSigners) {
      const credentialId = line.split(" ")[0]!;
      const verified = spawnSync("/usr/bin/ssh-keygen", ["-Y", "verify", "-n", "mandible-auth", "-f", allowedPath, "-I", credentialId, "-s", signaturePath], {
        input: challenge, encoding: "utf8", timeout: 5_000,
      });
      if (verified.status === 0) return { ok: true, credentialId, signature: signed.signature };
    }
    return { ok: false, reason: "untrusted_signature", detail: "The signature does not match an active operator credential." };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
