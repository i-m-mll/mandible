import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startFileRpcResponder,
  type FileRpcHandler,
  type FileRpcRequest,
} from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let spoolDir = "";

interface RpcResult {
  status: number | null;
  stdout: string;
  stderr: string;
  seen: FileRpcRequest[];
}

/**
 * Run the CLI against an in-process file-RPC responder. `handler` receives each
 * request and returns the `{status, body}` the daemon would. The CLI never
 * touches a live daemon — `MANDIBLE_BASE=file://<spool>` routes through the
 * file-RPC transport in cli/api.sh.
 */
function runWithResponder(
  args: string[],
  handler: FileRpcHandler,
): Promise<RpcResult> {
  const responder = startFileRpcResponder(spoolDir, handler);
  const seen = responder.requests;

  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      env: {
        ...process.env,
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      },
    });
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
    child.on("close", (status) => {
      responder.stop();
      resolve({ status, stdout, stderr, seen });
    });
  });
}

function runOffline(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    encoding: "utf8",
    env: { ...process.env, MANDIBLE_PORT: "9" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-space-cli-"));
});

afterEach(() => {
  fs.rmSync(spoolDir, { recursive: true, force: true });
});

describe("space CLI surface", () => {
  it("documents the command surface including block subcommands", () => {
    const result = runOffline(["space", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mandible space create");
    expect(result.stdout).toContain("mandible space promote-edge");
    expect(result.stdout).toContain("mandible space seed-from-filter");
    expect(result.stdout).toContain("mandible space block add");
    expect(result.stdout).toContain("mandible space block edit");
    expect(result.stdout).toContain("mandible space block rm");
  });

  it("rejects an unknown block subcommand", () => {
    const result = runOffline(["space", "block", "bogus-sub"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown block subcommand");
  });

  it("requires a block subcommand", () => {
    const result = runOffline(["space", "block"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("mandible space block <add|edit|rm>");
  });

  it("is wired into the top-level mandible dispatch + help", () => {
    const help = runOffline(["help"]);
    expect(help.stdout).toContain("mandible space create");
    const unknown = runOffline(["space", "bogus-sub"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("Unknown space subcommand");
  });
});

describe("space CLI write round-trips", () => {
  it("creates a space via POST /api/spaces", async () => {
    const result = await runWithResponder(
      ["space", "create", "--project", "prj-1", "--title", "Roadmap", "--renderer", "canvas", "--json"],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/spaces");
        expect(req.body).toMatchObject({ project_id: "prj-1", title: "Roadmap", default_renderer: "canvas" });
        return { status: 201, body: { space: { id: "space-1", title: "Roadmap", default_renderer: "canvas", project_id: "prj-1" } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).space).toMatchObject({ id: "space-1", title: "Roadmap" });
  });

  it("lists spaces via GET /api/spaces?project_id", async () => {
    const result = await runWithResponder(
      ["space", "list", "--project", "prj-1"],
      (req) => {
        expect(req.method).toBe("GET");
        expect(req.path).toBe("/api/spaces?project_id=prj-1");
        return { status: 200, body: { spaces: [{ id: "space-1", title: "Roadmap", default_renderer: "canvas" }] } };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("space-1 Roadmap renderer:canvas");
  });

  it("shows a space via GET /api/spaces/:id", async () => {
    const result = await runWithResponder(
      ["space", "show", "space-1", "--json"],
      (req) => {
        expect(req.method).toBe("GET");
        expect(req.path).toBe("/api/spaces/space-1");
        return { status: 200, body: { space: { id: "space-1", title: "Roadmap", default_renderer: "canvas", project_id: "prj-1", description: null } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).space.id).toBe("space-1");
  });

  it("places an occurrence via POST /api/spaces/:id/occurrences with numeric geometry", async () => {
    const result = await runWithResponder(
      ["space", "place", "space-1", "--item", "item-1", "--renderer", "card", "--x", "10", "--y", "20", "--width", "100", "--json"],
      (req) => {
        expect(req.path).toBe("/api/spaces/space-1/occurrences");
        expect(req.body).toMatchObject({ item_id: "item-1", renderer: "card", x: 10, y: 20, width: 100 });
        return { status: 201, body: { occurrence: { id: "occ-1", renderer: "card", item_id: "item-1" } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).occurrence.id).toBe("occ-1");
  });

  it("links occurrences via POST /api/spaces/:id/edges", async () => {
    const result = await runWithResponder(
      ["space", "link", "space-1", "--source", "occ-1", "--target", "occ-2", "--label", "depends", "--json"],
      (req) => {
        expect(req.path).toBe("/api/spaces/space-1/edges");
        expect(req.body).toMatchObject({ source: "occ-1", target: "occ-2", label: "depends" });
        return { status: 201, body: { edge: { id: "edge-1", source: "occ-1", target: "occ-2" } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).edge.id).toBe("edge-1");
  });

  it("removes an item via DELETE /api/spaces/:id/items/:item_id", async () => {
    const result = await runWithResponder(
      ["space", "rm-item", "space-1", "item-1", "--json"],
      (req) => {
        expect(req.method).toBe("DELETE");
        expect(req.path).toBe("/api/spaces/space-1/items/item-1");
        return { status: 200, body: { ok: true, id: "item-1" } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, id: "item-1" });
  });

  it("unlinks an edge via DELETE /api/spaces/:id/edges/:edge_id", async () => {
    const result = await runWithResponder(
      ["space", "unlink", "space-1", "edge-1", "--json"],
      (req) => {
        expect(req.method).toBe("DELETE");
        expect(req.path).toBe("/api/spaces/space-1/edges/edge-1");
        return { status: 200, body: { ok: true, id: "edge-1" } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, id: "edge-1" });
  });

  it("seeds from a predicate via POST /api/spaces/:id/seed", async () => {
    const result = await runWithResponder(
      ["space", "seed-from-filter", "space-1", "--predicate", '{"kind":"label","label":"feature"}', "--with-shelf", "--json"],
      (req) => {
        expect(req.path).toBe("/api/spaces/space-1/seed");
        expect(req.body).toMatchObject({
          predicate: { kind: "label", label: "feature" },
          with_shelf_occurrences: true,
          include_artifacts: true,
        });
        return { status: 200, body: { matched_issue_ids: ["i1", "i2"], items_created: 2, items_existing: 0, occurrences: [{ id: "o1" }, { id: "o2" }] } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).items_created).toBe(2);
  });

  it("honors --no-artifacts in the seed payload", async () => {
    const result = await runWithResponder(
      ["space", "seed-from-filter", "space-1", "--predicate", '{"kind":"all"}', "--no-artifacts", "--json"],
      (req) => {
        expect(req.body).toMatchObject({ include_artifacts: false, with_shelf_occurrences: false });
        return { status: 200, body: { matched_issue_ids: [], items_created: 0, items_existing: 0, occurrences: [] } };
      },
    );
    expect(result.status).toBe(0);
  });

  it("rejects invalid predicate JSON before calling the route", async () => {
    const result = await runWithResponder(
      ["space", "seed-from-filter", "space-1", "--predicate", "not-json"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--predicate must be valid JSON");
    expect(result.seen).toHaveLength(0);
  });
});

describe("space CLI add-item ref mapping", () => {
  const cases: Array<{ ref: string; expect: Record<string, unknown> }> = [
    { ref: "issue:abc123", expect: { ref_type: "issue", ref_id: "abc123" } },
    { ref: "comment:cmt-9", expect: { ref_type: "comment", ref_id: "cmt-9" } },
    { ref: "artifact:logical", expect: { ref_type: "artifact", ref_id: "artifact:logical" } },
    { ref: "artifact-version:version-1", expect: { ref_type: "artifact", ref_id: "artifact-version:version-1" } },
    { ref: "artifact-blob:deadbeef", expect: { ref_type: "artifact", ref_id: "artifact-blob:deadbeef" } },
    { ref: "uri:https://example.com/x", expect: { ref_type: "external_ref", ref_id: "https://example.com/x", ref_uri: "https://example.com/x" } },
  ];

  for (const tc of cases) {
    it(`maps ${tc.ref} to the correct ref_type/ref_id`, async () => {
      const result = await runWithResponder(
        ["space", "add-item", "space-1", tc.ref, "--json"],
        (req) => {
          expect(req.path).toBe("/api/spaces/space-1/items");
          expect(req.body).toMatchObject(tc.expect);
          return { status: 201, body: { item: { id: "item-1", ref_type: tc.expect.ref_type, ref_id: tc.expect.ref_id }, created: true } };
        },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).item.ref_type).toBe(tc.expect.ref_type);
    });
  }

  it("rejects an unrecognized ref scheme without calling the route", async () => {
    const result = await runWithResponder(
      ["space", "add-item", "space-1", "bogus-ref"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unrecognized ref");
    expect(result.seen).toHaveLength(0);
  });

  it("rejects legacy artifact refs without calling the route", async () => {
    const result = await runWithResponder(
      ["space", "add-item", "space-1", "artifact:sha256:deadbeef"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unsupported artifact ref");
    expect(result.seen).toHaveLength(0);
  });
});

describe("space CLI promote-edge", () => {
  it("promotes an issue->issue edge via POST /api/ledger/relationships", async () => {
    const result = await runWithResponder(
      ["space", "promote-edge", "--source", "issue:abc", "--target", "issue:def", "--link-type", "blocks", "--edge", "edge-1", "--json"],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/ledger/relationships");
        expect(req.body).toMatchObject({ source_ref: "abc", target_refs: ["def"], link_type: "blocks" });
        return { status: 200, body: { edges: [{ id: "rel-1", link_type: "blocks" }] } };
      },
    );
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ promotable: true, status: "promoted", link_type: "blocks" });
  });

  it("promotes an issue->comment edge", async () => {
    const result = await runWithResponder(
      ["space", "promote-edge", "--source", "issue:abc", "--target", "comment:c1", "--json"],
      (req) => {
        expect(req.body).toMatchObject({ source_ref: "abc", target_refs: ["c1"], link_type: "references" });
        return { status: 200, body: { edges: [{ id: "rel-2" }] } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).promotable).toBe(true);
  });

  it("returns a not-promotable result for an artifact endpoint and never calls the route", async () => {
    const result = await runWithResponder(
      ["space", "promote-edge", "--source", "issue:abc", "--target", "artifact-blob:deadbeef", "--json"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(3);
    expect(result.seen).toHaveLength(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ promotable: false, status: "not_promotable" });
    expect(payload.blockers[0]).toMatchObject({ side: "target", kind: "artifact" });
  });

  it("returns a not-promotable result for a URI endpoint", async () => {
    const result = await runWithResponder(
      ["space", "promote-edge", "--source", "uri:https://x", "--target", "issue:abc", "--json"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(3);
    expect(result.seen).toHaveLength(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.promotable).toBe(false);
    expect(payload.blockers[0]).toMatchObject({ side: "source", kind: "external_ref" });
  });

  it("rejects an out-of-set link type before calling the route", async () => {
    const result = await runWithResponder(
      ["space", "promote-edge", "--source", "issue:a", "--target", "issue:b", "--link-type", "bogus"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --link-type");
    expect(result.seen).toHaveLength(0);
  });
});

describe("space CLI block subcommands", () => {
  it("adds a prose block via POST /api/spaces/:id/blocks", async () => {
    const result = await runWithResponder(
      ["space", "block", "add", "space-1", "--type", "paragraph", "--markdown", "hello world", "--json"],
      (req) => {
        expect(req.method).toBe("POST");
        expect(req.path).toBe("/api/spaces/space-1/blocks");
        expect(req.body).toMatchObject({ block_type: "paragraph", markdown: "hello world" });
        expect(req.body).not.toHaveProperty("parent_id");
        expect(req.body).not.toHaveProperty("item_id");
        return { status: 201, body: { block: { id: "blk-1", block_type: "paragraph", parent_id: null, item_id: null } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).block).toMatchObject({ id: "blk-1", block_type: "paragraph" });
  });

  it("emits a human-readable summary for a non-json block add", async () => {
    const result = await runWithResponder(
      ["space", "block", "add", "space-1", "--type", "heading", "--markdown", "Title"],
      (req) => {
        expect(req.body).toMatchObject({ block_type: "heading", markdown: "Title" });
        return { status: 201, body: { block: { id: "blk-h", block_type: "heading", parent_id: null, item_id: null } } };
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("added blk-h heading");
  });

  it("adds a nested embed block with parent, item, snapshot, and metadata", async () => {
    const result = await runWithResponder(
      [
        "space", "block", "add", "space-1",
        "--type", "issue_embed",
        "--parent", "blk-root",
        "--item", "item-1",
        "--snapshot", '{"item_id":"item-1","ref_type":"issue","ref_id":"abc"}',
        "--sort-key", "m",
        "--metadata", '{"collapsed":true}',
        "--json",
      ],
      (req) => {
        expect(req.path).toBe("/api/spaces/space-1/blocks");
        expect(req.body).toMatchObject({
          block_type: "issue_embed",
          parent_id: "blk-root",
          item_id: "item-1",
          item_snapshot: { item_id: "item-1", ref_type: "issue", ref_id: "abc" },
          sort_key: "m",
          metadata: { collapsed: true },
        });
        return { status: 201, body: { block: { id: "blk-2", block_type: "issue_embed", parent_id: "blk-root", item_id: "item-1" } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).block.item_id).toBe("item-1");
  });

  it("rejects an out-of-set block --type before calling the route", async () => {
    const result = await runWithResponder(
      ["space", "block", "add", "space-1", "--type", "bogus"],
      () => ({ status: 201, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --type");
    expect(result.seen).toHaveLength(0);
  });

  it("requires --type on block add", async () => {
    const result = await runWithResponder(
      ["space", "block", "add", "space-1"],
      () => ({ status: 201, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("mandible space block add");
    expect(result.seen).toHaveLength(0);
  });

  it("rejects a non-object --snapshot before calling the route", async () => {
    const result = await runWithResponder(
      ["space", "block", "add", "space-1", "--type", "reference", "--item", "i1", "--snapshot", "[1,2]"],
      () => ({ status: 201, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--snapshot must be a JSON object");
    expect(result.seen).toHaveLength(0);
  });

  it("rejects a non-object --metadata before calling the route", async () => {
    const result = await runWithResponder(
      ["space", "block", "add", "space-1", "--type", "paragraph", "--metadata", "not-json"],
      () => ({ status: 201, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--metadata must be a JSON object");
    expect(result.seen).toHaveLength(0);
  });

  it("edits a block via PATCH /api/spaces/:id/blocks/:block_id sending only provided fields", async () => {
    const result = await runWithResponder(
      ["space", "block", "edit", "space-1", "blk-1", "--markdown", "updated", "--json"],
      (req) => {
        expect(req.method).toBe("PATCH");
        expect(req.path).toBe("/api/spaces/space-1/blocks/blk-1");
        expect(req.body).toEqual({ markdown: "updated" });
        return { status: 200, body: { block: { id: "blk-1", block_type: "paragraph", parent_id: null, item_id: null } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).block.id).toBe("blk-1");
  });

  it("edits a block --type while validating against the set", async () => {
    const result = await runWithResponder(
      ["space", "block", "edit", "space-1", "blk-1", "--type", "todo", "--json"],
      (req) => {
        expect(req.method).toBe("PATCH");
        expect(req.body).toEqual({ block_type: "todo" });
        return { status: 200, body: { block: { id: "blk-1", block_type: "todo", parent_id: null, item_id: null } } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).block.block_type).toBe("todo");
  });

  it("allows clearing parent on edit by passing an empty --parent", async () => {
    const result = await runWithResponder(
      ["space", "block", "edit", "space-1", "blk-1", "--parent", "", "--json"],
      (req) => {
        expect(req.method).toBe("PATCH");
        expect(req.body).toEqual({ parent_id: "" });
        return { status: 200, body: { block: { id: "blk-1", block_type: "paragraph", parent_id: null, item_id: null } } };
      },
    );
    expect(result.status).toBe(0);
  });

  it("rejects an out-of-set --type on block edit before calling the route", async () => {
    const result = await runWithResponder(
      ["space", "block", "edit", "space-1", "blk-1", "--type", "bogus"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --type");
    expect(result.seen).toHaveLength(0);
  });

  it("requires a block-id on block edit", async () => {
    const result = await runWithResponder(
      ["space", "block", "edit", "space-1", "--markdown", "x"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("mandible space block edit");
    expect(result.seen).toHaveLength(0);
  });

  it("removes a block via DELETE /api/spaces/:id/blocks/:block_id", async () => {
    const result = await runWithResponder(
      ["space", "block", "rm", "space-1", "blk-1", "--json"],
      (req) => {
        expect(req.method).toBe("DELETE");
        expect(req.path).toBe("/api/spaces/space-1/blocks/blk-1");
        return { status: 200, body: { ok: true, id: "blk-1" } };
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, id: "blk-1" });
  });

  it("requires a block-id on block rm", async () => {
    const result = await runWithResponder(
      ["space", "block", "rm", "space-1"],
      () => ({ status: 200, body: {} }),
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("mandible space block rm");
    expect(result.seen).toHaveLength(0);
  });
});
