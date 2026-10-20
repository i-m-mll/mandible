import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Db } from "../db.js";
import { notifyProtectionInputsChanged } from "../protection-inputs.js";
import { createLedgerId } from "./ids.js";
import { deriveProjectKeyBase, dedupeProjectKey, slugifyProjectKey } from "./project-key.js";
import type { LedgerNamespacePolicy, LedgerProject, LedgerProjectCheckout } from "./types.js";

// Issue: 3d85f43 — allocate a stable, collision-free project_key when a project
// row is first created by discovery. Returns null when the project_key column
// is absent (pre-v87 schema in synthetic test DBs), so the insert can omit it.
function allocateProjectKeyForInsert(
  db: Db,
  input: { remote_identity: string; display_name: string; root: string },
): string | null {
  const columns = db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "project_key")) return null;
  const taken = new Set<string>(
    (db.prepare("SELECT project_key FROM ledger_projects WHERE project_key != ''").all() as Array<{
      project_key: string;
    }>).map((row) => row.project_key),
  );
  const base = deriveProjectKeyBase({
    remote_identity: input.remote_identity,
    display_name: input.display_name,
    root: input.root,
  });
  return dedupeProjectKey(base || "project", taken);
}

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

/**
 * Collapse a WorkScanner path-derived id back to the canonical project key
 * when the checkout basename already names that project.
 *
 * WorkScanner historically disambiguated duplicate basenames by prefixing the
 * parent directory, which could leak a checkout-path spelling into durable
 * writer paths. The project registry already owns the stable identity; accept
 * the path-derived spelling only as input and never persist it again.
 */
export function canonicalizeCheckoutWorkRepoId(
  root: string,
  projectKey: string | null | undefined,
  workRepoId: string | null | undefined,
): string | null {
  const requested = workRepoId?.trim() || null;
  const canonical = projectKey?.trim() || "";
  if (!requested || !canonical) return requested;

  const resolvedRoot = path.resolve(root);
  const base = slugifyProjectKey(path.basename(resolvedRoot));
  if (base !== canonical) return requested;

  const parent = slugifyProjectKey(path.basename(path.dirname(resolvedRoot)));
  // Numbered organizational folders created the bad durable alias. Other
  // parent prefixes can be deliberate checkout disambiguators (for example a
  // development clone) and must remain distinct.
  if (!/^\d+(?:-|$)/.test(parent)) return requested;
  const pathDerived = parent ? `${parent}-${base}` : base;
  return requested === pathDerived ? canonical : requested;
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

interface CheckoutIdentity {
  root: string;
  remoteUrl: string | null;
  remoteIdentity: string;
  upstreamIdentity: string;
  namespacePolicy: LedgerNamespacePolicy;
  identity: string;
  displayName: string;
}

// Single source of truth for how a checkout root maps to a canonical project
// identity. Both the minting resolver (resolveProjectForCheckout) and the
// no-mint resolver (resolveProjectForCheckoutReadOnly) derive identity here so
// they can never disagree about which project a root belongs to.
function computeCheckoutIdentity(input: ResolveProjectInput): CheckoutIdentity {
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
  return { root, remoteUrl, remoteIdentity, upstreamIdentity, namespacePolicy, identity, displayName };
}

export type ResolveProjectReadOnlyResult =
  | {
      status: "resolved";
      project: LedgerProject;
      checkout: LedgerProjectCheckout;
      identity: string;
      root: string;
    }
  | {
      status: "needs_registration";
      identity: string;
      root: string;
      // Set when a canonical project already exists for this identity but the
      // root is not (yet) a registered checkout. The operator can attach it
      // explicitly via `mandible project add-checkout`; we never auto-attach
      // because creating a checkout row at an unregistered (e.g. sandbox-mount)
      // root is itself the registry pollution this resolver exists to prevent.
      matchedProjectId?: string;
    };

// Issue 70cf59d: NO-MINT resolution. Resolve a checkout root to an ALREADY
// REGISTERED project/checkout without ever inserting into ledger_projects or
// ledger_project_checkouts. Returns { status: "resolved" } only when the root is
// a registered checkout; otherwise { status: "needs_registration" }, optionally
// carrying the id of a project that matches the resolved remote identity so the
// caller can surface an explicit registration suggestion. This mirrors the
// issue-creation guard's philosophy (reject unknown targets with suggestions
// instead of minting) and was the resolver used by the compatibility sync
// discovery path, which must not auto-mint projects from unregistered roots.
export function resolveProjectForCheckoutReadOnly(
  db: Db,
  input: ResolveProjectInput,
): ResolveProjectReadOnlyResult {
  const { root, identity } = computeCheckoutIdentity(input);

  const checkout = db
    .prepare("SELECT * FROM ledger_project_checkouts WHERE root = ?")
    .get(root) as LedgerProjectCheckout | undefined;
  if (checkout) {
    const project = db
      .prepare("SELECT * FROM ledger_projects WHERE id = ?")
      .get(checkout.project_id) as LedgerProject | undefined;
    if (project) {
      return { status: "resolved", project, checkout, identity, root };
    }
  }

  const project = db
    .prepare("SELECT * FROM ledger_projects WHERE remote_identity = ?")
    .get(identity) as LedgerProject | undefined;

  return {
    status: "needs_registration",
    identity,
    root,
    matchedProjectId: project?.id,
  };
}

export function resolveProjectForCheckout(
  db: Db,
  input: ResolveProjectInput,
  now = Date.now(),
): ResolvedLedgerProject {
  db.pragma("foreign_keys = ON");

  const { root, remoteUrl, upstreamIdentity, namespacePolicy, identity, displayName } =
    computeCheckoutIdentity(input);

  const transaction = db.transaction(() => {
    let project = db
      .prepare("SELECT * FROM ledger_projects WHERE remote_identity = ?")
      .get(identity) as LedgerProject | undefined;

    if (!project) {
      const id = createLedgerId("prj", { now });
      const projectKey = allocateProjectKeyForInsert(db, {
        remote_identity: identity,
        display_name: displayName,
        root,
      });
      if (projectKey !== null) {
        db.prepare(
          `INSERT INTO ledger_projects (
            id, project_key, display_name, remote_identity, upstream_identity,
            namespace_policy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, projectKey, displayName, identity, upstreamIdentity, namespacePolicy, now, now);
      } else {
        db.prepare(
          `INSERT INTO ledger_projects (
            id, display_name, remote_identity, upstream_identity,
            namespace_policy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, displayName, identity, upstreamIdentity, namespacePolicy, now, now);
      }
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
    const workRepoId = canonicalizeCheckoutWorkRepoId(
      root,
      (project as LedgerProject & { project_key?: string }).project_key,
      input.workRepoId ?? checkout?.work_repo_id,
    );

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
        workRepoId,
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
      notifyProtectionInputsChanged("checkout:add");
    } else {
      const previousDefaultBranch = checkout.default_branch;
      db.prepare(
        `UPDATE ledger_project_checkouts
         SET project_id = ?, work_repo_id = ?, name = ?, default_branch = ?,
             remote_url = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        project.id,
        workRepoId,
        displayName,
        input.defaultBranch ?? checkout.default_branch,
        remoteUrl ?? checkout.remote_url,
        now,
        checkout.id,
      );
      checkout = db
        .prepare("SELECT * FROM ledger_project_checkouts WHERE id = ?")
        .get(checkout.id) as LedgerProjectCheckout;
      if (checkout.default_branch !== previousDefaultBranch) notifyProtectionInputsChanged("checkout:default_branch");
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
