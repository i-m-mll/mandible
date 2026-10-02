import type { InstanceRole } from "../types.js";

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
  "preferences:instance",
] as const;

export type Effect = (typeof EFFECTS)[number];

export const PRODUCTION_EFFECTS: readonly Effect[] = EFFECTS;
export const STANDARD_PREVIEW_EFFECTS: readonly Effect[] = [
  "ledger:read",
  "ledger:write",
  "files:preview",
  "preferences:instance",
];

export type Operation = {
  id: string;
  effects: readonly Effect[];
};

const READ_OPERATION: Operation = { id: "ledger.read", effects: ["ledger:read"] };
const LOCAL_WRITE_OPERATION: Operation = { id: "ledger.write", effects: ["ledger:write"] };
const AUTH_PROTECTED_OPERATION: Operation = { id: "auth.protected", effects: ["auth:protected"] };
const PREVIEW_FILE_WRITE_OPERATION: Operation = { id: "artifacts.bytes", effects: ["ledger:write", "files:preview"] };

const INLINE_ARTIFACT_BYTE_FIELDS = new Set([
  "content", "content_base64", "json", "custody_mode", "role", "media_type",
  "filename", "logical_name", "metadata", "reference",
]);
const INLINE_SNAPSHOT_BYTE_FIELDS = new Set([...INLINE_ARTIFACT_BYTE_FIELDS, "ref", "artifact_ref"]);

/** Exact request modes whose bytes and resulting managed custody stay in the active instance. */
export function isInlineManagedArtifactByteRequest(pathname: string, body: unknown): boolean {
  if (pathname !== "/api/artifacts/ingest" && pathname !== "/api/artifacts/snapshot") return false;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const input = body as Record<string, unknown>;
  const allowedFields = pathname === "/api/artifacts/snapshot"
    ? INLINE_SNAPSHOT_BYTE_FIELDS
    : INLINE_ARTIFACT_BYTE_FIELDS;
  if (Object.keys(input).some((key) => !allowedFields.has(key))) return false;
  if (input.custody_mode !== undefined && input.custody_mode !== "managed") return false;
  const byteFields = ["content", "content_base64", "json"].filter((key) => Object.hasOwn(input, key));
  if (byteFields.length !== 1) return false;
  const byteField = byteFields[0];
  return byteField === "json" || typeof input[byteField] === "string";
}

const EXACT_OPERATIONS = new Map<string, Operation>([
  ["GET /api/health", { id: "health.read", effects: [] }],
  ["GET /api/instance", { id: "instance.read", effects: [] }],
  ["GET /api/client-auth/whoami", { id: "session.inspect", effects: [] }],
  ["GET /api/console/run-options", { id: "console.run_options.describe", effects: ["ledger:read"] }],
  ["POST /api/auth/check", { id: "auth.check", effects: ["process:external"] }],
  ["POST /api/timeline/project", READ_OPERATION],
  ["POST /api/events/subscribe", READ_OPERATION],
  ["POST /api/briefing-destination-routes/plan", READ_OPERATION],
  ["GET /api/client-auth/forward-auth", { id: "session.forward_auth", effects: [] }],
  ["PUT /api/host-preferences/chat-shown-projects", { id: "preferences.instance", effects: ["preferences:instance"] }],
  ["PUT /api/host-preferences/sidebar-order", { id: "preferences.instance", effects: ["preferences:instance"] }],
  ["PUT /api/host-preferences/app-theme", { id: "preferences.instance", effects: ["preferences:instance"] }],
]);

const EXACT_WRITE_OPERATIONS = new Map<string, Operation>([
  ["POST /api/system/open-path", { id: "system.open_path", effects: ["process:external"] }],
  ["POST /api/work/push", { id: "work.push", effects: ["ledger:write", "files:production", "network:publish", "process:external"] }],
  ["POST /api/work/scan", { id: "work.scan", effects: ["ledger:write", "process:external"] }],
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
  ["/api/auth", AUTH_PROTECTED_OPERATION],
  ["/api/users", { id: "auth.credentials", effects: ["auth:credentials"] }],
  ["/api/client-auth", { id: "auth.credentials", effects: ["auth:credentials"] }],
  ["/api/admin", { id: "admin", effects: ["auth:protected", "maintenance:shared"] }],
  ["/api/console", { id: "console.process", effects: ["process:external"] }],
  ["/api/agent-dispatch", { id: "agent.dispatch", effects: ["process:external"] }],
  ["/api/conversation-spawns", { id: "provider.send", effects: ["provider:send"] }],
  ["/api/reminders", { id: "delivery.background", effects: ["delivery:background"] }],
  ["/api/webhooks", { id: "network.publish", effects: ["network:publish"] }],
  ["/api/backup", { id: "backup.production", effects: ["files:production"] }],
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

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function operationForRequest(
  method: string,
  pathname: string,
  instanceRole: InstanceRole = "main",
  body?: unknown,
): Operation | null {
  const normalizedMethod = method.toUpperCase();
  if (instanceRole === "preview" && normalizedMethod === "POST" && (
    pathname === "/api/artifacts/drafts/publish"
    || pathname === "/api/artifacts/drafts/rebase"
    || isInlineManagedArtifactByteRequest(pathname, body)
  )) {
    return PREVIEW_FILE_WRITE_OPERATION;
  }
  if (normalizedMethod === "POST" && pathname === "/api/users/setup") {
    return instanceRole === "preview"
      ? { id: "user.setup.copy", effects: ["auth:credentials"] }
      : { id: "installation.setup", effects: [] };
  }
  if (pathname === "/api/users/operator/signing-key") {
    if (normalizedMethod === "GET") {
      return instanceRole === "preview" ? READ_OPERATION : { id: "auth.credentials", effects: ["auth:credentials"] };
    }
    if (normalizedMethod === "POST") {
      return instanceRole === "preview"
        ? { id: "user.signing_key.copy", effects: ["ledger:write"] }
        : { id: "auth.credentials", effects: ["auth:credentials"] };
    }
  }
  const exact = EXACT_OPERATIONS.get(`${normalizedMethod} ${pathname}`);
  if (exact) return exact;
  if (!pathname.startsWith("/api/")) return null;

  // Settings routes can save a copied database value without applying a
  // system-wide effect. Preview instruction settings return an explicit
  // saved-but-not-exported result; the handler does not run host commands.
  if (pathname === "/api/settings/instructions-delivery") {
    if (normalizedMethod === "GET") return READ_OPERATION;
    if (normalizedMethod === "PUT") {
      return instanceRole === "preview"
        ? { id: "settings.instructions.copy", effects: ["ledger:write"] }
        : { id: "instructions.install", effects: ["ledger:write", "files:production", "process:external"] };
    }
  }

  // Auth queue getters and review edits can trigger maintenance or candidate
  // cleanup on main. Preview disables that work in AuthQueue, so only its
  // explicit copied-ledger subset uses ledger effects.
  if (pathname === "/api/auth/clearances/signing") {
    return { id: "auth.credentials", effects: ["auth:credentials"] };
  }
  if (normalizedMethod === "GET" && (
    pathname === "/api/auth/queue"
    || pathname === "/api/auth/history"
    || /^\/api\/auth\/request\/[^/]+$/.test(pathname)
    || /^\/api\/auth\/request\/[^/]+\/actions$/.test(pathname)
    || pathname === "/api/auth/clearances"
    || (/^\/api\/auth\/clearances\/[^/]+$/.test(pathname)
      && pathname !== "/api/auth/clearances/signing")
  )) {
    return instanceRole === "preview" ? READ_OPERATION : AUTH_PROTECTED_OPERATION;
  }
  const previewAuthWrite = (
    (pathname === "/api/auth/request" && normalizedMethod === "POST")
    || (normalizedMethod === "POST" && /^\/api\/auth\/request\/[^/]+\/actions$/.test(pathname))
    || ((normalizedMethod === "PUT" || normalizedMethod === "DELETE")
      && /^\/api\/auth\/request\/[^/]+\/actions\/[^/]+$/.test(pathname))
    || (normalizedMethod === "POST"
      && /^\/api\/auth\/request\/[^/]+\/actions\/[^/]+\/veto$/.test(pathname))
    || (normalizedMethod === "PUT" && /^\/api\/auth\/request\/[^/]+$/.test(pathname))
    || (normalizedMethod === "POST"
      && /^\/api\/auth\/request\/[^/]+\/(?:withdraw|reject|skip|retry|requeue)$/.test(pathname))
  );
  if (previewAuthWrite) {
    return instanceRole === "preview" ? LOCAL_WRITE_OPERATION : AUTH_PROTECTED_OPERATION;
  }

  // Work projections backed by the copied work_repos/branches tables are
  // ordinary ledger reads. Audit, commit history, and compare routes spawn
  // Git to inspect live repositories, so their actual effect is process use.
  if ((normalizedMethod === "GET" || normalizedMethod === "HEAD") && (
    /^\/api\/work\/repos\/[^/]+\/audit$/.test(pathname)
    || /^\/api\/work\/repos\/[^/]+\/branches\/[^/]+\/commits$/.test(pathname)
    || /^\/api\/work\/repos\/[^/]+\/compare$/.test(pathname)
  )) {
    return pathname.endsWith("/audit")
      ? { id: "work.repository.audit", effects: ["ledger:write", "process:external"] }
      : { id: "work.repository.inspect", effects: ["process:external"] };
  }

  if (/^\/api\/work\/repos\/[^/]+\/push$/.test(pathname)
      && normalizedMethod === "POST") {
    return { id: "work.push", effects: ["ledger:write", "files:production", "network:publish", "process:external"] };
  }

  // Repository metadata edits stay in the instance database. Removing a repo
  // also edits the configured roots file, whose location is instance-owned:
  // production config for main and a private copy under preview custody.
  if (/^\/api\/work\/repos\/[^/]+$/.test(pathname) && normalizedMethod === "PUT") {
    return LOCAL_WRITE_OPERATION;
  }
  if (/^\/api\/work\/repos\/[^/]+$/.test(pathname) && normalizedMethod === "DELETE") {
    return instanceRole === "preview"
      ? { id: "work.repo.remove", effects: ["ledger:write", "files:preview"] }
      : { id: "work.repo.remove", effects: ["ledger:write", "files:production"] };
  }
  if (pathname === "/api/work/repos/add" && normalizedMethod === "POST") {
    return instanceRole === "preview"
      ? { id: "work.repo.add", effects: ["ledger:write", "files:preview", "process:external"] }
      : { id: "work.repo.add", effects: ["ledger:write", "files:production", "process:external"] };
  }

  if ((pathname === "/api/projects" || pathname.startsWith("/api/projects/"))
      && MUTATION_METHODS.has(normalizedMethod)) {
    return { id: "projects.registry.write", effects: ["ledger:write"] };
  }

  if (MUTATION_METHODS.has(normalizedMethod)
      && /^\/api\/settings\/(?:theme|prompt|multiplexer)$/.test(pathname)) {
    return instanceRole === "preview"
      ? { id: "settings.copy.write", effects: ["ledger:write"] }
      : { id: "settings.host_sync.write", effects: ["ledger:write", "files:production"] };
  }
  if ((pathname === "/api/settings" || pathname.startsWith("/api/settings/"))
      && MUTATION_METHODS.has(normalizedMethod)) {
    return { id: "settings.copy.write", effects: ["ledger:write"] };
  }

  // These reads touch only the current instance's copied ledger. Their
  // delivery, process, credential, and host-file counterparts stay protected.
  if ((normalizedMethod === "GET" || normalizedMethod === "HEAD") && (
    pathname === "/api/reminders"
    || /^\/api\/reminders\/[^/]+$/.test(pathname)
    || pathname === "/api/webhooks"
    || pathname === "/api/conversation-spawns"
    || /^\/api\/conversation-spawns\/[^/]+$/.test(pathname)
    || pathname === "/api/console/pinned"
  )) {
    return READ_OPERATION;
  }
  if (normalizedMethod === "PUT" && pathname === "/api/console/pinned") {
    return LOCAL_WRITE_OPERATION;
  }
  if (normalizedMethod === "POST" && /^\/api\/webhooks\/[^/]+\/dismiss$/.test(pathname)) {
    return LOCAL_WRITE_OPERATION;
  }

  if (normalizedMethod === "POST"
      && /^\/api\/conversations\/[^/]+\/control\/(submit|stop)$/.test(pathname)) {
    return { id: "provider.send", effects: ["provider:send"] };
  }
  if (normalizedMethod === "POST" && pathname === "/api/chat-attachments") {
    return { id: "chat-attachment.store", effects: ["ledger:write"] };
  }
  if (normalizedMethod === "GET" && /^\/api\/chat-attachments\/[^/]+\/content$/.test(pathname)) {
    return READ_OPERATION;
  }
  if (normalizedMethod === "PUT"
      && /^\/api\/user-settings\/(app_rail_order|ui_font_face|ui_font_size|detail_font_face|detail_font_size)$/.test(pathname)) {
    return { id: "preferences.instance", effects: ["preferences:instance"] };
  }
  if (normalizedMethod === "POST"
      && (/^\/api\/artifacts\/[^/]+\/open-externally$/.test(pathname)
        || /^\/api\/conversations\/[^/]+\/open-external$/.test(pathname))) {
    return { id: "external.open", effects: ["process:external"] };
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
  if (normalizedMethod === "GET" && /^\/api\/spaces\/[^/]+\/exports$/.test(pathname)) {
    return READ_OPERATION;
  }
  if (normalizedMethod === "GET"
      && /^\/api\/spaces\/[^/]+\/exports(?:\/[^/]+)?\/drift$/.test(pathname)) {
    return { id: "spaces.export.drift", effects: ["ledger:write", "files:production", "process:external"] };
  }
  if (normalizedMethod === "POST" && pathname === "/api/spaces/exports/settings") {
    return LOCAL_WRITE_OPERATION;
  }
  if (normalizedMethod === "POST" && /^\/api\/spaces\/[^/]+\/exports$/.test(pathname)) {
    return { id: "spaces.export.track", effects: ["ledger:write", "files:production", "process:external"] };
  }
  if (normalizedMethod === "POST" && /^\/api\/spaces\/[^/]+\/exports\/untracked$/.test(pathname)) {
    return { id: "spaces.export.copy", effects: ["files:production"] };
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
