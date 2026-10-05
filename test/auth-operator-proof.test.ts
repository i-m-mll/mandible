import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operatorSigningProgram, signOperatorChallenge } from "../src/auth-operator-proof.js";

let repo: string;
let key: string;
let allowed: string[];
let priorHome: string | undefined;
const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null" } });
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mandible-proof-test-"));
  priorHome = process.env.HOME;
  process.env.HOME = repo;
  key = join(repo, "operator-key");
  git(["init", "-b", "main"]);
  spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  git(["config", "user.signingkey", key]);
  allowed = [`operator-credential ${readFileSync(`${key}.pub`, "utf8").trim()}`];
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  rmSync(repo, { recursive: true, force: true });
});

describe("fresh operator proof", () => {
  it("uses the operator's global include signer, ignores a hostile repository signer, and independently rejects forged output", async () => {
    const program = join(repo, "operator signer");
    const trace = join(repo, "signer-argv");
    writeFileSync(program, `#!/bin/bash\nprintf '%s\\n' "$@" >> '${trace}'\nexec /usr/bin/ssh-keygen "$@"\n`, { mode: 0o700 });
    writeFileSync(join(repo, ".gitconfig"), '[include]\n  path = signer.config\n');
    writeFileSync(join(repo, "signer.config"), `[gpg "ssh"]\n  program = "${program}"\n`);
    const hostile = join(repo, "hostile");
    writeFileSync(hostile, '#!/bin/bash\necho repository-signer-ran >&2\nexit 93\n', { mode: 0o700 });
    git(["config", "gpg.ssh.program", hostile]);
    const proof = await signOperatorChallenge(repo, "exact challenge", allowed);
    expect(proof).toMatchObject({ ok: true, credentialId: "operator-credential" });
    expect(readFileSync(trace, "utf8")).toBe(`-Y\nsign\n-n\nmandible-auth\n-f\n${key}\n`);
    writeFileSync(program, '#!/bin/bash\nprintf "not a valid signature\\n"\nexit 0\n', { mode: 0o700 });
    expect(await signOperatorChallenge(repo, "exact challenge", allowed)).toMatchObject({ ok: false, reason: "untrusted_signature" });
    writeFileSync(program, '#!/bin/bash\necho configured-signer-failed >&2\nexit 29\n', { mode: 0o700 });
    expect(await signOperatorChallenge(repo, "exact challenge", allowed)).toMatchObject({ ok: false, reason: "signing_failed", detail: `${program}: configured-signer-failed` });
    rmSync(program);
    expect(await signOperatorChallenge(repo, "exact challenge", allowed)).toMatchObject({ ok: false, reason: "signing_failed" });
    writeFileSync(join(repo, "signer.config"), '[gpg "ssh"]\n  program = ./hostile\n');
    expect(await signOperatorChallenge(repo, "exact challenge", allowed)).toMatchObject({ ok: false, reason: "signing_failed", detail: expect.stringContaining("absolute executable path") });
  });

  it("selects known executable Homebrew OpenSSH before the system signer independently of PATH", () => {
    const arm = "/opt/homebrew/opt/openssh/bin/ssh-keygen";
    const intel = "/usr/local/opt/openssh/bin/ssh-keygen";
    const system = "/usr/bin/ssh-keygen";
    expect(operatorSigningProgram(null, path => [arm, intel, system].includes(path))).toBe(arm);
    expect(operatorSigningProgram(null, path => [intel, system].includes(path))).toBe(intel);
    expect(operatorSigningProgram(null, path => path === system)).toBe(system);
    expect(operatorSigningProgram(null, () => false)).toBeNull();
    expect(operatorSigningProgram("/operator/configured-signer", () => false)).toBe("/operator/configured-signer");
    expect(operatorSigningProgram("./repository-signer", () => true)).toBeNull();
    expect(operatorSigningProgram("ssh-keygen", () => true)).toBeNull();
  });

  it("times out the selected signer without reusable proof or retrying another executable", async () => {
    const program = join(repo, "waiting-signer");
    writeFileSync(program, '#!/bin/bash\nexec /bin/sleep 30\n', { mode: 0o700 });
    writeFileSync(join(repo, ".gitconfig"), `[gpg "ssh"]\n  program = "${program}"\n`);
    vi.useFakeTimers();
    try {
      const proof = signOperatorChallenge(repo, "challenge", allowed);
      vi.advanceTimersByTime(60_000);
      expect(await proof).toMatchObject({ ok: false, reason: "timeout" });
    } finally { vi.useRealTimers(); }
  });

  it("verifies registered operator proof bound to exact challenge bytes", async () => {
    const challenge = JSON.stringify({ request_id: "request", nonce: "fresh", action_digest: "exact", expires_at: 100 });
    const proof = await signOperatorChallenge(repo, challenge, allowed);
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    expect(proof.credentialId).toBe("operator-credential");
    const signature = join(repo, "proof.sig");
    const signers = join(repo, "allowed");
    writeFileSync(signature, proof.signature);
    writeFileSync(signers, allowed.join("\n"));
    const verify = (input: string) => spawnSync("/usr/bin/ssh-keygen", ["-Y", "verify", "-n", "mandible-auth", "-f", signers, "-I", "operator-credential", "-s", signature], { input, encoding: "utf8" }).status;
    expect(verify(challenge)).toBe(0);
    expect(verify(challenge.replace("exact", "changed"))).not.toBe(0);
    expect(verify(challenge.replace("fresh", "replayed"))).not.toBe(0);
  });

  it("refuses missing keys and signatures by an unregistered key", async () => {
    git(["config", "user.signingkey", join(repo, "absent")]);
    expect(await signOperatorChallenge(repo, "challenge", allowed)).toMatchObject({ ok: false, reason: "signing_failed" });
    git(["config", "user.signingkey", key]);
    const other = join(repo, "other-key");
    spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);
    const otherAllowed = [`other ${readFileSync(`${other}.pub`, "utf8").trim()}`];
    expect(await signOperatorChallenge(repo, "challenge", otherAllowed)).toMatchObject({ ok: false, reason: "untrusted_signature" });
    expect(await signOperatorChallenge(repo, "challenge", [])).toMatchObject({ ok: false, reason: "missing_key" });
  });

  it("cancels signing without producing reusable proof", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await signOperatorChallenge(repo, "challenge", allowed, controller.signal)).toMatchObject({ ok: false, reason: "cancelled" });
  });
});
