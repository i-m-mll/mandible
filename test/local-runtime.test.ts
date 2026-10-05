// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyRuntimeStatus, loadedServiceMatches, parseLoadedService, healthDocumentError, healthEndpointUrl, launchModeFromAgent, probeJson, reconcileMainRegistration, renderLaunchAgent } from "../scripts/local-runtime.mjs";
import { resolveInstanceInfo } from "../src/instance-policy";

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

function productionInstance() {
  return resolveInstanceInfo({
    env: {
      MANDIBLE_INSTANCE_ROLE: "main",
      MANDIBLE_INSTANCE_ID: "production",
      MANDIBLE_INSTALLATION_ID: expected.installationId,
      MANDIBLE_PUBLIC_ORIGIN: expected.publicOrigin,
      MANDIBLE_BACKEND_GENERATION: expected.generation,
    },
  });
}

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
  it("preserves the installed login mode and treats legacy agents as on-demand", () => {
    expect(launchModeFromAgent({ EnvironmentVariables: { MANDIBLE_LAUNCH_MODE: "manual" }, RunAtLoad: true })).toBe("manual");
    expect(launchModeFromAgent({ EnvironmentVariables: { MANDIBLE_LAUNCH_MODE: "on_demand" }, RunAtLoad: false })).toBe("on_demand");
    expect(launchModeFromAgent({ EnvironmentVariables: {}, RunAtLoad: false, KeepAlive: true })).toBe("on_demand");
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
      expect(plist).not.toContain("<key>RunAtLoad</key>");
      expect(plist).toContain("<key>KeepAlive</key><true/>");
    }
    expect(backend).toContain("/path/with &amp; spaces/production-runner.mjs");
    expect(backend).toContain("<string>run</string>");
    expect(gateway).toContain("<string>run</string>");
  });
});

describe("production registration reconciliation", () => {
  it("adds the new effect to an exact prior production default while preserving registration fields", () => {
    const instance = productionInstance();
    const previousDefault = instance.allowed_effects.filter((effect) => effect !== "preferences:instance");
    const existing = {
      instance_id: "production",
      installation_id: instance.installation_id,
      role: "main",
      public_origin: instance.public_origin,
      backend_origin: "http://127.0.0.1:29420",
      backend_generation: "b".repeat(40),
      effect_ceiling: previousDefault,
      writable_roots: ["/preserved/root"],
    };
    const registrations: unknown[] = [];
    const authority = {
      instance: () => existing,
      registerInstance: (registration: unknown) => registrations.push(registration),
    };

    expect(reconcileMainRegistration(authority, instance, "http://127.0.0.1:29420")).toBe(true);

    expect(registrations).toEqual([{ ...existing, effect_ceiling: instance.allowed_effects }]);
  });

  it("keeps a deliberately narrowed production ceiling unchanged", () => {
    const instance = productionInstance();
    const previousDefault = instance.allowed_effects.filter((effect) => effect !== "preferences:instance");
    const narrowed = previousDefault.filter((effect) => effect !== "maintenance:shared");
    const existing = {
      instance_id: "production",
      installation_id: instance.installation_id,
      role: "main",
      public_origin: instance.public_origin,
      backend_origin: "http://127.0.0.1:29420",
      backend_generation: "b".repeat(40),
      effect_ceiling: narrowed,
      writable_roots: ["/preserved/root"],
    };
    const registrations: unknown[] = [];
    const authority = {
      instance: () => existing,
      registerInstance: (registration: unknown) => registrations.push(registration),
    };

    expect(reconcileMainRegistration(authority, instance, "http://127.0.0.1:29420")).toBe(false);

    expect(registrations).toEqual([]);
  });
});

it('refuses stale loaded environment, working directory and log paths even when service arguments match', () => {
  const record = { ProgramArguments: ['/runtime/bun', '/owned/runner.mjs', 'run'],
    EnvironmentVariables: { HOME: '/operator home', PATH: '/owned/bin:/usr/bin' },
    WorkingDirectory: '/owned/run', StandardOutPath: '/owned/out.log', StandardErrorPath: '/owned/error.log' };
  const loaded = parseLoadedService(`job = {
    arguments = {
      /runtime/bun
      /owned/runner.mjs
      run
    }
    working directory = /owned/run
    stdout path = /owned/out.log
    stderr path = /owned/error.log
    inherited environment = {
      PATH => /inherited/path
    }
    default environment = {
      PATH => /default/path
    }
    environment = {
      PATH => /owned/bin:/usr/bin
      HOME => /operator home
      XPC_SERVICE_NAME => owned-label
      OSLogRateLimit => 64
    }
  }`);
  expect(loadedServiceMatches(record, loaded)).toBe(true);
  for (const drift of [{ environment: { ...loaded.environment, PATH: '/old/path' } },
    { workingDirectory: '/other/run' }, { stderrPath: '/other/error.log' }, { stdoutPath: '/other/out.log' },
    { argv: ['/other/runtime', '/owned/runner.mjs', 'run'] }]) {
    expect(loadedServiceMatches(record, { ...loaded, ...drift })).toBe(false);
  }
});
