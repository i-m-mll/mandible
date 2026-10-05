import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeSdkProvenance } from "../src/provider-provenance.js";

describe("provider startup provenance", () => {
  it("resolves the installed lock-selected package bytes and exact launchers", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { dependencies: Record<string, string> };
    const sdk = claudeSdkProvenance();

    expect(sdk.implementation.version).toBe(manifest.dependencies["@anthropic-ai/claude-agent-sdk"]);
    expect(fs.realpathSync(sdk.implementation.entrypoint)).toBe(sdk.implementation.entrypoint);
    expect(sdk.implementation.launcher).toBe(sdk.implementation.entrypoint);
  });
});
