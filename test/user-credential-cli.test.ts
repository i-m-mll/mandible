import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let homeDir = "";
let server: http.Server | null = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-user-credential-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-user-credential-home-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: tempDir });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function globalConfigPath(): string {
  return path.join(homeDir, ".gitconfig");
}

/**
 * Issue 2205073 (review F5) — `--from-git-signingkey` is the explicit command,
 * so it still reads effective configuration; `scope` decides whether the key it
 * finds is the operator's global key or one the repository set.
 */
function createSigningKey(
  scope: "global" | "local",
  keyName = "operator-signing",
): { fingerprint: string; publicMaterial: string } {
  const sshDir = path.join(homeDir, ".ssh");
  const keyPath = path.join(sshDir, keyName);
  fs.mkdirSync(sshDir, { recursive: true });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const value = `~/.ssh/${keyName}.pub`;
  if (scope === "global") {
    execFileSync("git", ["config", "--file", globalConfigPath(), "user.signingkey", value]);
  } else {
    execFileSync("git", ["config", "user.signingkey", value], { cwd: tempDir });
  }
  const publicMaterial = fs
    .readFileSync(`${keyPath}.pub`, "utf8")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)[1]!;
  return { fingerprint, publicMaterial };
}

async function startFakeDaemon(bodies: Record<string, unknown>[]): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/instance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/users/operator/credentials") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          credential: { id: "credential-1", type: "ssh_key", status: "active" },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function runCredentialAdd(
  port: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    MANDIBLE_BASE: `http://127.0.0.1:${port}`,
    MANDIBLE_PORT: String(port),
    MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    // Pin both non-repository config scopes into the sandbox so "global" means
    // this test's file and never the developer machine's real signing key.
    GIT_CONFIG_GLOBAL: globalConfigPath(),
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return new Promise((resolve) => {
    const child = spawn(
      CLI,
      ["user", "credential", "add", "operator", "--from-git-signingkey", "--json"],
      { cwd: tempDir, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("user credential CLI", () => {
  it("registers the public material and fingerprint from git user.signingkey", async () => {
    const { fingerprint, publicMaterial } = createSigningKey("global");
    const bodies: Record<string, unknown>[] = [];
    const port = await startFakeDaemon(bodies);

    const result = await runCredentialAdd(port);

    expect(result.status, result.stderr).toBe(0);
    expect(bodies).toEqual([{ type: "ssh_key", fingerprint, public_material: publicMaterial }]);
    expect(result.stderr).toContain("from global git config");
  });

  // Review F5 — the explicit command may still register a repository-scoped
  // key, but the credential it creates is global, so it must say so rather
  // than letting the operator assume the scope carried over.
  it("names the config scope when the key comes from outside global config", async () => {
    const { fingerprint, publicMaterial } = createSigningKey("local");
    const bodies: Record<string, unknown>[] = [];
    const port = await startFakeDaemon(bodies);

    const result = await runCredentialAdd(port);

    expect(result.status, result.stderr).toBe(0);
    expect(bodies).toEqual([{ type: "ssh_key", fingerprint, public_material: publicMaterial }]);
    expect(result.stderr).toContain("from a non-global git config scope");
    expect(result.stderr).toContain("applies to this user everywhere");
  });
});
