import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { resolveInstanceInfo } from "../../src/instance-policy.js";
import { createServer, Router } from "../../src/server.js";
import { SseManager } from "../../src/sse.js";
import type { Db } from "../../src/db.js";

type AssetManifest = {
  version: number;
  entry: string;
  entryPreloads: string[];
  routes: Record<string, string>;
};

let manifest: AssetManifest;

beforeAll(() => {
  execFileSync(process.execPath, ["ui/esbuild.config.js"], { cwd: process.cwd() });
  manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "ui", "dist", "asset-manifest.json"), "utf8"),
  ) as AssetManifest;
});

describe("UI static asset delivery", () => {
  it("emits entry dependency and route chunk metadata from the current build", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.entry).toBe("/dist/app.js");
    expect(manifest.entryPreloads.length).toBeGreaterThan(0);
    expect(manifest.entryPreloads).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/dist\/chunks\/.+-[A-Z0-9]{8}\.js$/)]),
    );
    expect(manifest.routes).toMatchObject({
      spaces: expect.stringMatching(/^\/dist\/chunks\/SpacesTab-[A-Z0-9]{8}\.js$/),
      issues: expect.stringMatching(/^\/dist\/chunks\/issues-[A-Z0-9]{8}\.js$/),
      console: expect.stringMatching(/^\/dist\/chunks\/conversations-[A-Z0-9]{8}\.js$/),
    });
  });

  it("injects current build preloads while keeping the HTML revalidatable", async () => {
    const { server, origin } = await startServer();
    try {
      const response = await fetch(`${origin}/`);
      const html = await response.text();
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(html).toContain(`<link rel="modulepreload" href="${manifest.entryPreloads[0]}" />`);
      expect(html).toContain(JSON.stringify(manifest.routes.spaces));
      expect(html.indexOf("modulepreload")).toBeLessThan(html.indexOf('src="./dist/app.js"'));
    } finally {
      await closeServer(server);
    }
  });

  it("serves hashed chunks as immutable and leaves entry assets revalidatable", async () => {
    const { server, origin } = await startServer();
    try {
      const chunkUrl = Object.values(manifest.routes)[0];
      const immutable = await fetch(`${origin}${chunkUrl}`, {
        headers: { "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString() },
      });
      expect(immutable.status).toBe(200);
      expect(immutable.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const appPath = path.join(process.cwd(), "ui", "dist", "app.js");
      const appStat = fs.statSync(appPath);
      const revalidated = await fetch(`${origin}/dist/app.js`, {
        headers: { "If-Modified-Since": appStat.mtime.toUTCString() },
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("cache-control")).toBe("no-cache");
    } finally {
      await closeServer(server);
    }
  });
});

async function startServer(): Promise<{ server: http.Server; origin: string }> {
  const instance = resolveInstanceInfo({ env: {}, dbPath: "/tmp/mandible-static-assets.db" });
  const router = new Router({ instance });
  const server = createServer({
    db: {} as Db,
    sse: new SseManager(),
    logger: () => undefined,
    version: "test",
    router,
    getStartupInfo: () => null,
    instance,
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("server did not listen on an ephemeral TCP port"));
    });
  });
  return { server, origin: `http://127.0.0.1:${port}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
