import type { Db } from "../db.js";
import { ulid } from "./ids.js";
import {
  BINDING_TYPES,
  CREDENTIAL_TYPES,
  type AddBindingInput,
  type AddCredentialInput,
  type AttributionEvidence,
  type CreateUserInput,
  type DelegatedSigningLease,
  type SetupOperatorInput,
  type UpdateUserInput,
  type User,
  type UserBinding,
  type UserCredential,
  type UserKind,
  type UserStatus,
} from "./types.js";

/** Fixed sentinel id for the single canonical `system` user (see migration v107). */
export const SYSTEM_USER_ID = "00000000000000000000000000";
export const SYSTEM_USER_SLUG = "system";

/** Settings key recording which user is the local human operator. */
export const OPERATOR_SETTING_KEY = "user.operator_id";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type UserRegistryErrorCode =
  | "not_found"
  | "conflict"
  | "invalid"
  | "forbidden";

export class UserRegistryError extends Error {
  constructor(
    public readonly code: UserRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UserRegistryError";
  }
}

// --- row shapes ---

interface UserRow {
  id: string;
  slug: string;
  kind: UserKind;
  display_name: string;
  email: string | null;
  status: UserStatus;
  created_at: number;
  updated_at: number;
  metadata_json: string;
}

interface CredentialRow {
  id: string;
  user_id: string;
  type: string;
  fingerprint: string;
  public_material: string | null;
  label: string | null;
  status: "active" | "revoked";
  created_at: number;
  revoked_at: number | null;
  metadata_json: string;
}

interface BindingRow {
  id: string;
  user_id: string;
  binding_type: UserBinding["binding_type"];
  value: string;
  scope: string | null;
  status: UserBinding["status"];
  created_at: number;
  updated_at: number;
}

// --- mappers ---

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    display_name: row.display_name,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapCredential(row: CredentialRow): UserCredential {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    fingerprint: row.fingerprint,
    public_material: row.public_material,
    label: row.label,
    status: row.status,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapBinding(row: BindingRow): UserBinding {
  return {
    id: row.id,
    user_id: row.user_id,
    binding_type: row.binding_type,
    value: row.value,
    scope: row.scope,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --- validation helpers ---

function normalizeSlug(slug: string): string {
  const value = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(value)) {
    throw new UserRegistryError(
      "invalid",
      `Invalid slug '${slug}': use lowercase letters, digits, '.', '_', '-' and start alphanumeric.`,
    );
  }
  return value;
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string {
  if (metadata === undefined) return "{}";
  return JSON.stringify(metadata);
}

// --- credential material validation ---
//
// Credentials never hold private key material. Validation is defence-in-depth:
//   1. Size caps on every string field.
//   2. A generic denylist run over EVERY string input, including every string
//      value found recursively inside metadata — a private key smuggled through
//      `label` or `metadata` is rejected just like one in `public_material`.
//   3. A per-type allowlist that accepts only known-good public shapes for
//      `fingerprint`/`public_material`. Allowlist-first means novel encodings
//      (base64/DER private blobs, unknown formats) fail closed rather than
//      slipping past a denylist.
// The store is the airtight layer: HTTP/file-RPC callers reach it only through
// addCredential, so they cannot skip this.

const MAX_FINGERPRINT = 512;
const MAX_PUBLIC_MATERIAL = 4096;
const MAX_LABEL = 256;
const MAX_METADATA_BYTES = 4096;

// Reject any recognizable private-key document, wherever it appears.
const PRIVATE_MATERIAL_DENYLIST: readonly RegExp[] = [
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /PuTTY-User-Key-File/i,
  /Private-Lines:/i,
  /BEGIN PGP PRIVATE/i,
];

// Public-shape allowlists.
const SSH_SHA256_FINGERPRINT = /^SHA256:[A-Za-z0-9+/=]{40,50}$/;
const SSH_PUBLIC_LINE =
  /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\n]{0,256})?$/;
const AGE_RECIPIENT = /^age1[a-z0-9]{10,100}$/;
// api_token: an opaque hash/identifier, single line, no embedded material.
const API_TOKEN_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9+/=_.:-]{7,511}$/;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function assertNoDenylistedMaterial(value: string, field: string): void {
  for (const pattern of PRIVATE_MATERIAL_DENYLIST) {
    if (pattern.test(value)) {
      throw new UserRegistryError(
        "forbidden",
        `Refusing to store private key material in ${field}. Credentials hold public/fingerprint material only.`,
      );
    }
  }
}

/**
 * Validate a credential's material before it is persisted. Throws a typed
 * UserRegistryError on any cap violation, denylisted private material (in any
 * field including nested metadata), or a fingerprint/public_material that does
 * not match the allowlisted public shape for its type.
 */
function validateCredentialMaterial(input: AddCredentialInput): void {
  const fingerprint = input.fingerprint.trim();
  const publicMaterial = input.public_material?.trim() || null;
  const label = input.label ?? null;

  // 1. Size caps.
  if (fingerprint.length > MAX_FINGERPRINT) {
    throw new UserRegistryError("invalid", `fingerprint exceeds ${MAX_FINGERPRINT} characters.`);
  }
  if (publicMaterial && publicMaterial.length > MAX_PUBLIC_MATERIAL) {
    throw new UserRegistryError(
      "invalid",
      `public_material exceeds ${MAX_PUBLIC_MATERIAL} characters.`,
    );
  }
  if (label !== null && label.length > MAX_LABEL) {
    throw new UserRegistryError("invalid", `label exceeds ${MAX_LABEL} characters.`);
  }
  if (input.metadata !== undefined) {
    const bytes = Buffer.byteLength(serializeMetadata(input.metadata), "utf8");
    if (bytes > MAX_METADATA_BYTES) {
      throw new UserRegistryError("invalid", `metadata exceeds ${MAX_METADATA_BYTES} bytes.`);
    }
  }

  // 2. Generic denylist over every string input, including nested metadata.
  const denyTargets: Array<[string, string]> = [["fingerprint", fingerprint]];
  if (publicMaterial) denyTargets.push(["public_material", publicMaterial]);
  if (label !== null) denyTargets.push(["label", label]);
  if (input.metadata !== undefined) {
    const strings: string[] = [];
    collectStrings(input.metadata, strings);
    for (const value of strings) denyTargets.push(["metadata", value]);
  }
  for (const [field, value] of denyTargets) assertNoDenylistedMaterial(value, field);

  // 3. Per-type public-shape allowlist.
  switch (input.type) {
    case "ssh_key":
    case "delegated_ssh_key": {
      if (!SSH_SHA256_FINGERPRINT.test(fingerprint)) {
        throw new UserRegistryError(
          "invalid",
          `fingerprint for ${input.type} must be an ssh-keygen SHA256 fingerprint (SHA256:<base64>).`,
        );
      }
      if (publicMaterial && !SSH_PUBLIC_LINE.test(publicMaterial)) {
        throw new UserRegistryError(
          "invalid",
          `public_material for ${input.type} must be a single-line OpenSSH public key.`,
        );
      }
      break;
    }
    case "yubikey_recipient": {
      if (!AGE_RECIPIENT.test(fingerprint)) {
        throw new UserRegistryError(
          "invalid",
          "fingerprint for yubikey_recipient must be an age recipient (age1…).",
        );
      }
      if (publicMaterial && !AGE_RECIPIENT.test(publicMaterial)) {
        throw new UserRegistryError(
          "invalid",
          "public_material for yubikey_recipient must be an age recipient (age1…).",
        );
      }
      break;
    }
    case "api_token": {
      if (!API_TOKEN_FINGERPRINT.test(fingerprint)) {
        throw new UserRegistryError(
          "invalid",
          "fingerprint for api_token must be an opaque single-line hash/identifier.",
        );
      }
      if (publicMaterial) {
        throw new UserRegistryError(
          "invalid",
          "api_token credentials carry no public_material.",
        );
      }
      break;
    }
    default: {
      // Unknown types are already rejected by the vocabulary check in
      // addCredential; fail closed here as well.
      throw new UserRegistryError("invalid", `Unsupported credential type '${input.type}'.`);
    }
  }
}

// --- user queries ---

export function getUserById(db: Db, id: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function getUserBySlug(db: Db, slug: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE slug = ?").get(slug) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

/** Resolve a user by id first, then by slug. Returns null when neither matches. */
export function resolveUser(db: Db, ref: string): User | null {
  return getUserById(db, ref) ?? getUserBySlug(db, ref);
}

export function resolveUserOrThrow(db: Db, ref: string): User {
  const user = resolveUser(db, ref);
  if (!user) throw new UserRegistryError("not_found", `No user matches '${ref}'.`);
  return user;
}

export function getSystemUser(db: Db): User {
  const user = getUserById(db, SYSTEM_USER_ID);
  if (!user) {
    throw new UserRegistryError("not_found", "System user is missing; database seed did not run.");
  }
  return user;
}

export interface ListUsersFilter {
  kind?: UserKind;
  status?: UserStatus;
}

export function listUsers(db: Db, filter: ListUsersFilter = {}): User[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM users${where} ORDER BY created_at ASC, slug ASC`)
    .all(...params) as UserRow[];
  return rows.map(mapUser);
}

// --- user mutations ---

export function createUser(db: Db, input: CreateUserInput, now: number = Date.now()): User {
  const slug = normalizeSlug(input.slug);
  const display = input.display_name.trim();
  if (!display) throw new UserRegistryError("invalid", "display_name is required.");
  if (getUserBySlug(db, slug)) {
    throw new UserRegistryError("conflict", `A user with slug '${slug}' already exists.`);
  }
  const id = ulid(now);
  db.prepare(
    `INSERT INTO users (id, slug, kind, display_name, email, status, created_at, updated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    input.kind,
    display,
    input.email ?? null,
    input.status ?? "active",
    now,
    now,
    serializeMetadata(input.metadata),
  );
  return getUserById(db, id)!;
}

export function updateUser(
  db: Db,
  ref: string,
  patch: UpdateUserInput,
  now: number = Date.now(),
): User {
  const user = resolveUserOrThrow(db, ref);
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.display_name !== undefined) {
    const display = patch.display_name.trim();
    if (!display) throw new UserRegistryError("invalid", "display_name cannot be empty.");
    fields.push("display_name = ?");
    params.push(display);
  }
  if (patch.email !== undefined) {
    fields.push("email = ?");
    params.push(patch.email);
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    params.push(patch.status);
  }
  if (patch.metadata !== undefined) {
    fields.push("metadata_json = ?");
    params.push(serializeMetadata(patch.metadata));
  }
  if (fields.length === 0) return user;
  fields.push("updated_at = ?");
  params.push(now);
  params.push(user.id);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  return getUserById(db, user.id)!;
}

// --- credentials ---

export function listCredentials(
  db: Db,
  ref: string,
  opts: { includeRevoked?: boolean } = {},
): UserCredential[] {
  const user = resolveUserOrThrow(db, ref);
  const where = opts.includeRevoked ? "" : " AND status = 'active'";
  const rows = db
    .prepare(`SELECT * FROM user_credentials WHERE user_id = ?${where} ORDER BY created_at ASC`)
    .all(user.id) as CredentialRow[];
  return rows.map(mapCredential);
}

export function addCredential(
  db: Db,
  ref: string,
  input: AddCredentialInput,
  now: number = Date.now(),
): UserCredential {
  const user = resolveUserOrThrow(db, ref);
  if (!(CREDENTIAL_TYPES as readonly string[]).includes(input.type)) {
    throw new UserRegistryError(
      "invalid",
      `Unknown credential type '${input.type}'. Allowed: ${CREDENTIAL_TYPES.join(", ")}.`,
    );
  }
  const fingerprint = input.fingerprint.trim();
  if (!fingerprint) throw new UserRegistryError("invalid", "fingerprint is required.");
  validateCredentialMaterial({ ...input, fingerprint });
  const publicMaterial = input.public_material?.trim() || null;

  const id = ulid(now);
  try {
    db.prepare(
      `INSERT INTO user_credentials
         (id, user_id, type, fingerprint, public_material, label, status, created_at, revoked_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)`,
    ).run(
      id,
      user.id,
      input.type,
      fingerprint,
      publicMaterial,
      input.label ?? null,
      now,
      serializeMetadata(input.metadata),
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new UserRegistryError(
        "conflict",
        `An active credential already exists for fingerprint '${fingerprint}'. Revoke it before re-adding.`,
      );
    }
    throw error;
  }
  return mapCredential(
    db.prepare("SELECT * FROM user_credentials WHERE id = ?").get(id) as CredentialRow,
  );
}

export function revokeCredential(
  db: Db,
  credentialId: string,
  now: number = Date.now(),
): UserCredential {
  const row = db
    .prepare("SELECT * FROM user_credentials WHERE id = ?")
    .get(credentialId) as CredentialRow | undefined;
  if (!row) throw new UserRegistryError("not_found", `No credential '${credentialId}'.`);
  if (row.status === "revoked") return mapCredential(row);
  db.prepare("UPDATE user_credentials SET status = 'revoked', revoked_at = ? WHERE id = ?").run(
    now,
    credentialId,
  );
  return mapCredential(
    db.prepare("SELECT * FROM user_credentials WHERE id = ?").get(credentialId) as CredentialRow,
  );
}

// --- bindings ---

export function listBindings(db: Db, ref: string): UserBinding[] {
  const user = resolveUserOrThrow(db, ref);
  const rows = db
    .prepare("SELECT * FROM user_bindings WHERE user_id = ? ORDER BY created_at ASC")
    .all(user.id) as BindingRow[];
  return rows.map(mapBinding);
}

export function addBinding(
  db: Db,
  ref: string,
  input: AddBindingInput,
  now: number = Date.now(),
): UserBinding {
  const user = resolveUserOrThrow(db, ref);
  if (!(BINDING_TYPES as readonly string[]).includes(input.binding_type)) {
    throw new UserRegistryError(
      "invalid",
      `Unknown binding type '${input.binding_type}'. Allowed: ${BINDING_TYPES.join(", ")}.`,
    );
  }
  const value = input.value.trim();
  if (!value) throw new UserRegistryError("invalid", "binding value is required.");
  const id = ulid(now);
  db.prepare(
    `INSERT INTO user_bindings (id, user_id, binding_type, value, scope, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, user.id, input.binding_type, value, input.scope ?? null, input.status ?? "active", now, now);
  return mapBinding(
    db.prepare("SELECT * FROM user_bindings WHERE id = ?").get(id) as BindingRow,
  );
}

export function removeBinding(db: Db, bindingId: string): void {
  const result = db.prepare("DELETE FROM user_bindings WHERE id = ?").run(bindingId);
  if (result.changes === 0) {
    throw new UserRegistryError("not_found", `No binding '${bindingId}'.`);
  }
}

// --- operator setup ---

function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function setSetting(db: Db, key: string, value: string, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

export function getOperatorId(db: Db): string | null {
  return getSetting(db, OPERATOR_SETTING_KEY);
}

export function getOperator(db: Db): User | null {
  const id = getOperatorId(db);
  return id ? getUserById(db, id) : null;
}

function deriveOperatorSlug(input: SetupOperatorInput): string {
  if (input.slug) return input.slug;
  const email = input.email?.trim();
  if (email && email.includes("@")) {
    const local = email.slice(0, email.indexOf("@"));
    if (local) return local;
  }
  const display = input.display_name?.trim();
  if (display) {
    const derived = display.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (derived) return derived;
  }
  return "operator";
}

/**
 * Idempotently create or update the local human operator and record its user
 * id in the settings table. This is the ONLY path that creates the operator;
 * migrations never do. Repeated calls with the same inputs converge on one user
 * without creating duplicates. Defaults (display_name/email) typically come from
 * git config, supplied by the CLI.
 */
export function setupOperator(
  db: Db,
  input: SetupOperatorInput = {},
  now: number = Date.now(),
): User {
  const slug = normalizeSlug(deriveOperatorSlug(input));
  const existingId = getOperatorId(db);
  let user = existingId ? getUserById(db, existingId) : null;
  if (!user) user = getUserBySlug(db, slug);

  if (user) {
    if (user.kind !== "human") {
      throw new UserRegistryError(
        "conflict",
        `User '${user.slug}' is kind '${user.kind}', not 'human'; cannot use as operator.`,
      );
    }
    const patch: UpdateUserInput = {};
    if (input.display_name !== undefined && input.display_name.trim()) {
      patch.display_name = input.display_name;
    }
    if (input.email !== undefined) patch.email = input.email;
    if (input.metadata !== undefined) patch.metadata = input.metadata;
    if (Object.keys(patch).length > 0) user = updateUser(db, user.id, patch, now);
  } else {
    user = createUser(
      db,
      {
        slug,
        kind: "human",
        display_name: input.display_name?.trim() || slug,
        email: input.email ?? null,
        metadata: input.metadata,
      },
      now,
    );
  }
  setSetting(db, OPERATOR_SETTING_KEY, user.id, now);
  return user;
}

// --- read helpers for downstream waves (leases / evidence) ---

interface LeaseRow {
  id: string;
  credential_id: string;
  owner_user_id: string;
  minted_at: number;
  expires_at: number;
  mint_method: DelegatedSigningLease["mint_method"];
}

export function listLeases(db: Db, ownerRef?: string): DelegatedSigningLease[] {
  let rows: LeaseRow[];
  if (ownerRef) {
    const user = resolveUserOrThrow(db, ownerRef);
    rows = db
      .prepare("SELECT * FROM delegated_signing_leases WHERE owner_user_id = ? ORDER BY minted_at ASC")
      .all(user.id) as LeaseRow[];
  } else {
    rows = db
      .prepare("SELECT * FROM delegated_signing_leases ORDER BY minted_at ASC")
      .all() as LeaseRow[];
  }
  return rows.map((row) => ({ ...row }));
}

interface EvidenceRow {
  id: string;
  evidence_method: string;
  credential_id: string | null;
  lease_id: string | null;
  verified_at: number;
  details_json: string;
}

export function listEvidence(db: Db, credentialId?: string): AttributionEvidence[] {
  const where = credentialId ? " WHERE credential_id = ?" : "";
  const params = credentialId ? [credentialId] : [];
  const rows = db
    .prepare(`SELECT * FROM attribution_evidence${where} ORDER BY verified_at ASC`)
    .all(...params) as EvidenceRow[];
  return rows.map((row) => ({
    id: row.id,
    evidence_method: row.evidence_method,
    credential_id: row.credential_id,
    lease_id: row.lease_id,
    verified_at: row.verified_at,
    details: parseJsonObject(row.details_json),
  }));
}

// --- internals ---

function isUniqueConstraint(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}
