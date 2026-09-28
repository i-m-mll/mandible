// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HostUserPreferencesStore } from "../src/host-user-preferences.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { authorizeEffects, operationForRequest, STANDARD_PREVIEW_EFFECTS, validatePreviewWritableRoots } from "../src/security/effect-policy.js";
import { openDb } from "../src/db.js";
import { readUserSetting, writeUserSetting } from "../src/user-settings.js";

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
  const userPreferences = path.join(root, "settings", "users");
  const sourceArtifacts = path.join(sourceRoot, "artifacts");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(userPreferences, { recursive: true });
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
      MANDIBLE_USER_PREFERENCES_DIR: userPreferences,
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
    const userPreferences = path.join(root, "settings", "users");
    fs.mkdirSync(userPreferences, { recursive: true });
    const env = {
      MANDIBLE_INSTANCE_ROLE: "preview", MANDIBLE_INSTANCE_ID: "preview-0123456789abcdef",
      MANDIBLE_INSTALLATION_ID: "install_test",
      MANDIBLE_PUBLIC_ORIGIN: "https://preview-0123456789abcdef.mandible.localhost:19421",
      MANDIBLE_BACKEND_GENERATION: "preview-1", MANDIBLE_PREVIEW_ROOT: root,
      MANDIBLE_USER_PREFERENCES_DIR: userPreferences,
    };
    expect(() => resolveInstanceInfo({ env, dbPath: source, sourceDbPath: source })).toThrow("isolated copied database");
    const copy = path.join(root, "copy.db");
    fs.copyFileSync(source, copy);
    expect(() => resolveInstanceInfo({ env: { ...env, MANDIBLE_WRITABLE_ROOTS: JSON.stringify([os.tmpdir()]) }, dbPath: copy, sourceDbPath: source })).toThrow("writable roots");
    const nestedSource = path.join(root, "nested-source.db");
    fs.writeFileSync(nestedSource, "source");
    expect(() => resolveInstanceInfo({ env, dbPath: copy, sourceDbPath: nestedSource })).toThrow("isolated copied database");
  });

  it("rejects user-preference paths outside preview custody, including symlink escapes", () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-user-preferences-outside-"));
    roots.add(outsideRoot);
    const outside = path.join(outsideRoot, "users");
    fs.mkdirSync(outside);
    expect(() => preview({ MANDIBLE_USER_PREFERENCES_DIR: outside }))
      .toThrow("isolated user-preferences directory");

    const instance = preview();
    const link = path.join(instance.preview_root!, "settings", "users-link");
    fs.symlinkSync(outside, link, "dir");
    expect(() => validatePreviewWritableRoots({ ...instance, user_preferences_root: link }))
      .toThrow("user-preferences directory escapes registered custody");
  });

  it("allows copied-ledger and known isolated preference writes in a standard preview", () => {
    const instance = preview();
    const identity = { effect_ceiling: STANDARD_PREVIEW_EFFECTS };
    for (const pathname of [
      "/api/host-preferences/app-theme",
      "/api/host-preferences/sidebar-order",
      "/api/user-settings/app_rail_order",
      "/api/user-settings/ui_font_face",
      "/api/user-settings/detail_font_size",
    ]) {
      expect(authorizeEffects(instance, identity, operationForRequest("PUT", pathname)))
        .toEqual({ allowed: true });
    }
    for (const pathname of ["/api/settings/app_theme", "/api/projects", "/api/work/repos/repo-1"]) {
      expect(operationForRequest("PUT", pathname, "preview")).toEqual({
        id: pathname.startsWith("/api/projects") ? "projects.registry.write"
          : pathname.startsWith("/api/work") ? "ledger.write" : "settings.copy.write",
        effects: ["ledger:write"],
      });
      expect(authorizeEffects(instance, identity, operationForRequest("PUT", pathname, "preview")))
        .toEqual({ allowed: true });
    }
    expect(authorizeEffects(instance, identity, operationForRequest("PUT", "/api/user-settings/unknown", "preview")))
      .toMatchObject({ allowed: false, missing: ["maintenance:shared"] });
  });

  it("allows copied work projections without starting Git scans and retains process gates", () => {
    const identity = { effect_ceiling: STANDARD_PREVIEW_EFFECTS };
    for (const pathname of [
      "/api/work/repos",
      "/api/work/repos/repo-1/branches",
      "/api/work/repos/repo-1/worktrees",
      "/api/work/repos/repo-1/branch/main",
      "/api/work/push/status",
    ]) {
      const operation = operationForRequest("GET", pathname, "preview");
      expect(operation?.effects).toEqual(["ledger:read"]);
      expect(authorizeEffects(preview(), identity, operation)).toEqual({ allowed: true });
    }
    for (const [method, pathname, effects] of [
      ["GET", "/api/work/repos/repo-1/audit", ["ledger:write", "process:external"]],
      ["GET", "/api/work/repos/repo-1/branches/main/commits", ["process:external"]],
      ["GET", "/api/work/repos/repo-1/compare", ["process:external"]],
      ["POST", "/api/work/scan", ["ledger:write", "process:external"]],
      ["POST", "/api/work/repos/repo-1/push", ["ledger:write", "files:production", "network:publish", "process:external"]],
    ] as const) {
      const operation = operationForRequest(method, pathname, "preview");
      expect(operation?.effects).toEqual(effects);
      expect(authorizeEffects(preview(), identity, operation)).toMatchObject({ allowed: false });
    }
  });

  it("permits copied reminder, webhook, and console preference data while guarding delivery", () => {
    const identity = { effect_ceiling: STANDARD_PREVIEW_EFFECTS };
    for (const [method, pathname, effects] of [
      ["GET", "/api/reminders", ["ledger:read"]],
      ["GET", "/api/reminders/task-1", ["ledger:read"]],
      ["GET", "/api/webhooks", ["ledger:read"]],
      ["POST", "/api/webhooks/event-1/dismiss", ["ledger:write"]],
      ["GET", "/api/console/pinned", ["ledger:read"]],
      ["PUT", "/api/console/pinned", ["ledger:write"]],
    ] as const) {
      const operation = operationForRequest(method, pathname, "preview");
      expect(operation?.effects).toEqual(effects);
      expect(authorizeEffects(preview(), identity, operation)).toEqual({ allowed: true });
    }
    for (const [method, pathname] of [
      ["POST", "/api/reminders"],
      ["POST", "/api/reminders/task-1/cancel"],
      ["POST", "/api/webhooks/ingest"],
      ["POST", "/api/webhooks/event-1/deliver"],
      ["GET", "/api/console/sessions"],
    ]) {
      expect(authorizeEffects(preview(), identity, operationForRequest(method, pathname, "preview")))
        .toMatchObject({ allowed: false });
    }
  });

  it("exposes copied auth queue review paths while keeping preparation and authority actions protected", () => {
    const identity = { effect_ceiling: STANDARD_PREVIEW_EFFECTS };
    for (const [method, pathname] of [
      ["GET", "/api/auth/queue"],
      ["GET", "/api/auth/history"],
      ["GET", "/api/auth/request/request-1"],
      ["GET", "/api/auth/request/request-1/actions"],
      ["GET", "/api/auth/clearances"],
      ["GET", "/api/auth/clearances/clearance-1"],
      ["POST", "/api/auth/request"],
      ["POST", "/api/auth/request/request-1/actions"],
      ["PUT", "/api/auth/request/request-1/actions/action-1"],
      ["DELETE", "/api/auth/request/request-1/actions/action-1"],
      ["POST", "/api/auth/request/request-1/actions/action-1/veto"],
      ["PUT", "/api/auth/request/request-1"],
      ["POST", "/api/auth/request/request-1/withdraw"],
      ["POST", "/api/auth/request/request-1/reject"],
      ["POST", "/api/auth/request/request-1/skip"],
      ["POST", "/api/auth/request/request-1/retry"],
      ["POST", "/api/auth/request/request-1/requeue"],
    ]) {
      const operation = operationForRequest(method, pathname, "preview");
      expect(operation?.effects).toEqual(method === "GET" ? ["ledger:read"] : ["ledger:write"]);
      expect(authorizeEffects(preview(), identity, operation)).toEqual({ allowed: true });
    }

    for (const [method, pathname, effect] of [
      ["POST", "/api/auth/check", "process:external"],
      ["POST", "/api/users/setup", "auth:credentials"],
      ["POST", "/api/auth/request/request-1/approve", "auth:protected"],
      ["POST", "/api/auth/request/request-1/output", "auth:protected"],
      ["POST", "/api/auth/request/request-1/result", "auth:protected"],
      ["POST", "/api/auth/request/request-1/candidate-snapshot-repair/inspect", "auth:protected"],
      ["GET", "/api/auth/clearances/signing", "auth:credentials"],
      ["POST", "/api/auth/clearances", "auth:protected"],
      ["GET", "/api/auth/hooks", "auth:protected"],
    ] as const) {
      expect(operationForRequest(method, pathname, "preview")?.effects).toEqual([effect]);
      expect(authorizeEffects(preview(), identity, operationForRequest(method, pathname, "preview")))
        .toMatchObject({ allowed: false });
    }

    const main = resolveInstanceInfo({ env: {} });
    const ledgerOnlyIdentity = { effect_ceiling: ["ledger:read", "ledger:write"] as const };
    for (const pathname of [
      "/api/auth/queue",
      "/api/auth/history",
      "/api/auth/request/request-1",
      "/api/auth/request/request-1/actions",
    ]) {
      const operation = operationForRequest("GET", pathname, "main");
      expect(operation?.effects).toContain("auth:protected");
      expect(authorizeEffects(main, ledgerOnlyIdentity, operation))
        .toMatchObject({ allowed: false, missing: ["auth:protected"] });
    }
    for (const [method, pathname] of [
      ["POST", "/api/auth/request"],
      ["PUT", "/api/auth/request/request-1"],
      ["POST", "/api/auth/request/request-1/reject"],
      ["POST", "/api/auth/request/request-1/withdraw"],
      ["POST", "/api/auth/request/request-1/requeue"],
      ["POST", "/api/auth/request/request-1/skip"],
      ["POST", "/api/auth/request/request-1/retry"],
      ["POST", "/api/auth/request/request-1/actions/action-1/veto"],
    ]) {
      const operation = operationForRequest(method, pathname, "main");
      expect(operation?.effects).toContain("auth:protected");
      expect(authorizeEffects(main, ledgerOnlyIdentity, operation))
        .toMatchObject({ allowed: false, missing: ["auth:protected"] });
    }
    for (const [method, pathname] of [
      ["POST", "/api/auth/request"],
      ["PUT", "/api/auth/request/request-1"],
      ["POST", "/api/auth/request/request-1/reject"],
      ["POST", "/api/auth/request/request-1/withdraw"],
      ["POST", "/api/auth/request/request-1/requeue"],
    ]) {
      expect(operationForRequest(method, pathname, "preview")?.effects).toEqual(["ledger:write"]);
    }
  });

  it("separates copied Space export rows from live export and drift operations", () => {
    const identity = { effect_ceiling: STANDARD_PREVIEW_EFFECTS };
    expect(operationForRequest("GET", "/api/spaces/space-1/exports", "preview")?.effects)
      .toEqual(["ledger:read"]);
    expect(authorizeEffects(preview(), identity,
      operationForRequest("GET", "/api/spaces/space-1/exports", "preview")))
      .toEqual({ allowed: true });
    expect(operationForRequest("POST", "/api/spaces/exports/settings", "preview")?.effects)
      .toEqual(["ledger:write"]);
    for (const pathname of [
      "/api/spaces/space-1/exports",
      "/api/spaces/space-1/exports/untracked",
    ]) {
      expect(authorizeEffects(preview(), identity,
        operationForRequest("POST", pathname, "preview"))).toMatchObject({ allowed: false });
    }
    for (const pathname of [
      "/api/spaces/space-1/exports/drift",
      "/api/spaces/space-1/exports/export-1/drift",
    ]) {
      expect(authorizeEffects(preview(), identity,
        operationForRequest("GET", pathname, "preview"))).toMatchObject({ allowed: false });
    }
  });

  it("keeps preview theme, navigation, and font edits separate from production in both directions", async () => {
    const instance = preview();
    const productionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-production-user-preferences-"));
    roots.add(productionRoot);
    const productionPreferences = new HostUserPreferencesStore(productionRoot);
    await productionPreferences.writeAppTheme("user-one", 0, "light");
    await productionPreferences.writeChatShownProjects("user-one", 1, [
      { projectId: "project-one", checkoutId: "checkout-main" },
    ]);
    await productionPreferences.writeSidebarOrder("user-one", 0, {
      pinnedConversationIds: ["conversation-production"],
      briefingTopLevelIds: null,
    });
    fs.cpSync(productionRoot, instance.user_preferences_root, { recursive: true });

    const previewPreferences = new HostUserPreferencesStore(instance.user_preferences_root);
    expect(await previewPreferences.readAppTheme("user-one")).toMatchObject({ value: "light", revision: 2 });
    expect(await previewPreferences.readChatShownProjects("user-one")).toMatchObject({
      value: [{ projectId: "project-one", checkoutId: "checkout-main" }], revision: 2,
    });
    await previewPreferences.writeAppTheme("user-one", 2, "dark");
    await previewPreferences.writeSidebarOrder("user-one", 1, {
      pinnedConversationIds: ["conversation-preview"],
      briefingTopLevelIds: null,
    });
    expect(await productionPreferences.readAppTheme("user-one")).toMatchObject({ value: "light", revision: 2 });
    expect(await productionPreferences.readSidebarOrder("user-one")).toMatchObject({
      value: { pinnedConversationIds: ["conversation-production"], briefingTopLevelIds: null }, revision: 1,
    });
    await productionPreferences.writeAppTheme("user-one", 2, "system");
    await productionPreferences.writeChatShownProjects("user-one", 3, []);
    expect(await previewPreferences.readAppTheme("user-one")).toMatchObject({ value: "dark", revision: 3 });
    expect(await previewPreferences.readChatShownProjects("user-one")).toMatchObject({
      value: [{ projectId: "project-one", checkoutId: "checkout-main" }], revision: 3,
    });

    const sourceDb = path.join(path.dirname(instance.source_db_path!), "settings-source.db");
    const previewDbPath = path.join(instance.preview_root!, "settings-copy.db");
    const sourceDbHandle = openDb(sourceDb);
    sourceDbHandle.prepare(
      "INSERT INTO users (id, slug, kind, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("user-one", "user-one", "human", "User One", Date.now(), Date.now());
    writeUserSetting(sourceDbHandle, "user-one", "ui_font_face", "space-grotesk");
    writeUserSetting(sourceDbHandle, "user-one", "app_rail_order", '{"version":1,"groups":{"primary":["chat"],"secondary":[]}}');
    sourceDbHandle.close();
    fs.copyFileSync(sourceDb, previewDbPath);
    const previewDb = openDb(previewDbPath);
    writeUserSetting(previewDb, "user-one", "ui_font_face", "system-ui");
    expect(readUserSetting(previewDb, "user-one", "ui_font_face").value).toBe("system-ui");
    expect(readUserSetting(previewDb, "user-one", "app_rail_order").value).toContain("chat");
    previewDb.close();
    const productionDb = openDb(sourceDb);
    expect(readUserSetting(productionDb, "user-one", "ui_font_face").value).toBe("space-grotesk");
    productionDb.close();
  });

  it("keeps a real copied-ledger edit inside preview custody", () => {
    const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-preview-ledger-"));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-production-ledger-"));
    roots.add(previewRoot);
    roots.add(sourceRoot);
    const source = path.join(sourceRoot, "production.db");
    const copy = path.join(previewRoot, "preview.db");
    const userPreferences = path.join(previewRoot, "settings", "users");
    fs.mkdirSync(userPreferences, { recursive: true });
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
        MANDIBLE_USER_PREFERENCES_DIR: userPreferences,
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
    expect(authorizeEffects(instance, { effect_ceiling: STANDARD_PREVIEW_EFFECTS }, operationForRequest("PUT", "/api/host-preferences/app-theme"))).toEqual({ allowed: true });
  });

  it("intersects request effects with both session and preview ceilings", () => {
    const instance = preview();
    const session = { effect_ceiling: ["ledger:read", "ledger:write", "files:preview", "auth:protected"] as const };
    expect(authorizeEffects(instance, session, operationForRequest("GET", "/api/issues"))).toEqual({ allowed: true });
    expect(authorizeEffects(instance, session, operationForRequest("POST", "/api/issues"))).toEqual({ allowed: true });
    const runOptionsRead = operationForRequest("GET", "/api/console/run-options");
    expect(runOptionsRead).toEqual({ id: "console.run_options.describe", effects: ["ledger:read"] });
    expect(authorizeEffects(instance, session, runOptionsRead)).toEqual({ allowed: true });
    expect(operationForRequest("POST", "/api/console/run-options")?.effects).toEqual(["process:external"]);
    const sessionOptionsRead = operationForRequest("GET", "/api/console/sessions/session-id/options");
    expect(sessionOptionsRead?.effects).toEqual(["process:external"]);
    expect(authorizeEffects(instance, session, sessionOptionsRead)).toMatchObject({ allowed: false });
    expect(authorizeEffects(instance, session, operationForRequest("GET", "/api/auth/requests"))).toMatchObject({ allowed: false });
    for (const action of ["inspect", "apply"]) {
      const operation = operationForRequest("POST", `/api/auth/request/abc/candidate-snapshot-repair/${action}`);
      expect(operation?.effects).toContain("auth:protected");
      expect(authorizeEffects(instance, session, operation)).toMatchObject({ allowed: false });
    }
    expect(authorizeEffects(instance, session, operationForRequest("POST", "/api/webhooks"))).toMatchObject({ allowed: false });
    expect(operationForRequest("POST", "/api/artifacts/versions")).toMatchObject({
      effects: ["ledger:write", "files:preview"],
    });
  });

  it("allows only unambiguous inline managed artifact bytes in preview", () => {
    const instance = preview();
    const identity = { effect_ceiling: STANDARD_PREVIEW_EFFECTS };
    const safeBodies = [
      { content: "inline bytes", media_type: "text/plain" },
      { content_base64: "aW5saW5lIGJ5dGVz", custody_mode: "managed" },
      { json: { value: 1 }, role: "evidence" },
    ];
    for (const pathname of ["/api/artifacts/ingest", "/api/artifacts/snapshot"]) {
      for (const body of safeBodies) {
        const operation = operationForRequest("POST", pathname, "preview", body);
        expect(operation).toEqual({ id: "artifacts.bytes", effects: ["ledger:write", "files:preview"] });
        expect(authorizeEffects(instance, identity, operation)).toEqual({ allowed: true });
        expect(operationForRequest("POST", pathname, "main", body)?.effects).toEqual(["files:production"]);
      }
    }

    for (const [pathname, body] of [
      ["/api/artifacts/ingest", { path: "/source/report.md" }],
      ["/api/artifacts/ingest", { content: "bytes", path: "/source/report.md" }],
      ["/api/artifacts/ingest", { content: "bytes", paths: ["/source/report.md"] }],
      ["/api/artifacts/ingest", { content: "bytes", commit: "a".repeat(40) }],
      ["/api/artifacts/ingest", { content: "bytes", content_path: "/source/report.md" }],
      ["/api/artifacts/ingest", { content: "bytes", custody_mode: "git" }],
      ["/api/artifacts/ingest", { content: "bytes", content_base64: "Ynl0ZXM=" }],
      ["/api/artifacts/snapshot", { path: "/source/report.md" }],
      ["/api/artifacts/snapshot", { content: "bytes", path: "/source/report.md" }],
      ["/api/artifacts/snapshot", { content: "bytes", content_path: "/source/report.md" }],
      ["/api/artifacts/snapshot", { content: "bytes", unclassified_mode: true }],
    ] as const) {
      const operation = operationForRequest("POST", pathname, "preview", body);
      expect(operation?.effects).toEqual(["files:production"]);
      expect(authorizeEffects(instance, identity, operation)).toMatchObject({ allowed: false });
      expect(operationForRequest("POST", pathname, "main", body)?.effects).toEqual(["files:production"]);
    }

    for (const pathname of ["/api/artifacts/drafts/publish", "/api/artifacts/drafts/rebase"]) {
      const operation = operationForRequest("POST", pathname, "preview", { ref: "artifact:test" });
      expect(operation?.effects).toEqual(["ledger:write", "files:preview"]);
      expect(authorizeEffects(instance, identity, operation)).toEqual({ allowed: true });
      expect(operationForRequest("POST", pathname, "main")?.effects).toEqual(["files:production"]);
    }
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
