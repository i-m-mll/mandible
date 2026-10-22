// @vitest-environment node
/**
 * Issue 2205073 — the protected-merge signing credential is registered by
 * `mandible user setup`, so operators never meet signature_not_trusted on
 * their second queued approval. Review F5: setup registers only a key from
 * GLOBAL git config, because an operator credential is global by construction;
 * the explicit `user credential add --from-git-signingkey` may register a
 * repository-scoped key but must say which scope it came from.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, scratchDir, startStubDaemon, type StubDaemon } from "./helpers/cli-process.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A repository and a home whose git config scopes are pinned into the sandbox. */
function sandbox() {
  const root = scratchDir("signing");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const globalConfig = path.join(home, ".gitconfig");
  return {
    repo,
    /** Create a key and configure it as user.signingkey in `scope`. */
    key(scope: "global" | "local", name = "operator-signing") {
      const keyPath = path.join(home, ".ssh", name);
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
      const value = `~/.ssh/${name}.pub`;
      if (scope === "global") execFileSync("git", ["config", "--file", globalConfig, "user.signingkey", value]);
      else execFileSync("git", ["config", "user.signingkey", value], { cwd: repo });
      return {
        fingerprint: execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"], { encoding: "utf8" }).trim().split(/\s+/)[1]!,
        publicMaterial: fs.readFileSync(`${keyPath}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" "),
      };
    },
    run(stub: StubDaemon, args: string[]) {
      const inherited = Object.fromEntries(Object.keys(process.env)
        .filter((key) => key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))
        .map((key) => [key, undefined]));
      return runCli(args, {
        cwd: repo,
        env: {
          ...inherited,
          ...stub.env,
          HOME: home,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_CONFIG_SYSTEM: "/dev/null",
          MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
        },
      });
    },
  };
}

async function daemon(existingCredentials: Array<Record<string, unknown>> = []): Promise<StubDaemon> {
  const stub = await startStubDaemon(({ method, url }) => {
    if (method === "POST" && url === "/api/users/setup") return { body: { user: { id: "user-1", slug: "operator-slug", display_name: "Op", email: null } } };
    if (method === "GET" && url.endsWith("/credentials")) return { body: { credentials: existingCredentials } };
    if (method === "POST" && url.endsWith("/credentials")) return { status: 201, body: { credential: { id: "credential-1", type: "ssh_key", status: "active" } } };
    return undefined;
  });
  cleanups.push(() => stub.close());
  return stub;
}

const credentialPosts = (stub: StubDaemon) => stub.requests.filter((request) => request.method === "POST" && request.url.endsWith("/credentials"));

describe("user setup signing credential", () => {
  it("registers the global signing key, even when the repository overrides user.signingkey", async () => {
    const box = sandbox();
    const globalKey = box.key("global", "operator-signing");
    box.key("local", "repo-agent-signing");
    const stub = await daemon();

    const result = await box.run(stub, ["user", "setup", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(credentialPosts(stub)).toEqual([expect.objectContaining({
      url: "/api/users/operator-slug/credentials",
      body: { type: "ssh_key", fingerprint: globalKey.fingerprint, public_material: globalKey.publicMaterial, label: "git user.signingkey" },
    })]);
    expect(result.stderr).toContain("registered from global git config");
    expect(JSON.parse(result.stdout).user.slug).toBe("operator-slug");
  });

  it("adds a fingerprint once while it is active and again after it was revoked", async () => {
    const [active, revoked] = [sandbox(), sandbox()];
    const activeKey = active.key("global");
    const revokedKey = revoked.key("global");
    const [activeStub, revokedStub] = await Promise.all([
      daemon([{ id: "existing", type: "ssh_key", status: "active", fingerprint: activeKey.fingerprint, public_material: activeKey.publicMaterial }]),
      daemon([{ id: "old", type: "ssh_key", status: "revoked", fingerprint: revokedKey.fingerprint }]),
    ]);

    const results = await Promise.all([active.run(activeStub, ["user", "setup", "--json"]), revoked.run(revokedStub, ["user", "setup", "--json"])]);

    for (const result of results) expect(result.status, result.stderr).toBe(0);
    expect(credentialPosts(activeStub)).toHaveLength(0);
    expect(credentialPosts(revokedStub)).toHaveLength(1);
  });

  it("never promotes a repository-local key, and is quiet when no key is configured", async () => {
    const [local, none] = [sandbox(), sandbox()];
    local.key("local");
    const [localStub, noneStub] = await Promise.all([daemon(), daemon()]);

    const [refused, quiet] = await Promise.all([local.run(localStub, ["user", "setup", "--json"]), none.run(noneStub, ["user", "setup", "--json"])]);

    expect(refused.status, refused.stderr).toBe(0);
    expect(credentialPosts(localStub)).toHaveLength(0);
    expect(refused.stderr).toContain("Signing credential not registered");
    expect(refused.stderr).toContain("mandible user credential add operator-slug --from-git-signingkey");
    expect(quiet.status, quiet.stderr).toBe(0);
    expect(credentialPosts(noneStub)).toHaveLength(0);
    expect(quiet.stderr).not.toContain("Signing credential");
  });
});

describe("user credential add --from-git-signingkey", () => {
  it("registers the global key's public material and fingerprint", async () => {
    const box = sandbox();
    const { fingerprint, publicMaterial } = box.key("global");
    const stub = await daemon();

    const result = await box.run(stub, ["user", "credential", "add", "operator", "--from-git-signingkey", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(credentialPosts(stub).map((request) => request.body)).toEqual([{ type: "ssh_key", fingerprint, public_material: publicMaterial }]);
    expect(result.stderr).toContain("from global git config");
  });

  it("registers a repository-scoped key but names the scope, since the credential applies everywhere", async () => {
    const box = sandbox();
    const { fingerprint, publicMaterial } = box.key("local");
    const stub = await daemon();

    const result = await box.run(stub, ["user", "credential", "add", "operator", "--from-git-signingkey", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(credentialPosts(stub).map((request) => request.body)).toEqual([{ type: "ssh_key", fingerprint, public_material: publicMaterial }]);
    expect(result.stderr).toContain("from a non-global git config scope");
    expect(result.stderr).toContain("applies to this user everywhere");
  });
});
