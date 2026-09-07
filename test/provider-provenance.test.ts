import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeSdkProvenance, codexAcpProvenance } from "../src/provider-provenance.js";

describe("provider startup provenance", () => {
  it("resolves the installed lock-selected package bytes and exact launchers", () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    const sdk = claudeSdkProvenance();
    const acp = codexAcpProvenance();

    expect(sdk.implementation.version).toBe(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version);
    expect(acp.implementation.version).toBe(lock.packages["node_modules/@agentclientprotocol/codex-acp"].version);
    expect(fs.realpathSync(sdk.implementation.entrypoint)).toBe(sdk.implementation.entrypoint);
    expect(fs.realpathSync(acp.implementation.entrypoint)).toBe(acp.implementation.entrypoint);
    expect(sdk.implementation.launcher).toBe(sdk.implementation.entrypoint);
    expect(acp.implementation.launcher).toBe(process.execPath);
  });
});
