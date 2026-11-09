import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerDesktopHandoffRoute } from "../src/routes/desktop-handoff.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import type { Db } from "../src/db.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

type AssetManifest = {
  version: number;
  entry: string;
  entryPreloads: string[];
  routes: Record<string, string>;
};

const uiDistDir = path.join(testRuntimeRoot, "ui-static-assets", "dist");
let manifest: AssetManifest;

beforeAll(() => {
  execFileSync(process.execPath, ["ui/esbuild.config.js", "--outdir", uiDistDir], { cwd: process.cwd() });
  manifest = JSON.parse(fs.readFileSync(path.join(uiDistDir, "asset-manifest.json"), "utf8")) as AssetManifest;
});

describe("UI static asset delivery", () => {

  it("injects current build preloads while keeping the HTML revalidatable", async () => {
    const { server, origin } = await startServer();
    try {
      const response = await fetch(`${origin}/`);
      const html = await response.text();
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(html).toContain(`<link rel="modulepreload" href="${manifest.entryPreloads[0]}" />`);
      expect(html).toContain(JSON.stringify(manifest.routes.spaces));
      expect(html.indexOf("modulepreload")).toBeLessThan(html.indexOf('src="/dist/app.js"'));
    } finally {
      await closeServer(server);
    }
  });

  it("serves the app shell at every page path, with 404 outside the route table", async () => {
    const { server, origin } = await startServer();
    try {
      for (const [pathAndQuery, status] of [
        ["/issue/x", 200],
        ["/issue/mandible/abc1234?comment=2", 200],
        ["/artifact/artifact-series:abcdef1@3?sidebar=hidden&agent_session=s", 200],
        ["/briefing?group=policy", 200],
        ["/spaces", 200],
        ["/nonsense", 404],
        ["/issues/x", 404],
      ] as const) {
        const response = await fetch(`${origin}${pathAndQuery}`);
        expect(response.status, pathAndQuery).toBe(status);
        expect(await response.text(), pathAndQuery).toMatch(/<script id="mandible-bootstrap" type="application\/json">\{/);
      }
      const api = await fetch(`${origin}/api/nonsense`);
      expect(api.status).toBe(404);
      expect(await api.json()).toEqual({ error: "not_found" });
      expect((await fetch(`${origin}/dist/missing.js`)).status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("preloads the route chunk of the tab the document path opens", async () => {
    const { server, origin } = await startServer();
    try {
      const html = await (await fetch(`${origin}/`)).text();
      const script = [...html.matchAll(/<script>(\(function\(\)\{var r=[\s\S]*?)<\/script>/g)][0]?.[1];
      expect(script).toBeTruthy();
      const preloadFor = (pathname: string) => {
        const appended: Array<{ href?: string }> = [];
        const document = { createElement: () => ({}), head: { appendChild: (link: { href?: string }) => appended.push(link) } };
        new Function("location", "document", script!)({ pathname }, document);
        return appended[0]?.href;
      };
      expect(preloadFor("/issue/abc1234")).toBe(manifest.routes.issues);
      expect(preloadFor("/artifact/artifact-version:abc")).toBe(manifest.routes.artifacts);
      expect(preloadFor("/timeline")).toBe(manifest.routes.timeline);
      expect(preloadFor("/")).toBe(manifest.routes.spaces);
    } finally {
      await closeServer(server);
    }
  });

  it("hands an /r path and its query to the desktop app unchanged", async () => {
    const { server, origin } = await startServer();
    try {
      const target = async (pathAndQuery: string) => {
        const html = await (await fetch(`${origin}${pathAndQuery}`)).text();
        return JSON.parse(/window\.location\.replace\((".*")\)/.exec(html)![1]) as string;
      };
      expect(await target("/r/issue/x?agent_session=s")).toBe("mandible:///issue/x?agent_session=s");
      expect(await target("/r/artifact/artifact-series:abc@2?sidebar=hidden")).toBe("mandible:///artifact/artifact-series:abc@2?sidebar=hidden");
      expect(await target("/r/nonsense/path")).toBe("mandible:///nonsense/path");
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

      const appPath = path.join(uiDistDir, "app.js");
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
  registerDesktopHandoffRoute(router);
  const server = createServer({
    db: {} as Db,
    sse: new SseManager(),
    logger: () => undefined,
    version: "test",
    router,
    getStartupInfo: () => null,
    instance,
    uiDistDir,
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
