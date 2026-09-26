// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRuntimeStatus, healthDocumentError, healthEndpointUrl, launchModeFromAgent, probeJson, renderLaunchAgent } from "../scripts/local-runtime.mjs";

const servers: Array<http.Server | https.Server> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function listen(server: http.Server | https.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("test server did not bind a TCP port"));
      else resolve(address.port);
    });
  });
}

const expected = {
  installationId: "installation-test",
  publicOrigin: "https://app.mandible.localhost:19420",
  generation: "a".repeat(40),
};

function health(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    ready: true,
    warm: true,
    instance: {
      role: "main",
      instance_id: "production",
      installation_id: expected.installationId,
      public_origin: expected.publicOrigin,
      backend_generation: expected.generation,
    },
    ...overrides,
  };
}

describe("supervised runtime readiness", () => {
  it("preserves the installed login mode and reads legacy RunAtLoad settings", () => {
    expect(launchModeFromAgent({ EnvironmentVariables: { MANDIBLE_LAUNCH_MODE: "manual" }, RunAtLoad: true })).toBe("manual");
    expect(launchModeFromAgent({ EnvironmentVariables: { MANDIBLE_LAUNCH_MODE: "on_demand" }, RunAtLoad: false })).toBe("on_demand");
    expect(launchModeFromAgent({ EnvironmentVariables: {}, RunAtLoad: false })).toBe("manual");
    expect(launchModeFromAgent({ EnvironmentVariables: {}, RunAtLoad: true })).toBe("on_demand");
  });

  it("probes Mandible's health endpoint at both production origins", () => {
    expect(healthEndpointUrl("http://127.0.0.1:29420/old-path?stale=1#fragment").href)
      .toBe("http://127.0.0.1:29420/api/health");
    expect(healthEndpointUrl(expected.publicOrigin).href)
      .toBe("https://app.mandible.localhost:19420/api/health");
  });

  it("accepts only a ready health document for the exact installed backend", () => {
    expect(healthDocumentError(health(), expected)).toBeNull();
    expect(healthDocumentError(null, expected)).toContain("malformed");
    expect(healthDocumentError(health({ ready: false }), expected)).toContain("not ready");
    expect(healthDocumentError(health({ instance: { ...health().instance, installation_id: "other" } }), expected)).toContain("different");
    expect(healthDocumentError(health({ instance: { ...health().instance, backend_generation: "b".repeat(40) } }), expected)).toContain("different");
  });

  it("reports a healthy backend separately when the trusted dashboard is unavailable", () => {
    const status = classifyRuntimeStatus({
      backend: { ok: true, document: health() },
      gateway: { ok: false, error: "The service is not accepting connections." },
      backendPortOpen: true,
      gatewayPortOpen: false,
      backendJob: { loaded: true, pid: 101 },
      gatewayJob: { loaded: true, pid: 101 },
    });
    expect(status.state).toBe("gateway_unavailable");
    expect(status.healthy).toBe(true);
    expect(status.dashboard_ready).toBe(false);
    expect(status.gateway_state).toBe("starting");
  });

  it("reports the shared gateway listener independently from its stopped backend", () => {
    const status = classifyRuntimeStatus({
      backend: { ok: false, error: "The service is not accepting connections." },
      gateway: { ok: false, error: "The service is not accepting connections." },
      backendPortOpen: false,
      gatewayPortOpen: true,
      backendJob: { loaded: false, pid: null },
      gatewayJob: { loaded: true, pid: 202 },
    });
    expect(status.healthy).toBe(false);
    expect(status.dashboard_ready).toBe(false);
    expect(status.gateway_state).toBe("running");
  });

  it("reports an occupied unowned dashboard port as a conflict while preserving a healthy backend", () => {
    const status = classifyRuntimeStatus({
      backend: { ok: true, document: health() },
      gateway: { ok: false, error: "The HTTPS certificate failed verification." },
      backendPortOpen: true,
      gatewayPortOpen: true,
      backendJob: { loaded: true, pid: 101 },
      gatewayJob: { loaded: false, pid: null },
    });
    expect(status.state).toBe("port_conflict");
    expect(status.healthy).toBe(true);
    expect(status.dashboard_ready).toBe(false);
  });

  it("rejects a foreign HTTPS certificate instead of accepting an HTTP 200", async () => {
    const fixture = (name: string) => fs.readFileSync(path.resolve("test/fixtures", name));
    const server = https.createServer({ cert: fixture("runtime-test-cert.pem"), key: fixture("runtime-test-key.pem") }, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(health()));
    });
    const port = await listen(server);
    const result = await probeJson(`https://127.0.0.1:${port}/api/health`, {
      ca: fixture("runtime-wrong-ca.pem"),
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("certificate failed verification");
  });

  it("bounds a health endpoint that accepts connections but never responds", async () => {
    const server = http.createServer(() => undefined);
    const port = await listen(server);
    const began = Date.now();
    const result = await probeJson(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 120 });
    expect(Date.now() - began).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("120 ms deadline");
  });

  it("renders launchd-owned services with preserved login and recovery behavior", () => {
    const backend = renderLaunchAgent({
      label: "bio.mll.mandible.local-session-production",
      programArguments: ["/opt/node", "/path/with & spaces/production-runner.mjs", "run"],
      workingDirectory: "/path/with spaces",
      environment: { HOME: "/operator home", MANDIBLE_HOME: "/operator home/.mandible" },
      stdoutPath: "/logs/backend.log",
      stderrPath: "/logs/backend-error.log",
    });
    const manualBackend = renderLaunchAgent({
      label: "bio.mll.mandible.local-session-production",
      programArguments: ["/opt/node", "/path/with & spaces/production-runner.mjs", "run"],
      workingDirectory: "/path/with spaces",
      environment: { HOME: "/operator home", MANDIBLE_HOME: "/operator home/.mandible" },
      stdoutPath: "/logs/backend.log",
      stderrPath: "/logs/backend-error.log",
      runAtLoad: false,
    });
    const gateway = renderLaunchAgent({
      label: "bio.mll.mandible.local-front-door",
      programArguments: ["/operator home/.mandible/runtime/caddy", "run", "--config", "/operator home/.mandible/config/local-sessions/Caddyfile"],
      workingDirectory: "/operator home/.mandible/config/local-sessions",
      environment: { HOME: "/operator home", MANDIBLE_HOME: "/operator home/.mandible" },
      stdoutPath: "/logs/gateway.log",
      stderrPath: "/logs/gateway-error.log",
    });
    for (const plist of [backend, gateway]) {
      expect(plist.match(/<plist version=/g)).toHaveLength(1);
      expect(plist).toContain("<key>RunAtLoad</key><true/>");
      expect(plist).toContain("<key>KeepAlive</key><true/>");
    }
    expect(manualBackend).toContain("<key>RunAtLoad</key><false/>");
    expect(manualBackend).toContain("<key>KeepAlive</key><true/>");
    expect(backend).toContain("/path/with &amp; spaces/production-runner.mjs");
    expect(backend).toContain("<string>run</string>");
    expect(gateway).toContain("<string>run</string>");
  });
});
