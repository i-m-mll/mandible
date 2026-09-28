import { describe, expect, it } from "vitest";
import { canPerformOperation, type InstanceInfo } from "../ui/src/api";

const preview: InstanceInfo = {
  role: "preview",
  instance_id: "preview-copy",
  installation_id: "test-installation",
  public_origin: "https://preview.mandible.localhost",
  backend_generation: "test",
  allowed_effects: ["ledger:read", "ledger:write", "files:preview", "preferences:instance"],
  writable_roots: [],
  db_path: null,
  db_path_source: null,
};

describe("shared instance operation policy", () => {
  it("uses the server route effects and denies unknown instance state", () => {
    expect(canPerformOperation(undefined, "POST", "/api/issues/one/comments")).toBe(false);
    expect(canPerformOperation(preview, "POST", "/api/issues/one/comments")).toBe(true);
    expect(canPerformOperation(preview, "POST", "/api/auth/check")).toBe(false);
    expect(canPerformOperation({ ...preview, role: "main", allowed_effects: [
      "ledger:read", "ledger:write", "files:preview", "files:production", "auth:protected",
      "auth:credentials", "process:external", "provider:send", "network:publish",
      "delivery:background", "maintenance:shared", "preferences:instance",
    ] }, "POST", "/api/auth/check")).toBe(true);
    expect(canPerformOperation(preview, "POST", "/api/artifacts/ingest", { content: "private bytes" })).toBe(true);
    expect(canPerformOperation(preview, "POST", "/api/artifacts/ingest", { path: "/host/file" })).toBe(false);
  });
});
