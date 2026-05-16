import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Db } from "../db.js";
import { createLedgerId } from "./ids.js";
import type { LedgerNamespacePolicy, LedgerProject, LedgerProjectCheckout } from "./types.js";

export interface ResolveProjectInput {
  root: string;
  name?: string;
  workRepoId?: string | null;
  defaultBranch?: string;
  remoteUrl?: string | null;
  upstreamUrl?: string | null;
  namespacePolicy?: LedgerNamespacePolicy;
}

export interface ResolvedLedgerProject {
  project: LedgerProject;
  checkout: LedgerProjectCheckout;
}

export function normalizeRemoteIdentity(remoteUrl: string | null | undefined): string {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) {
    return "";
  }

  const scpMatch = trimmed.match(/^(?:([^@/:]+)@)?([^:/]+):(.+)$/);
  if (scpMatch && !trimmed.includes("://")) {
    return normalizeHostPath(scpMatch[2], scpMatch[3]);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      return `file:${path.resolve(parsed.pathname)}`;
    }
    return normalizeHostPath(parsed.hostname, parsed.pathname);
  } catch {
    return trimmed.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  }
}

export function readOriginRemote(root: string): string {
  const result = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

export function resolveProjectForCheckout(
  db: Db,
  input: ResolveProjectInput,
  now = Date.now(),
): ResolvedLedgerProject {
  db.pragma("foreign_keys = ON");

  const root = path.resolve(input.root);
  const remoteUrl = input.remoteUrl ?? readOriginRemote(root);
  const remoteIdentity = normalizeRemoteIdentity(remoteUrl);
  const upstreamIdentity = normalizeRemoteIdentity(input.upstreamUrl);
  const namespacePolicy: LedgerNamespacePolicy =
    input.namespacePolicy ?? (remoteIdentity ? "remote" : "local");
  const identity =
    namespacePolicy === "upstream" && upstreamIdentity
      ? upstreamIdentity
      : remoteIdentity || `local:${root}`;
  const displayName =
    displayNameFromIdentity(identity) || input.name?.trim() || path.basename(root) || "Local project";

  const transaction = db.transaction(() => {
    let project = db
      .prepare("SELECT * FROM ledger_projects WHERE remote_identity = ?")
      .get(identity) as LedgerProject | undefined;

    if (!project) {
      const id = createLedgerId("prj", { now });
      db.prepare(
        `INSERT INTO ledger_projects (
          id, display_name, remote_identity, upstream_identity,
          namespace_policy, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, displayName, identity, upstreamIdentity, namespacePolicy, now, now);
      project = db.prepare("SELECT * FROM ledger_projects WHERE id = ?").get(id) as LedgerProject;
    } else if (
      project.display_name !== displayName ||
      project.upstream_identity !== upstreamIdentity ||
      project.namespace_policy !== namespacePolicy
    ) {
      db.prepare(
        `UPDATE ledger_projects
         SET display_name = ?, upstream_identity = ?, namespace_policy = ?, updated_at = ?
         WHERE id = ?`,
      ).run(displayName, upstreamIdentity, namespacePolicy, now, project.id);
      project = db.prepare("SELECT * FROM ledger_projects WHERE id = ?").get(project.id) as LedgerProject;
    }

    let checkout = db
      .prepare("SELECT * FROM ledger_project_checkouts WHERE root = ?")
      .get(root) as LedgerProjectCheckout | undefined;

    if (!checkout) {
      const id = createLedgerId("chk", { now });
      db.prepare(
        `INSERT INTO ledger_project_checkouts (
          id, project_id, work_repo_id, root, name, default_branch,
          remote_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        project.id,
        input.workRepoId ?? null,
        root,
        displayName,
        input.defaultBranch ?? "",
        remoteUrl ?? "",
        now,
        now,
      );
      checkout = db
        .prepare("SELECT * FROM ledger_project_checkouts WHERE id = ?")
        .get(id) as LedgerProjectCheckout;
    } else {
      db.prepare(
        `UPDATE ledger_project_checkouts
         SET project_id = ?, work_repo_id = ?, name = ?, default_branch = ?,
             remote_url = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        project.id,
        input.workRepoId ?? checkout.work_repo_id,
        displayName,
        input.defaultBranch ?? checkout.default_branch,
        remoteUrl ?? checkout.remote_url,
        now,
        checkout.id,
      );
      checkout = db
        .prepare("SELECT * FROM ledger_project_checkouts WHERE id = ?")
        .get(checkout.id) as LedgerProjectCheckout;
    }

    return { project, checkout };
  });

  return transaction();
}

function normalizeHostPath(host: string, rawPath: string): string {
  const cleanedPath = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
  return `${host.toLowerCase()}/${cleanedPath}`;
}

function displayNameFromIdentity(identity: string): string {
  if (identity.startsWith("local:") || identity.startsWith("file:")) {
    return "";
  }
  const tail = identity.split("/").filter(Boolean).at(-1);
  return tail || "";
}
