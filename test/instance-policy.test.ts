// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { authorizeEffects, operationForRequest, STANDARD_PREVIEW_EFFECTS, validatePreviewWritableRoots } from "../src/security/effect-policy.js";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function preview(overrides: NodeJS.ProcessEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-policy-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-source-"));
  roots.add(root);
  roots.add(sourceRoot);
  const source = path.join(sourceRoot, "source.db");
  const copy = path.join(root, "copy.db");
  fs.writeFileSync(source, "source");
  fs.copyFileSync(source, copy);
  const artifacts = path.join(root, "artifacts");
  const sourceArtifacts = path.join(sourceRoot, "artifacts");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(sourceArtifacts);
  return resolveInstanceInfo({
    env: {
      MANDIBLE_INSTANCE_ROLE: "preview",
      MANDIBLE_INSTANCE_ID: "preview-0123456789abcdef",
      MANDIBLE_INSTALLATION_ID: "install_test",
      MANDIBLE_PUBLIC_ORIGIN: "https://preview-0123456789abcdef.mandible.localhost:19421",
      MANDIBLE_BACKEND_GENERATION: "preview-1",
      MANDIBLE_PREVIEW_ROOT: root,
      MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(STANDARD_PREVIEW_EFFECTS),
      MANDIBLE_ARTIFACT_DIR: artifacts,
      MANDIBLE_INSTANCE_SOURCE_ARTIFACT_DIR: sourceArtifacts,
      ...overrides,
    },
    dbPath: copy,
    sourceDbPath: source,
  });
}

describe("instance effect policy", () => {
  it("defaults production to a stable HTTPS identity", () => {
    expect(resolveInstanceInfo({ env: {} })).toMatchObject({
      role: "main", instance_id: "production", public_origin: "https://app.mandible.localhost:19420",
    });
  });

  it("requires preview identity and an isolated copied database", () => {
    expect(() => resolveInstanceInfo({ env: { MANDIBLE_INSTANCE_ROLE: "preview" } })).toThrow();
    expect(preview()).toMatchObject({ role: "preview", allowed_effects: STANDARD_PREVIEW_EFFECTS });
    expect(() => preview({ MANDIBLE_PUBLIC_ORIGIN: "http://preview.invalid:19421" })).toThrow("registered HTTPS origin");
  });

  it("rejects copied-database aliases and writable roots outside preview custody", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-alias-"));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-alias-source-"));
    roots.add(root);
    roots.add(sourceRoot);
    const source = path.join(sourceRoot, "source.db");
    fs.writeFileSync(source, "source");
    const env = {
      MANDIBLE_INSTANCE_ROLE: "preview", MANDIBLE_INSTANCE_ID: "preview-0123456789abcdef",
      MANDIBLE_INSTALLATION_ID: "install_test",
      MANDIBLE_PUBLIC_ORIGIN: "https://preview-0123456789abcdef.mandible.localhost:19421",
      MANDIBLE_BACKEND_GENERATION: "preview-1", MANDIBLE_PREVIEW_ROOT: root,
    };
    expect(() => resolveInstanceInfo({ env, dbPath: source, sourceDbPath: source })).toThrow("isolated copied database");
    const copy = path.join(root, "copy.db");
    fs.copyFileSync(source, copy);
    expect(() => resolveInstanceInfo({ env: { ...env, MANDIBLE_WRITABLE_ROOTS: JSON.stringify([os.tmpdir()]) }, dbPath: copy, sourceDbPath: source })).toThrow("writable roots");
    const nestedSource = path.join(root, "nested-source.db");
    fs.writeFileSync(nestedSource, "source");
    expect(() => resolveInstanceInfo({ env, dbPath: copy, sourceDbPath: nestedSource })).toThrow("isolated copied database");
  });

  it("keeps a real copied-ledger edit inside preview custody", () => {
    const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-ledger-"));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-production-ledger-"));
    roots.add(previewRoot);
    roots.add(sourceRoot);
    const source = path.join(sourceRoot, "production.db");
    const copy = path.join(previewRoot, "preview.db");
    const production = new Database(source);
    production.exec("CREATE TABLE notes (value TEXT NOT NULL); INSERT INTO notes VALUES ('production')");
    production.close();
    fs.copyFileSync(source, copy);

    const instance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_INSTANCE_ID: "preview-0123456789abcdef",
        MANDIBLE_INSTALLATION_ID: "install_test",
        MANDIBLE_PUBLIC_ORIGIN: "https://preview-0123456789abcdef.mandible.localhost:19421",
        MANDIBLE_BACKEND_GENERATION: "preview-1",
        MANDIBLE_PREVIEW_ROOT: previewRoot,
        MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(STANDARD_PREVIEW_EFFECTS),
      },
      dbPath: copy,
      sourceDbPath: source,
    });
    const previewDb = new Database(instance.db_path);
    previewDb.prepare("INSERT INTO notes VALUES (?)").run("preview-only");
    previewDb.close();

    const unchanged = new Database(source, { readonly: true });
    expect(unchanged.prepare("SELECT value FROM notes ORDER BY rowid").pluck().all()).toEqual(["production"]);
    unchanged.close();
    expect(authorizeEffects(instance, { effect_ceiling: STANDARD_PREVIEW_EFFECTS }, operationForRequest("PUT", "/api/host-preferences/app-theme"))).toMatchObject({ allowed: false });
  });

  it("intersects request effects with both session and preview ceilings", () => {
    const instance = preview();
    const session = { effect_ceiling: ["ledger:read", "ledger:write", "files:preview", "auth:protected"] as const };
    expect(authorizeEffects(instance, session, operationForRequest("GET", "/api/issues"))).toEqual({ allowed: true });
    expect(authorizeEffects(instance, session, operationForRequest("POST", "/api/issues"))).toEqual({ allowed: true });
    expect(authorizeEffects(instance, session, operationForRequest("GET", "/api/auth/requests"))).toMatchObject({ allowed: false });
    expect(authorizeEffects(instance, session, operationForRequest("POST", "/api/webhooks"))).toMatchObject({ allowed: false });
    expect(operationForRequest("POST", "/api/artifacts/versions")).toMatchObject({
      effects: ["ledger:write", "files:preview"],
    });
  });

  it("proves preview artifact custody is a distinct directory below the preview root", () => {
    const instance = preview();
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-production-artifacts-"));
    roots.add(sourceRoot);
    expect(() => validatePreviewWritableRoots(instance)).not.toThrow();
    expect(() => validatePreviewWritableRoots({
      ...instance,
      artifact_root: sourceRoot,
    })).toThrow("escapes registered custody");
  });

  it("rejects every unclassified write and explicitly guards external-open operations", () => {
    expect(authorizeEffects(preview(), { effect_ceiling: STANDARD_PREVIEW_EFFECTS }, operationForRequest("POST", "/api/future-local-write"))).toEqual({
      allowed: false, code: "unknown_operation", missing: [],
    });
    for (const pathname of [
      "/api/system/open-path",
      "/api/artifacts/example/open-externally",
      "/api/conversations/example/open-external",
    ]) {
      expect(operationForRequest("POST", pathname)).toMatchObject({ effects: ["process:external"] });
      expect(authorizeEffects(preview(), { effect_ceiling: STANDARD_PREVIEW_EFFECTS }, operationForRequest("POST", pathname))).toMatchObject({ allowed: false });
    }
  });
});
