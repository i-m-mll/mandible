// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveRuntimeOrigin } from "../scripts/local-session-production-runner.mjs";

it("uses the protected origin transition while preserving the completed cutover identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-runner-origin-"));
  try {
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config", "canonical-origin.json"), JSON.stringify({
      production_origin: "https://mandible.localhost",
    }));
    const candidate = {
      MANDIBLE_INSTALLATION_ID: "install_original",
      MANDIBLE_PUBLIC_ORIGIN: "https://app.mandible.localhost:19420",
    };
    const journal = {
      schema: "mandible-local-origin-migration@1", state: "staged",
      instance_id: "production", installation_id: "install_original",
      old_origin: candidate.MANDIBLE_PUBLIC_ORIGIN,
      new_origin: "https://mandible.localhost",
    };
    expect(resolveRuntimeOrigin(candidate, null, root)).toEqual({ origin: candidate.MANDIBLE_PUBLIC_ORIGIN, migration: false });
    expect(resolveRuntimeOrigin(candidate, journal, root)).toEqual({ origin: journal.new_origin, migration: true });
    expect(resolveRuntimeOrigin(candidate, { ...journal, state: "complete" }, root))
      .toEqual({ origin: journal.new_origin, migration: false });
    expect(() => resolveRuntimeOrigin(candidate, journal, null)).toThrow("protected production build marker");
    expect(() => resolveRuntimeOrigin(candidate, { ...journal, installation_id: "other" }, root))
      .toThrow("does not match the completed production cutover");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
