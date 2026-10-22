import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFileRpcResponder, type FileRpcRequest } from "../helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");
let spoolDir = "";

beforeEach(() => { spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-briefing-cli-")); });
afterEach(() => { fs.rmSync(spoolDir, { recursive: true, force: true }); });

function runOffline(args: string[]) {
  const result = spawnSync(CLI, args, { encoding: "utf8", env: { ...process.env, MANDIBLE_PORT: "9" } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runRpc(
  args: string[],
  handle: (request: FileRpcRequest) => { status: number; body: unknown },
): Promise<{ status: number | null; stdout: string; requests: FileRpcRequest[] }> {
  const responder = startFileRpcResponder(spoolDir, handle);
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      env: { ...process.env, MANDIBLE_BASE: `file://${spoolDir}`, MANDIBLE_FILE_RPC_TIMEOUT: "5",
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => {
      responder.stop();
      resolve({ status, stdout, requests: responder.requests });
    });
  });
}

function runCreate(): Promise<{ status: number | null; stdout: string; requests: FileRpcRequest[] }> {
  return runRpc(["briefing", "create", "artifact-version:4c62bc989c2b7a6f48583eb9eca871e8",
    "--title", "AGENTS review", "--description", "Approval-ready policy fixture.",
    "--comparison-base", "artifact-version:11111111111111111111111111111111", "--json"], (request) => {
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/briefings");
    expect(request.body).toEqual({
      artifact_version_ref: "artifact-version:4c62bc989c2b7a6f48583eb9eca871e8",
      comparison_base_artifact_version_ref: "artifact-version:11111111111111111111111111111111",
      title: "AGENTS review",
      description: "Approval-ready policy fixture.",
    });
    return { status: 201, body: {
      receipt_id: "round-1", briefing_id: "briefing-1", run_id: "artifact:v1",
      round_id: "round-1", artifact_version_id: "version-1", quiet: false,
    } };
  });
}

describe("briefing CLI", () => {
  it("documents and validates exact-version creation", () => {
    const help = runOffline(["briefing", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("mandible briefing create");
    const logical = runOffline(["briefing", "create", "artifact:logical", "--title", "Review"]);
    expect(logical.status).toBe(2);
    expect(logical.stderr).toContain("exact artifact-version");
    const logicalBase = runOffline(["briefing", "create", "artifact-version:exact", "--title", "Review",
      "--comparison-base", "artifact:logical"]);
    expect(logicalBase.status).toBe(2);
    expect(logicalBase.stderr).toContain("--comparison-base requires one exact artifact-version");
    expect(runOffline(["briefing", "create", "artifact-version:exact", "--title", "Review",
      "--briefing", "briefing:one", "--reason", "Separate"]).stderr)
      .toContain("Arguments do not match");
    expect(runOffline(["briefing", "create", "artifact-version:exact", "--title", "Review",
      "--reason", "  "]).stderr).toContain("nonblank");
  });

  it("sends direct report placement and Current update through their ordinary API routes", async () => {
    const placed = await runRpc(["briefing", "group", "destination", "place", "digest", "artifact:report",
      "--briefing", "briefing:report", "--operation-key", "place-1", "--expected-owner", "none",
      "--expected-target-base", "bundle:base", "--json"], (request) => {
      expect(request.path).toBe("/api/briefing-groups/digest/report-placement");
      expect(request.body).toEqual({ operation_key: "place-1", logical_artifact_ref: "artifact:report",
        briefing_ref: "briefing:report", expected_owner_group_ref: null,
        expected_target_base_ref: "bundle:base", expected_source_base_ref: null });
      return { status: 200, body: { changed: true, group_id: "digest", target_base_bundle_id: "bundle:next" } };
    });
    expect(placed.status).toBe(0);
    const updated = await runRpc(["briefing", "report", "update", "briefing:report", "artifact-version:new",
      "--operation-key", "round-1", "--expected-round", "old-round",
      "--expected-version", "artifact-version:old", "--json"], (request) => {
      expect(request.path).toBe("/api/briefings/briefing%3Areport/report-rounds");
      expect(request.body).toEqual({ operation_key: "round-1", artifact_version_ref: "artifact-version:new",
        expected_current_round_id: "old-round", expected_current_artifact_version_ref: "artifact-version:old" });
      return { status: 200, body: { changed: true, briefing_id: "briefing:report", round_id: "new-round" } };
    });
    expect(updated.status).toBe(0);
  });

  it("plans, applies, and inspects an installed destination-route manifest through the supported API", async () => {
    const manifest = {
      schema: "mandible-briefing-destination-routes@3",
      routes: [{ route_key: "digest.since-last-review",
        logical_artifact_ref: "artifact:artifact-12345678", publication_mode: "reviewed-document", heading: "Since last review",
        composer_kind: "agentic", template: { version: 1, contribution_template: "", slots: {} },
        limits: { max_contributions: 10, max_document_bytes: 100_000, max_directives: 0 } }],
    };
    const manifestPath = path.join(spoolDir, "routes.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const response = { schema: manifest.schema, changed: true, routes: [{
      route_key: "digest.since-last-review", action: "create", group_id: "group-12345678",
      logical_artifact_id: "artifact-12345678", publication_mode: "reviewed-document",
      heading: "Since last review", composer_kind: "agentic",
      active_template_version: 1, template_action: "create",
      limits: { max_contributions: 10, max_document_bytes: 100_000, max_directives: 0 },
    }] };
    for (const [action, expectedPath] of [
      ["plan", "/api/briefing-destination-routes/plan"],
      ["apply", "/api/briefing-destination-routes"],
    ] as const) {
      const result = await runRpc(["briefing", "route", action, manifestPath, "--json"], (request) => {
        expect(request).toMatchObject({ method: "POST", path: expectedPath, body: manifest });
        return { status: 200, body: response };
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ changed: true, routes: [{ action: "create" }] });
    }
    const inspected = await runRpc(["briefing", "route", "inspect", "digest.since-last-review", "--json"],
      (request) => {
        expect(request).toMatchObject({ method: "GET",
          path: "/api/briefing-destination-routes/digest.since-last-review" });
        return { status: 200, body: { schema: manifest.schema, routes: [{
          ...response.routes[0], templates: [{ version: 1, contribution_template: "", slots: {} }],
        }] } };
      });
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ routes: [{ route_key: "digest.since-last-review" }] });
    const human = await runRpc(["briefing", "route", "inspect", "digest.since-last-review"],
      () => ({ status: 200, body: { schema: manifest.schema, routes: [{
        ...response.routes[0], templates: [{ version: 1, contribution_template: "", slots: {} }],
      }] } }));
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("reviewed-document");
  });

  it("posts the exact version and title through the supported API", async () => {
    const result = await runCreate();
    expect(result.status).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ briefing_id: "briefing-1", round_id: "round-1" });
  });

  it("forwards explicit round-target and distinct-creation decisions", async () => {
    for (const [option, value, expected] of [
      ["--briefing", "briefing:existing", { target_briefing_ref: "briefing:existing" }],
      ["--reason", "Independent approval boundary.", { distinct_reason: "Independent approval boundary." }],
    ] as const) {
      const result = await runRpc([
        "briefing", "create", "artifact-version:exact", "--title", "Review", option, value, "--json",
      ], (request) => {
        expect(request).toMatchObject({ method: "POST", path: "/api/briefings", body: {
          artifact_version_ref: "artifact-version:exact", title: "Review", ...expected,
        } });
        return { status: option === "--briefing" ? 200 : 201, body: {
          outcome: option === "--briefing" ? "round_reused" : "created_distinct",
          receipt_id: "round-1", briefing_id: "briefing-1", run_id: "artifact:exact",
          round_id: "round-1", artifact_version_id: "artifact-version:exact", quiet: false,
          logical_artifact_id: "artifact:logical", active_candidates: [], archived_candidates: [],
          override_receipt_id: option === "--briefing" ? null : "override-1",
        } };
      });
      expect(result.status).toBe(0);
      expect(result.requests).toHaveLength(1);
    }
  });

  it("renames an individual Briefing through the supported API", async () => {
    const result = await runRpc(["briefing", "rename", "briefing:briefing-12345678",
      "--title", "Container-relative name", "--json"], (request) => {
      expect(request).toMatchObject({ method: "PATCH", path: "/api/briefings/briefing%3Abriefing-12345678",
        body: { title: "Container-relative name" } });
      return { status: 200, body: {
        briefing_id: "briefing-12345678", title: "Container-relative name", changed: true,
      } };
    });
    expect(result.status).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ briefing_id: "briefing-12345678", changed: true });
  });

  it("sets and clears an individual Briefing description through the supported API", async () => {
    for (const args of [
      ["--description", "Durable source snapshot."],
      ["--clear"],
    ]) {
      const expected = args[0] === "--clear" ? null : args[1];
      const result = await runRpc(["briefing", "describe", "briefing:briefing-12345678", ...args, "--json"],
        (request) => {
          expect(request).toMatchObject({ method: "PATCH", path: "/api/briefings/briefing%3Abriefing-12345678",
            body: { description: expected } });
          return { status: 200, body: {
            briefing_id: "briefing-12345678", description: expected, changed: true,
          } };
        });
      expect(result.status).toBe(0);
      expect(result.requests).toHaveLength(1);
    }
    expect(runOffline(["briefing", "describe", "briefing:one", "--description", "  "]).stderr)
      .toContain("nonblank");
  });

  it("archives and restores an exact Briefing through the supported API", async () => {
    for (const action of ["archive", "restore"]) {
      const result = await runRpc(["briefing", action, "briefing:briefing-12345678", "--json"], (request) => {
        expect(request).toMatchObject({ method: "POST",
          path: `/api/briefings/briefing%3Abriefing-12345678/${action}`, body: {} });
        return { status: 200, body: {
          briefing_id: "briefing-12345678", archived_at: action === "archive" ? 123 : null, changed: true,
        } };
      });
      expect(result.status).toBe(0);
      expect(result.requests).toHaveLength(1);
    }
  });

  it("archives and restores a group and forwards explicit sharing provenance", async () => {
    const group = { id: "group-12345678", name: "Policy", archived_at: 123,
      current: null, updates: [], history: [], created_at: 1, updated_at: 2 };
    for (const action of ["archive", "restore"]) {
      const result = await runRpc(["briefing", "group", action, group.id, "--json"], (request) => {
        expect(request).toMatchObject({ method: "POST", path: `/api/briefing-groups/${group.id}/${action}`, body: {} });
        return { status: 200, body: { group: { ...group, archived_at: action === "archive" ? 123 : null }, changed: true } };
      });
      expect(result.status).toBe(0);
    }
    const shared = await runRpc(["briefing", "group", "add", group.id, "bundle-1",
      "--sharing-reason", "Deliberate comparative placement", "--json"], (request) => {
      expect(request.body).toEqual({ bundle_ref: "bundle-1", sharing_reason: "Deliberate comparative placement" });
      return { status: 200, body: { group, added: true } };
    });
    expect(shared.status).toBe(0);
  });

  it("supports create, append, and show for ordered Briefing bundles", async () => {
    const bundle = { id: "bundle-12345678", name: "Agent policy", created_at: 1, updated_at: 1,
      members: [{ position: 0, briefing: { id: "briefing-one", title: "Global", briefing_key: "global",
        latest_round_id: "round-1", round_count: 1, created_at: 1, updated_at: 1 } }] };
    const created = await runRpc(["briefing", "bundle", "create", "--name", "Agent policy",
      "briefing-one", "--json"], (request) => {
      expect(request).toMatchObject({ method: "POST", path: "/api/briefing-bundles",
        body: { name: "Agent policy", briefing_refs: ["briefing-one"] } });
      return { status: 201, body: { bundle } };
    });
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ bundle: { id: "bundle-12345678" } });

    const added = await runRpc(["briefing", "bundle", "add", "bundle-12345678", "briefing-two", "--json"],
      (request) => {
        expect(request).toMatchObject({ method: "POST", path: "/api/briefing-bundles/bundle-12345678/briefings",
          body: { briefing_ref: "briefing-two" } });
        return { status: 200, body: { bundle, added: true } };
      });
    expect(added.status).toBe(0);

    const replaced = await runRpc(["briefing", "bundle", "replace", "briefing-bundle:bundle-12345678",
      "briefing-two", "briefing-one", "--json"], (request) => {
      expect(request).toMatchObject({ method: "PATCH",
        path: "/api/briefing-bundles/briefing-bundle%3Abundle-12345678",
        body: { briefing_refs: ["briefing-two", "briefing-one"] } });
      return { status: 200, body: { bundle, changed: true, membership_changed: true } };
    });
    expect(replaced.status).toBe(0);
    expect(JSON.parse(replaced.stdout)).toMatchObject({ bundle: { id: "bundle-12345678" },
      membership_changed: true });

    const structured = await runRpc(["briefing", "bundle", "replace", "bundle-12345678", "--layout",
      JSON.stringify([
        { kind: "briefing", briefing_ref: "briefing-global" },
        { kind: "briefing", briefing_ref: "briefing-codex" },
        { kind: "briefing", briefing_ref: "briefing-claude" },
        { kind: "subgroup", name: "Skills", briefing_refs: ["reliability", "performance", "squeeze", "strict"] },
      ])], (request) => {
      expect(request).toMatchObject({ method: "PATCH", path: "/api/briefing-bundles/bundle-12345678",
        body: { layout: [
          { kind: "briefing", briefing_ref: "briefing-global" },
          { kind: "briefing", briefing_ref: "briefing-codex" },
          { kind: "briefing", briefing_ref: "briefing-claude" },
          { kind: "subgroup", name: "Skills",
            briefing_refs: ["reliability", "performance", "squeeze", "strict"] },
        ] } });
      const briefing = (id: string, title: string) => ({ id, title, briefing_key: id,
        latest_round_id: null, round_count: 0, created_at: 1, updated_at: 1 });
      return { status: 200, body: { bundle: { ...bundle, layout: [
        { kind: "briefing", position: 0, briefing: briefing("briefing-global", "Global") },
        { kind: "briefing", position: 1, briefing: briefing("briefing-codex", "Codex") },
        { kind: "briefing", position: 2, briefing: briefing("briefing-claude", "Claude") },
        { kind: "subgroup", position: 3, name: "Skills", briefings: [
          { position: 0, briefing: briefing("reliability", "Reliability design") },
          { position: 1, briefing: briefing("performance", "Performance") },
          { position: 2, briefing: briefing("squeeze", "Squeeze") },
          { position: 3, briefing: briefing("strict", "Strict engineering") },
        ] },
      ] }, changed: true, layout_changed: true } };
    });
    expect(structured.status).toBe(0);
    expect(structured.stdout).toContain("Global");
    expect(structured.stdout).toContain("Skills");
    expect(structured.stdout).toContain("Strict engineering");
    expect(structured.stdout).not.toContain("Policy\n");

    const renamedBundle = { ...bundle, name: "Sara’s skill, breakdown" };
    const renamed = await runRpc(["briefing", "bundle", "rename", "briefing-bundle:bundle-12345678",
      "--name", "Sara’s skill, breakdown", "--json"], (request) => {
      expect(request).toMatchObject({ method: "PATCH",
        path: "/api/briefing-bundles/briefing-bundle%3Abundle-12345678",
        body: { name: "Sara’s skill, breakdown" } });
      return { status: 200, body: { bundle: renamedBundle, changed: true } };
    });
    expect(renamed.status).toBe(0);
    expect(JSON.parse(renamed.stdout)).toMatchObject({ bundle: { id: "bundle-12345678",
      name: "Sara’s skill, breakdown" }, changed: true });

    const shown = await runRpc(["briefing", "bundle", "show", "bundle-12345678", "--json"], (request) => {
      expect(request).toMatchObject({ method: "GET", path: "/api/briefing-bundles/bundle-12345678" });
      return { status: 200, body: { bundle } };
    });
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).bundle.members).toHaveLength(1);

    const deleted = await runRpc(["briefing", "bundle", "delete", "bundle-empty", "--json"], (request) => {
      expect(request).toMatchObject({ method: "DELETE", path: "/api/briefing-bundles/bundle-empty", body: {} });
      return { status: 200, body: { bundle_id: "bundle-empty", name: "Empty", deleted: true } };
    });
    expect(deleted.status).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({ bundle_id: "bundle-empty", deleted: true });
  });

  it("supports create, append, rename, and show for stable Briefing groups", async () => {
    const bundle = { id: "bundle-one", name: "Proposal one", created_at: 1, updated_at: 1,
      layout: [], members: [] };
    const group = { id: "group-12345678", key: "policy", name: "Policy", created_at: 1, updated_at: 1, updates: [bundle] };
    const created = await runRpc(["briefing", "group", "create", "--key", "policy", "--name", "Policy", "--current", "bundle-current",
      "bundle-one", "--json"],
      (request) => {
        expect(request).toMatchObject({ method: "POST", path: "/api/briefing-groups",
          body: { key: "policy", name: "Policy", current_bundle_ref: "bundle-current", bundle_refs: ["bundle-one"] } });
        return { status: 201, body: { group } };
      });
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ group: { id: "group-12345678" } });

    const added = await runRpc(["briefing", "group", "add", "briefing-group:group-12345678", "bundle-two", "--json"],
      (request) => {
        expect(request).toMatchObject({ method: "POST",
          path: "/api/briefing-groups/briefing-group%3Agroup-12345678/updates",
          body: { bundle_ref: "bundle-two" } });
        return { status: 200, body: { group, added: true } };
      });
    expect(added.status).toBe(0);

    const configured = await runRpc(["briefing", "group", "configure", "briefing-group:group-12345678",
      "--current", "bundle-current", "bundle-two", "bundle-one", "--json"], (request) => {
      expect(request).toMatchObject({ method: "PUT",
        path: "/api/briefing-groups/briefing-group%3Agroup-12345678/configuration",
        body: { current_bundle_ref: "bundle-current", bundle_refs: ["bundle-two", "bundle-one"] } });
      return { status: 200, body: { group: { ...group, current: bundle }, changed: true } };
    });
    expect(configured.status).toBe(0);

    const noCurrent = await runRpc(["briefing", "group", "configure", "group-12345678",
      "--current", "none", "--json"], (request) => {
      expect(request.body).toEqual({ current_bundle_ref: null, bundle_refs: [] });
      return { status: 200, body: { group: { ...group, current: null, updates: [] }, changed: true } };
    });
    expect(noCurrent.status).toBe(0);

    const mergeHead = "a".repeat(40);
    const promoted = await runRpc(["briefing", "group", "promote", "group-12345678",
      "--expected-base", "bundle-current", "--proposal", "bundle-one",
      "--auth-request", "auth-12345678", "--merge-head", mergeHead, "--json"], (request) => {
      expect(request).toMatchObject({ method: "POST",
        path: "/api/briefing-groups/group-12345678/promotions/apply",
        body: {
          expected_base_bundle_ref: "bundle-current",
          proposal_bundle_ref: "bundle-one",
          auth_request_ref: "auth-12345678",
          merge_head_sha: mergeHead,
        } });
      return { status: 200, body: { group: { ...group, current: bundle, updates: [], history: [] },
        disposition: {}, changed: true } };
    });
    expect(promoted.status).toBe(0);
    expect(JSON.parse(promoted.stdout)).toMatchObject({ changed: true });
    expect(runOffline(["briefing", "group", "promote", "group", "--expected-base", "base",
      "--proposal", "proposal", "--auth-request", "auth", "--merge-head", "main"]).stderr)
      .toContain("40-character");

    const bindingDigest = "b".repeat(64);
    for (const [action, decision] of [["accept", "accepted"], ["reject", "rejected"]] as const) {
      const reviewed = await runRpc(["briefing", "group", action, "group-12345678",
        "--expected-base", "bundle-current", "--proposal", "bundle-one",
        "--binding-digest", bindingDigest, "--destination-changes",
        JSON.stringify([{ logical_artifact_ref: "artifact:report", expected_group_ref: null }]), "--json"], (request) => {
        expect(request).toMatchObject({ method: "POST",
          path: "/api/briefing-groups/group-12345678/review-dispositions",
          body: {
            decision,
            expected_base_bundle_ref: "bundle-current",
            proposal_bundle_ref: "bundle-one",
            binding_digest: bindingDigest,
            destination_changes: [{ logical_artifact_ref: "artifact:report", expected_group_ref: null }],
          } });
        return { status: 200, body: { group: { ...group, current: bundle, updates: [], history: [] },
          disposition: { kind: decision }, changed: true } };
      });
      expect(reviewed.status).toBe(0);
    }
    expect(runOffline(["briefing", "group", "accept", "group", "--expected-base", "base",
      "--proposal", "proposal", "--binding-digest", "short"]).stderr).toContain("SHA-256");

    const renamed = await runRpc(["briefing", "group", "rename", "group-12345678", "--name", "Policy review", "--json"],
      (request) => {
        expect(request).toMatchObject({ method: "PATCH", path: "/api/briefing-groups/group-12345678",
          body: { name: "Policy review" } });
        return { status: 200, body: { group: { ...group, name: "Policy review" }, changed: true } };
      });
    expect(renamed.status).toBe(0);

    const shown = await runRpc(["briefing", "group", "show", "group-12345678", "--json"], (request) => {
      expect(request).toMatchObject({ method: "GET", path: "/api/briefing-groups/group-12345678" });
      return { status: 200, body: { group } };
    });
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).group.updates).toHaveLength(1);
  });
});
