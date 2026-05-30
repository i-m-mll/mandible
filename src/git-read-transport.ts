import { createHash } from "node:crypto";
import path from "node:path";
import type { Db } from "./db.js";

export const GIT_READ_TRANSPORT_DEFAULT_SETTING = "git.read_transport.default";

export const GIT_READ_TRANSPORT_POLICIES = [
  "repo-default",
  "https-reads",
  "disabled",
] as const;

export type GitReadTransportPolicy = (typeof GIT_READ_TRANSPORT_POLICIES)[number];

export interface GitReadTransportPlanInput {
  policy?: string | null;
  remoteName?: string;
  remoteUrl?: string | null;
  pushUrl?: string | null;
}

export interface GitReadTransportPlan {
  policy: GitReadTransportPolicy;
  readRemote: string;
  pushUrl: string | null;
  usesSyntheticReadUrl: boolean;
  networkReadsDisabled: boolean;
  gitConfigMutations: [];
}

export function gitReadTransportRepoSettingKey(repoRoot: string): string {
  const normalized = path.resolve(repoRoot);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `git.read_transport.repo.${digest}`;
}

export function parseGitReadTransportPolicy(
  value: string | null | undefined,
  fallback: GitReadTransportPolicy = "repo-default",
): GitReadTransportPolicy {
  const normalized = value?.trim();
  return isGitReadTransportPolicy(normalized) ? normalized : fallback;
}

export function readGitReadTransportPolicy(
  db: Db,
  repoRoot?: string | null,
  fallback: GitReadTransportPolicy = "repo-default",
): GitReadTransportPolicy {
  const keys = repoRoot
    ? [gitReadTransportRepoSettingKey(repoRoot), GIT_READ_TRANSPORT_DEFAULT_SETTING]
    : [GIT_READ_TRANSPORT_DEFAULT_SETTING];

  for (const key of keys) {
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key) as { value: string } | undefined;
      if (row) {
        return parseGitReadTransportPolicy(row.value, fallback);
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function toHttpsReadUrl(remoteUrl: string | null | undefined): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const scpMatch = trimmed.match(/^(?:[^@/:]+@)?([^:/]+):(.+)$/);
  if (scpMatch && !trimmed.includes("://")) {
    return `https://${scpMatch[1]}/${cleanRemotePath(scpMatch[2])}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "ssh:") {
      return null;
    }
    const remotePath = cleanRemotePath(parsed.pathname);
    if (!parsed.hostname || !remotePath) {
      return null;
    }
    return `https://${parsed.hostname}/${remotePath}`;
  } catch {
    return null;
  }
}

export function buildGitReadTransportPlan(
  input: GitReadTransportPlanInput,
): GitReadTransportPlan {
  const policy = parseGitReadTransportPolicy(input.policy);
  const remoteName = input.remoteName?.trim() || "origin";
  const pushUrl = input.pushUrl?.trim() || null;

  if (policy === "disabled") {
    return {
      policy,
      readRemote: remoteName,
      pushUrl,
      usesSyntheticReadUrl: false,
      networkReadsDisabled: true,
      gitConfigMutations: [],
    };
  }

  if (policy === "https-reads") {
    const httpsReadUrl = toHttpsReadUrl(input.remoteUrl);
    if (httpsReadUrl) {
      return {
        policy,
        readRemote: httpsReadUrl,
        pushUrl,
        usesSyntheticReadUrl: true,
        networkReadsDisabled: false,
        gitConfigMutations: [],
      };
    }
  }

  return {
    policy,
    readRemote: remoteName,
    pushUrl,
    usesSyntheticReadUrl: false,
    networkReadsDisabled: false,
    gitConfigMutations: [],
  };
}

export function buildGitFetchArgs(
  input: GitReadTransportPlanInput & { branch: string; remoteTrackingRef?: string },
): string[] | null {
  const plan = buildGitReadTransportPlan(input);
  if (plan.networkReadsDisabled) {
    return null;
  }
  if (!plan.usesSyntheticReadUrl) {
    return ["fetch", plan.readRemote, input.branch];
  }
  const refspec = `${input.branch}:${input.remoteTrackingRef ?? `refs/remotes/origin/${input.branch}`}`;
  return ["fetch", plan.readRemote, refspec];
}

function isGitReadTransportPolicy(
  value: string | null | undefined,
): value is GitReadTransportPolicy {
  return GIT_READ_TRANSPORT_POLICIES.includes(value as GitReadTransportPolicy);
}

function cleanRemotePath(rawPath: string): string {
  return rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
}
