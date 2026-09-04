import fs from "node:fs";
import path from "node:path";
import type {
  InstanceInfo,
  InstanceMutationDecision,
  InstanceRole,
  OperationalMutationPolicy,
} from "./types.js";

// Issue 97cf613 — this module is the single source of truth for operational
// mutation classification. Both gates (the per-request gate in
// `evaluateInstanceMutation` and the per-route gate behind
// `Router.listRoutePolicies` in server.ts) import these tables; they must never
// be copied. Keep this module dependency-light (node:fs + node:path + type-only imports)
// so server.ts can import it without creating a cycle.
export const UNSAFE_MUTATION_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

// Unsafe-method routes that are read-only in effect and therefore stay
// available on instances that reject operational mutations.
export const OPERATIONAL_MUTATION_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/auth/check",
  // The browser handshake rotates bounded, ephemeral client-auth state only;
  // it does not mutate the ledger or authorize a different identity. Preview
  // dashboards need it to exchange their one-time bootstrap proof before any
  // identity-scoped reads can succeed.
  "POST /api/client-auth/handshake",
  // Chat project visibility is host/user view intent stored outside both the
  // ledger and copied preview DB. Main and reject-mode previews deliberately
  // share this one revisioned authority.
  "PUT /api/host-preferences/chat-shown-projects",
  "POST /api/briefing-destination-routes/plan",
  "POST /api/timeline/project",
]);

export const OPERATIONAL_ROUTE_CATEGORIES: ReadonlyArray<{ prefix: string; category: string }> = [
  { prefix: "/api/admin", category: "system" },
  // Issue ce83a84 — starting an external agent session is an operational
  // mutation even though it writes little: a read-only instance must not be
  // able to launch a worker against a real working directory.
  { prefix: "/api/agent-dispatch", category: "agent_dispatch" },
  { prefix: "/api/artifacts", category: "artifacts" },
  { prefix: "/api/auth", category: "auth" },
  { prefix: "/api/backup", category: "backup" },
  { prefix: "/api/briefing-bundles", category: "briefing" },
  { prefix: "/api/briefing-destination-routes", category: "briefing" },
  { prefix: "/api/briefing-groups", category: "briefing" },
  { prefix: "/api/briefings", category: "briefing" },
  { prefix: "/api/console", category: "console" },
  { prefix: "/api/conversation-spawns", category: "conversations" },
  { prefix: "/api/conversations", category: "conversations" },
  { prefix: "/api/conversation-custody", category: "conversations" },
  { prefix: "/api/inbox", category: "inbox" },
  { prefix: "/api/issues", category: "issues" },
  { prefix: "/api/knowledge-backrefs", category: "artifacts" },
  { prefix: "/api/ledger", category: "ledger" },
  { prefix: "/api/projects", category: "projects" },
  { prefix: "/api/provider-manifests", category: "providers" },
  { prefix: "/api/providers", category: "providers" },
  { prefix: "/api/runtime", category: "runtime" },
  { prefix: "/api/settings", category: "settings" },
  { prefix: "/api/sessions", category: "sessions" },
  { prefix: "/api/spaces", category: "spaces" },
  { prefix: "/api/system", category: "system" },
  { prefix: "/api/tasks", category: "tasks" },
  { prefix: "/api/timeline", category: "timeline" },
  { prefix: "/api/webhooks", category: "webhooks" },
  { prefix: "/api/work-units", category: "work_units" },
  { prefix: "/api/work", category: "work" },
];

const ACTOR_SCOPED_BRIEFING_RESPONSE_ROUTE =
  /^\/api\/briefings\/[^/]+\/rounds\/[^/]+\/(?:answers|annotations|submit)$/;

export function resolveInstanceInfo(options: {
  env?: NodeJS.ProcessEnv;
  dbPath?: string | null;
  dbPathSource?: string | null;
  sourceDbPath?: string | null;
  sourceDbPathSource?: string | null;
} = {}): InstanceInfo {
  const env = options.env ?? process.env;
  const role = normalizeRole(env.MANDIBLE_INSTANCE_ROLE);
  const operationalMutations = normalizeMutationPolicy(env.MANDIBLE_OPERATIONAL_MUTATIONS)
    ?? (role === "main" ? "allow" : "reject");
  const dbPath = options.dbPath ?? env.MANDIBLE_DB ?? null;
  const dbPathSource = options.dbPathSource
    ?? env.MANDIBLE_INSTANCE_DB_PATH_SOURCE
    ?? (options.dbPath ? "start_options" : env.MANDIBLE_DB ? "env" : "default");
  const sourceDbPath = options.sourceDbPath ?? env.MANDIBLE_INSTANCE_SOURCE_DB ?? null;
  const sourceDbPathSource = options.sourceDbPathSource
    ?? (options.sourceDbPath ? "start_options" : env.MANDIBLE_INSTANCE_SOURCE_DB ? "env" : null);
  const resolvedDbPath = dbPath ? path.resolve(dbPath) : null;
  const resolvedSourceDbPath = sourceDbPath ? path.resolve(sourceDbPath) : null;
  const resolvedPreviewRoot = env.MANDIBLE_PREVIEW_ROOT
    ? path.resolve(env.MANDIBLE_PREVIEW_ROOT)
    : null;
  const isolatedDatabaseCopy = hasIsolatedDatabaseCopy(resolvedDbPath, resolvedSourceDbPath);
  const briefingResponseMutations = operationalMutations === "allow"
    || isolatedDatabaseCopy
    ? "allow"
    : "reject";
  const previewBrowserEnrollment = role === "preview"
    && operationalMutations === "reject"
    && isolatedDatabaseCopy
    && isPathWithinRoot(resolvedDbPath, resolvedPreviewRoot)
    ? "allow"
    : "reject";

  return {
    role,
    operational_mutations: operationalMutations,
    operational_mutations_overridden: env.MANDIBLE_OPERATIONAL_MUTATIONS !== undefined,
    briefing_response_mutations: briefingResponseMutations,
    preview_browser_enrollment: previewBrowserEnrollment,
    preview_root: resolvedPreviewRoot,
    db_path: resolvedDbPath,
    db_path_source: dbPathSource,
    source_db_path: resolvedSourceDbPath,
    source_db_path_source: sourceDbPathSource,
  };
}

function isPathWithinRoot(candidate: string | null, root: string | null): boolean {
  if (candidate === null || root === null) return false;
  try {
    const canonicalCandidate = fs.realpathSync.native(candidate);
    const canonicalRoot = fs.realpathSync.native(root);
    const relative = path.relative(canonicalRoot, canonicalCandidate);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export function evaluateInstanceMutation(
  instance: InstanceInfo,
  method: string,
  pathname: string,
): InstanceMutationDecision {
  const category = operationalMutationCategoryForPath(method, pathname);
  if (!category || instance.operational_mutations === "allow") {
    return { allowed: true };
  }
  if (
    instance.briefing_response_mutations === "allow"
    && isActorScopedBriefingResponseMutation(method, pathname)
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    status: 403,
    body: {
      error: "instance_mutation_forbidden",
      message: "This Mandible instance is not allowed to perform operational mutations.",
      category,
      instance_role: instance.role,
      operational_mutations: instance.operational_mutations,
    },
  };
}

export function allowsOperationalMutations(instance: InstanceInfo): boolean {
  return instance.operational_mutations === "allow";
}

export function isActorScopedBriefingResponseMutation(method: string, pathname: string): boolean {
  return method.toUpperCase() === "POST" && ACTOR_SCOPED_BRIEFING_RESPONSE_ROUTE.test(pathname);
}

function hasIsolatedDatabaseCopy(dbPath: string | null, sourceDbPath: string | null): boolean {
  if (dbPath === null || sourceDbPath === null) return false;
  try {
    const canonicalDbPath = fs.realpathSync.native(dbPath);
    const canonicalSourceDbPath = fs.realpathSync.native(sourceDbPath);
    if (canonicalDbPath === canonicalSourceDbPath) return false;

    const dbIdentity = fs.statSync(canonicalDbPath, { bigint: true });
    const sourceIdentity = fs.statSync(canonicalSourceDbPath, { bigint: true });
    if (!dbIdentity.isFile() || !sourceIdentity.isFile()) return false;
    return dbIdentity.dev !== sourceIdentity.dev || dbIdentity.ino !== sourceIdentity.ino;
  } catch {
    return false;
  }
}

/**
 * Classify a request path or a registered route path pattern into its
 * operational mutation category, or null when the route is not an operational
 * mutation. Prefix matching makes this work for both concrete request
 * pathnames (`/api/ledger/issues/abc123/comments`) and route patterns
 * (`/api/ledger/issues/:issueId/comments`).
 */
export function operationalMutationCategoryForPath(
  method: string,
  pathname: string,
): string | null {
  const normalizedMethod = method.toUpperCase();
  if (!UNSAFE_MUTATION_METHODS.has(normalizedMethod)) {
    return null;
  }

  if (OPERATIONAL_MUTATION_EXEMPT_ROUTES.has(`${normalizedMethod} ${pathname}`)) {
    return null;
  }

  for (const route of OPERATIONAL_ROUTE_CATEGORIES) {
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) {
      return route.category;
    }
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return "api";
  }

  return null;
}

function normalizeRole(value: string | undefined): InstanceRole {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "preview" || normalized === "dev" || normalized === "test") {
    return normalized;
  }
  return "main";
}

function normalizeMutationPolicy(value: string | undefined): OperationalMutationPolicy | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "allow"
    || normalized === "allowed"
    || normalized === "1"
    || normalized === "true"
  ) {
    return "allow";
  }
  if (
    normalized === "reject"
    || normalized === "deny"
    || normalized === "denied"
    || normalized === "0"
    || normalized === "false"
  ) {
    return "reject";
  }
  return null;
}
