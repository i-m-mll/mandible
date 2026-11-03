// @vitest-environment node
/**
 * What `mandible briefing` decides before transport: a Briefing binds one exact
 * artifact version, and a destination-route manifest travels as the file's own
 * JSON. Group show and review render their human form, whose jq programs
 * compile only at run time. Every other subcommand is a grammar entry plus a
 * covered route.
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

  it("renders group show and review in human form", async () => {
    const group = {
      id: "bgrp_01KY5J56GRTEYKPQQ8M05FV7N3", key: "agent-policy", name: "Agent policy",
      current: { id: "bbnd_01KY5J56GRTEYKPQQ8M05FV7N4", name: "Original" },
      updates: [{ id: "bbnd_01KY5J56GRTEYKPQQ8M05FV7N5", name: "Rewrite" }], history: [],
    };
    const candidate = { ready: false, binding_digest: null, layout_changed: true, destination_changes: [] };
    const { env } = spool((request) => ({ status: 200, body: request.method === "GET" ? { group } : { candidate } }));

    const [show, review] = await Promise.all([
      runCli(["briefing", "group", "show", "agent-policy"], { env }),
      runCli(["briefing", "group", "review", "agent-policy", "--expected-base", "bbnd_base", "--proposal", "bbnd_proposal"], { env }),
    ]);

    expect(show.status, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/Base: \S+ {2}Base\n {2}proposal: \S+ {2}Rewrite\n/);
    expect(review.status, review.stderr).toBe(0);
    expect(review.stdout).toContain("binding=none");
  });
});
