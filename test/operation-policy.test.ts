import { describe, expect, it } from "vitest";
import { bindOperationCatalog, canPerformOperation, type InstanceInfo } from "../ui/src/api";
import { registeredOperationRouter } from "./helpers/registered-operation-router.js";
import { operationCatalogFixture } from "./helpers/operation-catalog-fixture.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";

const preview: InstanceInfo = { ...resolveInstanceInfo({ env: {} }), role: "preview", instance_id: "preview-copy",
  allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"] };

describe("daemon-bound operation affordances", () => {
  it("uses registered static effects while leaving body decisions to the daemon", () => {
    const catalog = registeredOperationRouter(preview).operationCatalog("test");
    expect(operationCatalogFixture(preview).routes).toEqual(catalog.routes);
    expect(bindOperationCatalog(preview, catalog)).toBe(true);
    expect(canPerformOperation(undefined, "POST", "/api/ledger/issues/one/comments")).toBe(false);
    expect(canPerformOperation(preview, "POST", "/api/ledger/issues/one/comments")).toBe(true);
    expect(canPerformOperation(preview, "POST", "/api/auth/check")).toBe(false);
    expect(canPerformOperation(preview, "POST", "/api/unknown-operation")).toBe(false);
    expect(canPerformOperation(preview, "POST", "/api/artifacts/ingest", { content: "private bytes" })).toBe(true);
    // A body's custody is evaluated at daemon ingress, rather than copied into the UI.
    expect(canPerformOperation(preview, "POST", "/api/artifacts/ingest", { path: "/host/file" })).toBe(true);
    expect(canPerformOperation(preview, "POST", "/api/spaces/one/document/export")).toBe(false);
  });

  it("refuses missing, malformed, and stale-generation catalogs", () => {
    const catalog = registeredOperationRouter(preview).operationCatalog("test");
    for (const invalid of [null, { ...catalog, schema: "old" }, { ...catalog, runtime: { ...catalog.runtime, backend_generation: "stale" } },
      { ...catalog, routes: [{ method: "POST", path: "/api/auth/check" }] }]) {
      expect(bindOperationCatalog(preview, invalid)).toBe(false);
      expect(canPerformOperation(preview, "POST", "/api/ledger/issues/one/comments")).toBe(false);
    }
  });
});
