import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue 2205073 — the protected-merge signing credential must not be a hidden
// manual step. Every operator otherwise lands in the signature_not_trusted
// trap on their second-ever queued approval, because `--from-git-signingkey`
// appears nowhere in onboarding. `mandible user setup` now registers it.

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

function createSigningKey(): { fingerprint: string; publicMaterial: string } {
  const sshDir = path.join(homeDir, ".ssh");
  const keyPath = path.join(sshDir, "operator-signing");
  fs.mkdirSync(sshDir, { recursive: true });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  execFileSync("git", ["config", "user.signingkey", "~/.ssh/operator-signing.pub"], {
    cwd: tempDir,
  });
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
    MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
    GIT_OPTIONAL_LOCKS: "0",
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
  it("registers git user.signingkey as an ssh_key credential on the operator", async () => {
    const { fingerprint, publicMaterial } = createSigningKey();
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
    const { fingerprint, publicMaterial } = createSigningKey();
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
    const { fingerprint } = createSigningKey();
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
});
