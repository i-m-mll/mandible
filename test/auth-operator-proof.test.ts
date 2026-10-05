import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signOperatorChallenge } from "../src/auth-operator-proof.js";

let repo: string;
let key: string;
let allowed: string[];
const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null" } });
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mandible-proof-test-"));
  key = join(repo, "operator-key");
  git(["init", "-b", "main"]);
  spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  git(["config", "user.signingkey", key]);
  allowed = [`operator-credential ${readFileSync(`${key}.pub`, "utf8").trim()}`];
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("fresh operator proof", () => {
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
