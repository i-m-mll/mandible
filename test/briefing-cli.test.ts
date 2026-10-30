// @vitest-environment node
/**
 * What `mandible briefing` decides before transport: a Briefing binds one exact
 * artifact version, and a destination-route manifest travels as the file's own
 * JSON. Every other subcommand is a grammar entry plus a covered route.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fileRpc, runCli, scratchDir } from "./helpers/cli-process.js";
import type { FileRpcHandler } from "./helpers/file-rpc-responder.js";

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function spool(handler: FileRpcHandler) {
  const stub = fileRpc(handler);
  cleanups.push(() => stub.responder.stop());
  return { ...stub, env: { ...stub.env, MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" } };
}

describe("briefing CLI", () => {
  it("refuses a logical version, a logical comparison base, or a blank distinct reason before transport", async () => {
    const { env, responder } = spool(() => ({ status: 500, body: { error: "unexpected request" } }));
    const create = (...args: string[]) => runCli(["briefing", "create", ...args], { env });

    const [logical, logicalBase, blankReason] = await Promise.all([
      create("artifact:logical", "--title", "Review"),
      create("artifact-version:exact", "--title", "Review", "--comparison-base", "artifact:logical"),
      create("artifact-version:exact", "--title", "Review", "--reason", "  "),
    ]);

    expect(logical.status).toBe(2);
    expect(logicalBase.status).toBe(2);
    expect(blankReason.status).toBe(2);
    expect(responder.requests).toEqual([]);
  });

  it("plans and applies a destination-route manifest as the file's own JSON", async () => {
    const manifest = {
      schema: "mandible-briefing-destination-routes@3",
      routes: [{
        route_key: "digest.since-last-review", logical_artifact_ref: "artifact:artifact-12345678", publication_mode: "reviewed-document",
        heading: "Since last review", composer_kind: "agentic", template: { version: 1, contribution_template: "", slots: {} },
        limits: { max_contributions: 10, max_document_bytes: 100_000, max_directives: 0 },
      }],
    };
    const manifestPath = path.join(scratchDir("routes"), "routes.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const { env, responder } = spool(() => ({ status: 200, body: { schema: manifest.schema, changed: true, routes: [{ route_key: "digest.since-last-review", action: "create" }] } }));

    const results = await Promise.all(["plan", "apply"].map((action) => runCli(["briefing", "route", action, manifestPath, "--json"], { env })));

    for (const result of results) expect(result.status, result.stderr).toBe(0);
    expect(responder.requests.map(({ method, path: requestPath, body }) => ({ method, path: requestPath, body }))).toEqual(expect.arrayContaining([
      { method: "POST", path: "/api/briefing-destination-routes/plan", body: manifest },
      { method: "POST", path: "/api/briefing-destination-routes", body: manifest },
    ]));
  });
});
