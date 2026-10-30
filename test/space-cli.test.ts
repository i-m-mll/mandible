// @vitest-environment node
/**
 * The `mandible space` validation the CLI does before transport: malformed
 * input never reaches the daemon, item refs map by scheme, and edges whose
 * endpoints cannot become ledger relationships are reported, not sent.
 */
import { afterEach, describe, expect, it } from "vitest";

import { fileRpc, runCli } from "./helpers/cli-process.js";
import type { FileRpcHandler } from "./helpers/file-rpc-responder.js";

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function spool(handler: FileRpcHandler = () => ({ status: 500, body: { error: "unexpected request" } })) {
  const stub = fileRpc(handler);
  cleanups.push(() => stub.responder.stop());
  return stub;
}

describe("space CLI", () => {
  it("refuses malformed input with exit 2 before contacting the daemon", async () => {
    const { env, responder } = spool();
    const cases: Array<[string[], string]> = [
      [["seed-from-filter", "space-1", "--predicate", "not-json"], "--predicate must be valid JSON"],
      [["add-item", "space-1", "bogus-ref"], "Unrecognized ref"],
      [["add-item", "space-1", "artifact:sha256:deadbeef"], "Unsupported artifact ref"],
      [["promote-edge", "--source", "issue:a", "--target", "issue:b", "--link-type", "bogus"], "Invalid --link-type"],
      [["block", "add", "space-1", "--type", "bogus"], "Invalid --type"],
      [["block", "edit", "space-1", "blk-1", "--type", "bogus"], "Invalid --type"],
      [["block", "add", "space-1", "--type", "reference", "--item", "i1", "--snapshot", "[1,2]"], "--snapshot must be a JSON object"],
      [["block", "add", "space-1", "--type", "paragraph", "--metadata", "not-json"], "--metadata must be a JSON object"],
    ];

    const results = await Promise.all(cases.map(([args]) => runCli(["space", ...args], { env })));

    for (const [index, [args, message]] of cases.entries()) {
      expect(results[index].status, args.join(" ")).toBe(2);
      expect(results[index].stderr, args.join(" ")).toContain(message);
    }
    expect(responder.requests).toEqual([]);
  });

  it("reports an edge with a non-ledger endpoint as not promotable, exit 3, without calling the route", async () => {
    const { env, responder } = spool();

    const [artifact, uri] = await Promise.all([
      runCli(["space", "promote-edge", "--source", "issue:abc", "--target", "artifact-blob:deadbeef", "--json"], { env }),
      runCli(["space", "promote-edge", "--source", "uri:https://x", "--target", "issue:abc", "--json"], { env }),
    ]);

    expect(artifact.status).toBe(3);
    expect(JSON.parse(artifact.stdout)).toMatchObject({ promotable: false, status: "not_promotable", blockers: [{ side: "target", kind: "artifact" }] });
    expect(uri.status).toBe(3);
    expect(JSON.parse(uri.stdout)).toMatchObject({ promotable: false, blockers: [{ side: "source", kind: "external_ref" }] });
    expect(responder.requests).toEqual([]);
  });
});
