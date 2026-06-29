import path from "node:path";
import type {
  InstanceInfo,
  InstanceMutationDecision,
  InstanceRole,
  OperationalMutationPolicy,
} from "./types.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function resolveInstanceInfo(options: {
  env?: NodeJS.ProcessEnv;
  dbPath?: string | null;
  dbPathSource?: string | null;
} = {}): InstanceInfo {
  const env = options.env ?? process.env;
  const role = normalizeRole(env.MANDIBLE_INSTANCE_ROLE);
  const operationalMutations = normalizeMutationPolicy(env.MANDIBLE_OPERATIONAL_MUTATIONS)
    ?? (role === "main" ? "allow" : "reject");
  const dbPath = options.dbPath ?? env.MANDIBLE_DB ?? null;
  const dbPathSource = options.dbPathSource
    ?? (options.dbPath ? "start_options" : env.MANDIBLE_DB ? "env" : "default");

  return {
    role,
    operational_mutations: operationalMutations,
    operational_mutations_overridden: env.MANDIBLE_OPERATIONAL_MUTATIONS !== undefined,
    db_path: dbPath ? path.resolve(dbPath) : null,
    db_path_source: dbPathSource,
  };
}

export function evaluateInstanceMutation(
  instance: InstanceInfo,
  method: string,
  pathname: string,
): InstanceMutationDecision {
  const category = operationalMutationCategory(method, pathname);
  if (!category || instance.operational_mutations === "allow") {
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

function operationalMutationCategory(method: string, pathname: string): string | null {
  const normalizedMethod = method.toUpperCase();
  if (!UNSAFE_METHODS.has(normalizedMethod)) {
    return null;
  }

  if (pathname === "/api/auth/check") {
    return null;
  }
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
    return "auth";
  }
  if (pathname === "/api/ledger" || pathname.startsWith("/api/ledger/")) {
    return "ledger";
  }
  if (pathname === "/api/issues" || pathname.startsWith("/api/issues/")) {
    return "issues";
  }
  if (pathname === "/api/work-units" || pathname.startsWith("/api/work-units/")) {
    return "work_units";
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
