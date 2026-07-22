// API token minting and verification.
//
// Tokens are per-user bearer secrets. The raw token is shown to the caller
// exactly once at mint time and is NEVER stored. What is persisted is a salted
// (peppered) HMAC-SHA256 of the raw token, stored as the fingerprint of an
// `api_token` credential (wave-1 `user_credentials` table, validated in
// src/users/store.ts). Verification recomputes the HMAC over the presented
// token and looks the resulting fingerprint up directly (unique-indexed), so a
// database leak alone never yields a usable token and the lookup stays O(1).
//
// The pepper is a per-install secret held in the existing `settings` KV table
// (`client_auth.token_pepper`), generated lazily on first use. No schema change.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db.js";
import { addCredential, getUserById } from "../users/store.js";
import type { User, UserCredential } from "../users/types.js";
import { getSetting, setSetting } from "./settings-kv.js";

/** Human-recognizable prefix so a leaked token is identifiable as a Mandible PAT. */
export const API_TOKEN_PREFIX = "mandible_pat_";
const TOKEN_ENTROPY_BYTES = 32;
const PEPPER_SETTING_KEY = "client_auth.token_pepper";

function getOrCreatePepper(db: Db, now: number = Date.now()): string {
  const existing = getSetting(db, PEPPER_SETTING_KEY);
  if (existing) return existing;
  const pepper = randomBytes(32).toString("base64url");
  setSetting(db, PEPPER_SETTING_KEY, pepper, now);
  return pepper;
}

/**
 * Compute the stored fingerprint for a raw token: `sha256:<hex>` of the
 * peppered HMAC. This shape satisfies the api_token fingerprint allowlist in
 * the user store (opaque single-line identifier).
 */
export function fingerprintForToken(db: Db, rawToken: string): string {
  const pepper = getOrCreatePepper(db);
  const digest = createHmac("sha256", pepper).update(rawToken, "utf8").digest("hex");
  return `sha256:${digest}`;
}

/** Constant-time comparison of two `sha256:<hex>` fingerprints. */
export function fingerprintsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Generate a fresh opaque bearer token. High-entropy random; not stored. */
export function generateRawToken(): string {
  return API_TOKEN_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
}

/** Strip an optional `Bearer ` scheme prefix from an Authorization value. */
export function normalizeBearer(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (match ? match[1].trim() : trimmed) || null;
}

export interface MintedToken {
  credential: UserCredential;
  /** The raw bearer token. Returned once; never retrievable again. */
  token: string;
}

/**
 * Mint a new api_token credential for a user and return the one-time raw token.
 * Only the peppered hash is persisted (as the credential fingerprint).
 */
export function mintApiToken(
  db: Db,
  userRef: string,
  opts: { label?: string | null } = {},
  now: number = Date.now(),
): MintedToken {
  const token = generateRawToken();
  const fingerprint = fingerprintForToken(db, token);
  const credential = addCredential(
    db,
    userRef,
    { type: "api_token", fingerprint, label: opts.label ?? null },
    now,
  );
  return { credential, token };
}

export interface VerifiedToken {
  user: User;
  credentialId: string;
}

interface CredentialLookupRow {
  id: string;
  user_id: string;
  fingerprint: string;
}

/**
 * Resolve a raw bearer token to its owning user via the persisted api_token
 * credential. Returns null for absent/malformed tokens, unknown fingerprints,
 * revoked credentials (only `active` rows are considered), or a retired user.
 */
export function verifyApiToken(db: Db, rawToken: string | null | undefined): VerifiedToken | null {
  if (!rawToken || !rawToken.startsWith(API_TOKEN_PREFIX)) return null;
  const fingerprint = fingerprintForToken(db, rawToken);
  const row = db
    .prepare(
      `SELECT id, user_id, fingerprint FROM user_credentials
       WHERE type = 'api_token' AND status = 'active' AND fingerprint = ?`,
    )
    .get(fingerprint) as CredentialLookupRow | undefined;
  if (!row || !fingerprintsEqual(row.fingerprint, fingerprint)) return null;
  const user = getUserById(db, row.user_id);
  if (!user || user.status !== "active") return null;
  return { user, credentialId: row.id };
}
