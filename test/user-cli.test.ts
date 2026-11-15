// @vitest-environment node
/**
 * Operator signing trust comes from the approval key, never from git config:
 * setup registers no credential, and the git-config import is retired.
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

it("sets up the operator without reading or registering the git signing key", async () => {
  const box = sandbox();
  box.key("global");
  const stub = await daemon();

  const result = await box.run(stub, ["user", "setup", "--json"]);

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).user.slug).toBe("operator-slug");
  expect(credentialPosts(stub)).toHaveLength(0);
});

it("rejects retired project-grant and access arguments before contacting the daemon", async () => {
  const box = sandbox();
  const stub = await daemon();
  for (const args of [
    ['grant', 'add', '--subject-type', 'user', '--subject', 'agent', '--project', 'project', '--role', 'write'],
    ['grant', 'list', '--resource-type', 'global'],
    ['grant', 'list', '--resource-id', 'project'],
    ['access', 'agent', 'project'],
    ['credential', 'add', 'operator', '--from-git-signingkey'],
  ]) {
    const result = await box.run(stub, ['user', ...args]);
    expect(result.status, result.stdout).toBe(2);
  }
  expect(stub.requests).toEqual([]);
});
