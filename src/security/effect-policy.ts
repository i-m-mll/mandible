import fs from "node:fs";
import path from "node:path";
import type { InstanceInfo } from "../types.js";

export const EFFECTS = [
  "ledger:read",
  "ledger:write",
  "files:preview",
  "files:production",
  "auth:protected",
  "auth:credentials",
  "process:external",
  "provider:send",
  "network:publish",
  "delivery:background",
  "maintenance:shared",
] as const;

export type Effect = (typeof EFFECTS)[number];

export const PRODUCTION_EFFECTS: readonly Effect[] = EFFECTS;
export const STANDARD_PREVIEW_EFFECTS: readonly Effect[] = [
  "ledger:read",
  "ledger:write",
  "files:preview",
];

export type Operation = {
  id: string;
  effects: readonly Effect[];
};

const READ_OPERATION: Operation = { id: "ledger.read", effects: ["ledger:read"] };
const LOCAL_WRITE_OPERATION: Operation = { id: "ledger.write", effects: ["ledger:write"] };
const PREVIEW_FILE_WRITE_OPERATION: Operation = { id: "artifacts.bytes", effects: ["ledger:write", "files:preview"] };

const EXACT_OPERATIONS = new Map<string, Operation>([
  ["GET /api/health", { id: "health.read", effects: [] }],
  ["GET /api/instance", { id: "instance.read", effects: [] }],
  ["GET /api/client-auth/whoami", { id: "session.inspect", effects: [] }],
  ["GET /api/client-auth/preview-bootstrap", { id: "session.preview_bootstrap", effects: [] }],
  ["POST /api/users/setup", { id: "installation.setup", effects: [] }],
  ["POST /api/auth/check", READ_OPERATION],
  ["POST /api/timeline/project", READ_OPERATION],
  ["POST /api/events/subscribe", READ_OPERATION],
  ["POST /api/briefing-destination-routes/plan", READ_OPERATION],
  ["POST /api/client-auth/pairing/start", { id: "session.pairing.start", effects: [] }],
  ["POST /api/client-auth/pairing/complete", { id: "session.pairing.complete", effects: [] }],
  ["POST /api/client-auth/preview-transfer/prepare", { id: "session.preview_transfer.prepare", effects: [] }],
  ["GET /api/client-auth/preview-transfer/authorize", { id: "session.preview_transfer.authorize", effects: [] }],
  ["POST /api/client-auth/preview-transfer/complete", { id: "session.preview_transfer.complete", effects: [] }],
  ["POST /api/client-auth/legacy-conversion/prepare", { id: "session.legacy_conversion.prepare", effects: [] }],
  ["POST /api/client-auth/legacy-conversion/complete", { id: "session.legacy_conversion.complete", effects: [] }],
  ["GET /api/client-auth/legacy-conversion/state", { id: "session.legacy_conversion.state", effects: [] }],
  ["POST /api/client-auth/legacy-conversion/finalize", { id: "session.legacy_conversion.finalize", effects: [] }],
  ["POST /api/client-auth/renew", { id: "session.renew", effects: [] }],
  ["POST /api/client-auth/logout", { id: "session.logout", effects: [] }],
  ["POST /api/client-auth/logout-everywhere", { id: "session.logout_everywhere", effects: [] }],
  ["GET /api/client-auth/forward-auth", { id: "session.forward_auth", effects: [] }],
  ["PUT /api/host-preferences/chat-shown-projects", { id: "preferences.shared", effects: ["maintenance:shared"] }],
  ["PUT /api/host-preferences/app-theme", { id: "preferences.shared", effects: ["maintenance:shared"] }],
]);

const EXACT_WRITE_OPERATIONS = new Map<string, Operation>([
  ["POST /api/system/open-path", { id: "system.open_path", effects: ["process:external"] }],
  ["POST /api/work/push", { id: "work.push", effects: ["files:production", "network:publish"] }],
  ["POST /api/work/scan", { id: "work.scan", effects: ["files:production"] }],
  ["POST /api/artifacts/scan-repos", { id: "artifacts.scan_repos", effects: ["files:production"] }],
  ["POST /api/artifacts/ingest", { id: "artifacts.ingest", effects: ["files:production"] }],
  ["POST /api/artifacts/snapshot", { id: "artifacts.snapshot", effects: ["files:production"] }],
  ["POST /api/artifacts/drafts/publish", { id: "artifacts.publish", effects: ["files:production"] }],
  ["POST /api/artifacts/drafts/rebase", { id: "artifacts.rebase", effects: ["files:production"] }],
  ["POST /api/conversation-custody/import", { id: "conversation.import", effects: ["files:production"] }],
  ["POST /api/conversations/scan-credentials", { id: "conversation.scan_credentials", effects: ["files:production"] }],
  ["POST /api/conversations/export/transform", { id: "conversation.export_transform", effects: ["files:production"] }],
  ["POST /api/tasks/commands", { id: "tasks.command", effects: ["process:external"] }],
  ["POST /api/tasks/inventory", { id: "tasks.inventory", effects: ["process:external"] }],
  ["POST /api/hooks/ingest-nudge", { id: "hooks.ingest", effects: ["delivery:background"] }],
  ["POST /api/hooks/notification", { id: "hooks.notification", effects: ["delivery:background"] }],
  ["POST /api/hooks/statusline", { id: "hooks.statusline", effects: ["delivery:background"] }],
]);

const RESTRICTED_PREFIXES: ReadonlyArray<[string, Operation]> = [
  ["/api/auth", { id: "auth.protected", effects: ["auth:protected"] }],
  ["/api/users", { id: "auth.credentials", effects: ["auth:credentials"] }],
  ["/api/client-auth", { id: "auth.credentials", effects: ["auth:credentials"] }],
  ["/api/admin", { id: "admin", effects: ["auth:protected", "maintenance:shared"] }],
  ["/api/console", { id: "console.process", effects: ["process:external"] }],
  ["/api/agent-dispatch", { id: "agent.dispatch", effects: ["process:external"] }],
  ["/api/conversation-spawns", { id: "provider.send", effects: ["provider:send"] }],
  ["/api/reminders", { id: "delivery.background", effects: ["delivery:background"] }],
  ["/api/webhooks", { id: "network.publish", effects: ["network:publish"] }],
  ["/api/runtime", { id: "runtime.files", effects: ["files:production", "process:external"] }],
  ["/api/backup", { id: "backup.production", effects: ["files:production"] }],
  ["/api/settings/instructions", { id: "instructions.install", effects: ["files:production"] }],
  ["/api/work", { id: "work.files", effects: ["files:production"] }],
  ["/api/v1/trash", { id: "trash.files", effects: ["files:production"] }],
  ["/api/conversation-custody", { id: "conversation.custody", effects: ["files:production"] }],
  ["/api/tasks/commands", { id: "tasks.command", effects: ["process:external"] }],
];

const LOCAL_WRITE_PREFIXES = [
  "/api/artifacts",
  "/api/briefings",
  "/api/briefing-bundles",
  "/api/briefing-destination-routes",
  "/api/briefing-groups",
  "/api/inbox",
  "/api/issues",
  "/api/knowledge-backrefs",
  "/api/ledger",
  "/api/operational-incidents",
  "/api/provider-manifests",
  "/api/providers",
  "/api/spaces",
  "/api/work-units",
] as const;

export function operationForRequest(method: string, pathname: string): Operation | null {
  const normalizedMethod = method.toUpperCase();
  const exact = EXACT_OPERATIONS.get(`${normalizedMethod} ${pathname}`);
  if (exact) return exact;
  if (!pathname.startsWith("/api/")) return null;
  if (normalizedMethod === "POST"
      && /^\/api\/conversations\/[^/]+\/control\/(submit|stop)$/.test(pathname)) {
    return { id: "provider.send", effects: ["provider:send"] };
  }
  if (normalizedMethod === "POST"
      && (/^\/api\/artifacts\/[^/]+\/open-externally$/.test(pathname)
        || /^\/api\/conversations\/[^/]+\/open-external$/.test(pathname))) {
    return { id: "external.open", effects: ["process:external"] };
  }
  if (normalizedMethod === "POST" && /^\/api\/work\/repos\/[^/]+\/push$/.test(pathname)) {
    return { id: "work.push", effects: ["files:production", "network:publish"] };
  }
  if (normalizedMethod === "POST" && /^\/api\/conversations\/[^/]+\/(fork|export)$/.test(pathname)) {
    return pathname.endsWith("/fork")
      ? { id: "provider.send", effects: ["provider:send"] }
      : { id: "conversation.export", effects: ["files:production"] };
  }
  if (/^\/api\/conversations\/[^/]+\/custody(?:\/|$)/.test(pathname)) {
    return { id: "conversation.custody", effects: ["files:production"] };
  }
  if (normalizedMethod === "POST" && /^\/api\/issues\/[^/]+\/[^/]+\/spawn$/.test(pathname)) {
    return { id: "issue.spawn", effects: ["process:external"] };
  }
  if (pathname === "/api/spaces/exports/settings"
      || /^\/api\/spaces\/[^/]+\/exports(?:\/|$)/.test(pathname)) {
    return { id: "spaces.export", effects: ["files:production"] };
  }
  const explicitWrite = EXACT_WRITE_OPERATIONS.get(`${normalizedMethod} ${pathname}`);
  if (explicitWrite) return explicitWrite;
  for (const [prefix, operation] of RESTRICTED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return operation;
  }
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") return READ_OPERATION;
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(normalizedMethod)) return null;
  // Artifact mutations are not ledger-only: versions, bundles, and drafts can
  // materialize managed bytes in the configured CAS. Production sessions also
  // carry files:preview; previews may exercise these routes only because their
  // artifact root is separately proven to be private preview custody.
  if (pathname === "/api/artifacts" || pathname.startsWith("/api/artifacts/")) {
    return PREVIEW_FILE_WRITE_OPERATION;
  }
  for (const prefix of LOCAL_WRITE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return LOCAL_WRITE_OPERATION;
  }
  if (pathname === "/api/settings" || pathname.startsWith("/api/settings/")
      || pathname === "/api/user-settings" || pathname.startsWith("/api/user-settings/")
      || pathname === "/api/host-preferences" || pathname.startsWith("/api/host-preferences/")) {
    return { id: "preferences.shared", effects: ["maintenance:shared"] };
  }
  if (pathname === "/api/projects" || pathname.startsWith("/api/projects/")) {
    return { id: "projects.registry", effects: ["maintenance:shared"] };
  }
  if (pathname === "/api/sessions" || pathname.startsWith("/api/sessions/")) {
    return { id: "sessions.process", effects: ["process:external"] };
  }
  if (pathname === "/api/conversations" || pathname.startsWith("/api/conversations/")) {
    return LOCAL_WRITE_OPERATION;
  }
  return null;
}

export function authorizeEffects(
  instance: InstanceInfo,
  identity: { effect_ceiling: readonly Effect[] } | null,
  operation: Operation | null,
): { allowed: true } | { allowed: false; code: string; missing: Effect[] } {
  if (!operation) return { allowed: false, code: "unknown_operation", missing: [] };
  if (operation.effects.length === 0) return { allowed: true };
  if (!identity) return { allowed: false, code: "authentication_required", missing: [...operation.effects] };
  const sessionEffects = new Set(identity.effect_ceiling);
  const instanceEffects = new Set(instance.allowed_effects);
  const missing = operation.effects.filter(
    (effect) => !sessionEffects.has(effect) || !instanceEffects.has(effect),
  );
  return missing.length === 0
    ? { allowed: true }
    : { allowed: false, code: "effect_forbidden", missing };
}

export function effectsForInstance(role: InstanceInfo["role"]): readonly Effect[] {
  return role === "preview" ? STANDARD_PREVIEW_EFFECTS : PRODUCTION_EFFECTS;
}

export function validatePreviewWritableRoots(instance: InstanceInfo): void {
  if (instance.role !== "preview") return;
  if (!instance.preview_root || !instance.db_path || !instance.source_db_path) {
    throw new Error("Preview registration is missing its custody roots.");
  }
  const previewRoot = canonicalDirectory(instance.preview_root);
  const database = canonicalFile(instance.db_path);
  const source = canonicalFile(instance.source_db_path);
  if (sameFile(database, source) || !inside(previewRoot, database) || inside(previewRoot, source)) {
    throw new Error("Preview database is not an isolated file beneath its registered root.");
  }
  for (const root of instance.writable_roots) {
    const canonical = canonicalDirectory(root);
    if (canonical !== previewRoot && !inside(previewRoot, canonical)) {
      throw new Error(`Preview writable root escapes registered custody: ${root}`);
    }
  }
  const configuredArtifactRoot = instance.artifact_root;
  if (!configuredArtifactRoot) {
    throw new Error("Preview startup requires an explicit private artifact root.");
  }
  const artifactRoot = canonicalDirectory(configuredArtifactRoot);
  if (!inside(previewRoot, artifactRoot)) {
    throw new Error("Preview artifact root escapes registered custody.");
  }
  const sourceArtifactRoot = instance.source_artifact_root;
  if (sourceArtifactRoot) {
    const sourceRoot = canonicalDirectory(sourceArtifactRoot);
    if (sameFile(artifactRoot, sourceRoot) || inside(previewRoot, sourceRoot)) {
      throw new Error("Preview artifact root aliases production or source custody.");
    }
  }
}

function canonicalDirectory(value: string): string {
  const canonical = fs.realpathSync.native(value);
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`Expected a directory: ${value}`);
  return canonical;
}

function canonicalFile(value: string): string {
  const canonical = fs.realpathSync.native(value);
  if (!fs.statSync(canonical).isFile()) throw new Error(`Expected a file: ${value}`);
  return canonical;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameFile(left: string, right: string): boolean {
  const a = fs.statSync(left, { bigint: true });
  const b = fs.statSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}
