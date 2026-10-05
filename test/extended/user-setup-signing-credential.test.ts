import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAIN_CLI_INSTANCE_RESPONSE } from "../helpers/cli-instance-response.js";

// Issue 2205073 — the protected-merge signing credential must not be a hidden
// manual step. Every operator otherwise lands in the signature_not_trusted
// trap on their second-ever queued approval, because `--from-git-signingkey`
// appears nowhere in onboarding. `mandible user setup` now registers it.
//
// Review F5 — but only from GLOBAL git config. An operator credential is
// global by construction, so setup run inside a repository carrying a per-repo
// or agent signing key must not silently promote that key into the operator's
// merge-attestation identity.

const CLI = path.join(process.cwd(), "bin", "mandible");

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let tempDir = "";
let homeDir = "";
let server: http.Server | null = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-user-setup-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-user-setup-home-"));
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
 * `scope` is the point of review F5: a key written to the sandbox's global
 * config is the operator's own protected-merge key, while a key written to the
 * repository is exactly the per-repo/agent key that must not be promoted.
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

async function startFakeDaemon(
  existingCredentials: Array<Record<string, unknown>>,
  recorded: Recorded[],
): Promise<number> {
  server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = req.url ?? "";
      recorded.push({
        method: req.method ?? "",
        url,
        body: raw ? JSON.parse(raw) : null,
      });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && url === "/api/instance") {
        json(200, MAIN_CLI_INSTANCE_RESPONSE);
        return;
      }
      if (req.method === "POST" && url === "/api/users/setup") {
        json(200, { user: { id: "user-1", slug: "operator-slug", display_name: "Op", email: null } });
        return;
      }
      if (req.method === "GET" && url.startsWith("/api/users/") && url.endsWith("/credentials")) {
        json(200, { credentials: existingCredentials });
        return;
      }
      if (req.method === "POST" && url.startsWith("/api/users/") && url.endsWith("/credentials")) {
        json(201, { credential: { id: "credential-1", type: "ssh_key", status: "active" } });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function runSetup(port: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    MANDIBLE_BASE: `http://127.0.0.1:${port}`,
    MANDIBLE_PORT: String(port),
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
    const child = spawn(CLI, ["user", "setup", "--json"], { cwd: tempDir, env });
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

describe("mandible user setup signing credential", () => {
  it("registers a globally configured git user.signingkey as an ssh_key credential", async () => {
    const { fingerprint, publicMaterial } = createSigningKey("global");
    const recorded: Recorded[] = [];
    const port = await startFakeDaemon([], recorded);

    const result = await runSetup(port);
    expect(result.status, result.stderr).toBe(0);

    const posts = recorded.filter(
      (entry) => entry.method === "POST" && entry.url.endsWith("/credentials"),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/users/operator-slug/credentials");
    expect(posts[0]!.body).toEqual({
      type: "ssh_key",
      fingerprint,
      public_material: publicMaterial,
      label: "git user.signingkey",
    });
    expect(result.stderr).toContain("Signing credential registered");
    // stdout stays machine-readable for --json consumers.
    expect(JSON.parse(result.stdout).user.slug).toBe("operator-slug");
  });

  it("is idempotent: an active credential with that fingerprint is not re-added", async () => {
    const { fingerprint, publicMaterial } = createSigningKey("global");
    const recorded: Recorded[] = [];
    const port = await startFakeDaemon(
      [{ id: "existing", type: "ssh_key", status: "active", fingerprint, public_material: publicMaterial }],
      recorded,
    );

    const result = await runSetup(port);
    expect(result.status, result.stderr).toBe(0);
    expect(
      recorded.filter((entry) => entry.method === "POST" && entry.url.endsWith("/credentials")),
    ).toHaveLength(0);
    expect(result.stderr).not.toContain("Signing credential registered");
  });

  it("re-registers when the only credential with that fingerprint was revoked", async () => {
    const { fingerprint } = createSigningKey("global");
    const recorded: Recorded[] = [];
    const port = await startFakeDaemon(
      [{ id: "old", type: "ssh_key", status: "revoked", fingerprint }],
      recorded,
    );

    const result = await runSetup(port);
    expect(result.status, result.stderr).toBe(0);
    expect(
      recorded.filter((entry) => entry.method === "POST" && entry.url.endsWith("/credentials")),
    ).toHaveLength(1);
  });

  it("skips silently when git user.signingkey is not configured", async () => {
    const recorded: Recorded[] = [];
    const port = await startFakeDaemon([], recorded);

    const result = await runSetup(port);
    expect(result.status, result.stderr).toBe(0);
    expect(recorded.some((entry) => entry.url.endsWith("/credentials"))).toBe(false);
    expect(result.stderr).not.toContain("Signing credential");
    expect(result.stderr).toContain("Operator ready.");
  });

  // Review F5 — the scenario: setup is run inside a repository configured with
  // a per-repo or agent key. That key must not become a globally active
  // credential for the operator's merge-attestation identity.
  it("never promotes a repository-local signing key into an operator credential", async () => {
    createSigningKey("local");
    const recorded: Recorded[] = [];
    const port = await startFakeDaemon([], recorded);

    const result = await runSetup(port);
    expect(result.status, result.stderr).toBe(0);
    expect(recorded.some((entry) => entry.url.endsWith("/credentials"))).toBe(false);
    expect(result.stderr).toContain("Signing credential not registered");
    expect(result.stderr).toContain("outside global config");
    // The refusal hands over the explicit, scoped command instead of acting.
    expect(result.stderr).toContain(
      "mandible user credential add operator-slug --from-git-signingkey",
    );
  });

  it("registers the global key even when the repository overrides user.signingkey", async () => {
    const globalKey = createSigningKey("global", "operator-signing");
    const repoKey = createSigningKey("local", "repo-agent-signing");
    expect(repoKey.fingerprint).not.toBe(globalKey.fingerprint);
    const recorded: Recorded[] = [];
    const port = await startFakeDaemon([], recorded);

    const result = await runSetup(port);
    expect(result.status, result.stderr).toBe(0);

    const posts = recorded.filter(
      (entry) => entry.method === "POST" && entry.url.endsWith("/credentials"),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      type: "ssh_key",
      fingerprint: globalKey.fingerprint,
      public_material: globalKey.publicMaterial,
      label: "git user.signingkey",
    });
    expect(result.stderr).toContain("registered from global git config");
  });
});
