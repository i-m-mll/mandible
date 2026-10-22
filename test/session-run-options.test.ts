import { describe, expect, it } from "vitest";
import {
  composeRunOptions,
  declaredRunOptionsSnapshot,
  SessionRunOptionError,
  validateRunOptionsPatch,
  type BackendRunOptionDeclaration,
} from "../src/session-run-options.js";

const declaration: BackendRunOptionDeclaration = {
  backendType: "acp",
  command: "adapter",
  options: [
    {
      id: "model", label: "Backend model", category: "model", kind: "select", nullable: false,
      discovery: { kind: "provider", protocol: "acp_session_config", providerOptionId: "model", fallbackAllowedValues: null },
      support: { status: "supported", owner: "provider", effectiveFrom: "next_prompt" }, applyOrder: 10,
    },
    {
      id: "missing", label: "Missing", category: "mode", kind: "select", nullable: false,
      discovery: { kind: "provider", protocol: "acp_session_config", providerOptionId: "missing", fallbackAllowedValues: null },
      support: { status: "supported", owner: "provider", effectiveFrom: "immediate" }, applyOrder: 20,
    },
  ],
  runtimeDiscoveredOptions: {
    source: "acp_session_config", managedCategories: ["model"], managedKinds: ["select"], undeclaredOptions: "read_only",
  },
};

describe("session run options", () => {
  it("composes provider state by exact ID while preserving backend ownership", () => {
    const snapshot = composeRunOptions(declaration, [
      { id: "model", label: "Provider model", category: "model", kind: "select", currentValue: "m2",
        allowedValues: [{ value: "m2", label: "Model two" }] },
      { id: "provider_only", label: "Provider only", category: "custom", kind: "boolean", currentValue: true,
        allowedValues: [{ value: true, label: "On" }, { value: false, label: "Off" }] },
    ]);
    expect(snapshot.options.find((option) => option.id === "model")).toMatchObject({
      label: "Provider model", currentValue: "m2", source: "composed",
      enforcement: { status: "enforced", owner: "provider", effectiveFrom: "next_prompt" },
    });
    expect(snapshot.options.find((option) => option.id === "missing")).toMatchObject({ availability: "unavailable" });
    expect(snapshot.options.find((option) => option.id === "provider_only")).toMatchObject({
      source: "provider", enforcement: { status: "unsupported" },
    });
  });

  it("rejects unknown options and unavailable values with backend and option identity", () => {
    const declared = declaredRunOptionsSnapshot(declaration);
    expect(() => validateRunOptionsPatch(declaration, declared, { values: { unknown: "x" } }))
      .toThrowError(expect.objectContaining({ code: "unsupported_option", optionId: "unknown", backend: { type: "acp", command: "adapter" } }));
    const runtime = composeRunOptions(declaration, [{ id: "model", label: "Model", category: "model", kind: "select",
      currentValue: "m1", allowedValues: [{ value: "m1", label: "M1" }] }]);
    try {
      validateRunOptionsPatch(declaration, runtime, { values: { model: "m2" } });
      throw new Error("expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionRunOptionError);
      expect(error).toMatchObject({ code: "unavailable_value", optionId: "model", backend: { type: "acp", command: "adapter" } });
    }
  });

  it("exposes a backend-owned effective default before provider startup", () => {
    const snapshot = declaredRunOptionsSnapshot({
      backendType: "sdk",
      command: "claude",
      options: [{
        id: "permission_mode",
        label: "Permission mode",
        category: "mode",
        kind: "select",
        nullable: true,
        defaultValue: "default",
        discovery: { kind: "static", allowedValues: [{ value: "default", label: "Ask for approval" }] },
        support: { status: "supported", owner: "backend", effectiveFrom: "immediate" },
        applyOrder: 10,
      }],
    });

    expect(snapshot.options[0]).toMatchObject({ currentValue: "default", availability: "available" });
  });


});
