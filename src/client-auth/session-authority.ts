import { createHash, createHmac, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SignJWT, importPKCS8, importSPKI, jwtVerify } from "jose";
import type { Effect } from "../security/effect-policy.js";

const COOKIE_NAME = "__Host-mandible-session";
const PAIRING_COOKIE_NAME = "__Host-mandible-pairing";
const TRANSFER_COOKIE_NAME = "__Host-mandible-transfer";
const DEFAULT_RENEWABLE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_ABSOLUTE_MS = 180 * 24 * 60 * 60 * 1_000;
const INTERNAL_CONTEXT_TTL_SECONDS = 5;
const MAX_ACTIVE_FAMILIES = 32;
const AUTHORITY_SCHEMA_VERSION = "2";

export { COOKIE_NAME, PAIRING_COOKIE_NAME, TRANSFER_COOKIE_NAME };

export type InstanceRegistration = {
  instance_id: string;
  installation_id: string;
  role: "main" | "preview";
  public_origin: string;
  backend_origin: string;
  backend_generation: string;
  effect_ceiling: readonly Effect[];
  writable_roots: readonly string[];
};

export type AuthEvidence = {
  method: string;
  credential_id: string | null;
  authenticated_at: number;
};

export type BrowserSession = {
  family_id: string;
  root_family_id: string;
  user_id: string;
  slug: string;
  audience: string;
  effect_ceiling: readonly Effect[];
  csrf_token: string;
  expires_at: number;
  absolute_expires_at: number;
  evidence: AuthEvidence;
};

export type IssuedBrowserSession = BrowserSession & { token: string };

export type BrowserSessionAuthentication =
  | { state: "active"; session: BrowserSession }
  | { state: "missing" | "wrong_audience" | "expired" | "revoked"; session: null };

export type BrowserSessionRevocation = {
  root_family_id: string | null;
  family_ids: string[];
  user_id: string;
};

export type PairingTransaction = {
  reference: string;
  secret: string;
  audience: string;
  return_path: string;
  expires_at: number;
};

export type PreviewTransfer = {
  reference: string;
  secret: string;
  target_audience: string;
  return_path: string;
  expires_at: number;
};

export type LegacyConversion = {
  reference: string;
  secret: string;
  target_audience: string;
  return_path: string;
  expires_at: number;
};

type SessionRow = {
  family_id: string;
  root_family_id: string;
  token_digest: string;
  csrf_digest: string;
  user_id: string;
  slug: string;
  audience: string;
  effect_ceiling_json: string;
  evidence_json: string;
  expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
  legacy_fingerprint: string | null;
};

export class LocalSessionAuthority {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly privateKeyPath: string;
  private readonly publicKeyPath: string;
  private readonly derivationKeyPath: string;
  private readonly derivationKey: string;

  constructor(
    directory: string,
    readonly installationId: string,
    options: { now?: () => number; initialize?: boolean } = {},
  ) {
    this.now = options.now ?? Date.now;
    if (!fs.existsSync(directory) && !options.initialize) {
      throw new Error(`Local session authority is not initialized: ${directory}`);
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const databasePath = path.join(directory, "sessions.db");
    if (!fs.existsSync(databasePath) && !options.initialize) {
      throw new Error(`Local session authority database is missing: ${databasePath}`);
    }
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.ensureSchema();
    this.privateKeyPath = path.join(directory, "context-signing-key.pem");
    this.publicKeyPath = path.join(directory, "context-verification-key.pem");
    this.derivationKeyPath = path.join(directory, "session-derivation-key");
    if (options.initialize) {
      this.ensureSigningKeys();
      this.ensureDerivationKey();
    }
    if (!fs.existsSync(this.publicKeyPath)) {
      throw new Error("Local session context verification key is missing.");
    }
    if (!fs.existsSync(this.derivationKeyPath)) {
      throw new Error("Local session derivation key is missing.");
    }
    this.derivationKey = fs.readFileSync(this.derivationKeyPath, "utf8").trim();
    if (!this.derivationKey) throw new Error("Local session derivation key is empty.");
  }

  close(): void {
    this.db.close();
  }

  verificationKeyPem(): string {
    return fs.readFileSync(this.publicKeyPath, "utf8");
  }

  registerInstance(registration: InstanceRegistration): void {
    validateRegistration(registration, this.installationId);
    const existing = this.db.prepare(
      "SELECT * FROM instance_registrations WHERE instance_id = ?",
    ).get(registration.instance_id) as Record<string, unknown> | undefined;
    if (existing) {
      const immutableMatches = existing.installation_id === registration.installation_id
        && existing.role === registration.role
        && existing.public_origin === registration.public_origin;
      if (!immutableMatches) {
        throw new Error(`Conflicting registration for instance ${registration.instance_id}.`);
      }
    }
    this.db.prepare(`
      INSERT INTO instance_registrations (
        instance_id, installation_id, role, public_origin, backend_origin,
        backend_generation, effect_ceiling_json, writable_roots_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        backend_origin = excluded.backend_origin,
        backend_generation = excluded.backend_generation,
        effect_ceiling_json = excluded.effect_ceiling_json,
        writable_roots_json = excluded.writable_roots_json,
        updated_at = excluded.updated_at
    `).run(
      registration.instance_id,
      registration.installation_id,
      registration.role,
      registration.public_origin,
      registration.backend_origin,
      registration.backend_generation,
      JSON.stringify(registration.effect_ceiling),
      JSON.stringify(registration.writable_roots),
      this.now(),
    );
  }

  instance(instanceId: string): InstanceRegistration | null {
    const row = this.db.prepare(
      "SELECT * FROM instance_registrations WHERE instance_id = ?",
    ).get(instanceId) as Record<string, unknown> | undefined;
    return row ? registrationFromRow(row) : null;
  }

  instances(): InstanceRegistration[] {
    return (this.db.prepare(
      "SELECT * FROM instance_registrations ORDER BY role, instance_id",
    ).all() as Record<string, unknown>[]).map(registrationFromRow);
  }

  beginPairing(audience: string, returnPath: string): PairingTransaction {
    const registration = this.requiredInstance(audience);
    const normalizedReturn = validateReturnPath(returnPath);
    const reference = randomBytes(6).toString("hex").toUpperCase();
    const secret = token(32);
    const expiresAt = this.now() + 10 * 60 * 1_000;
    this.db.prepare(`
      INSERT INTO pairing_transactions (
        reference, secret_digest, audience, return_path, expires_at, approved_user_id, consumed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run(reference, digest(secret), registration.instance_id, normalizedReturn, expiresAt);
    return { reference, secret, audience, return_path: normalizedReturn, expires_at: expiresAt };
  }

  approvePairing(reference: string, userId: string): void {
    const result = this.db.prepare(`
      UPDATE pairing_transactions
         SET approved_user_id = ?
       WHERE reference = ? AND approved_user_id IS NULL AND consumed_at IS NULL AND expires_at > ?
    `).run(userId, reference, this.now());
    if (result.changes !== 1) throw new Error("Pairing reference is invalid, expired, or already approved.");
  }

  completePairing(reference: string, secret: string, slugForUser: (userId: string) => string | null): IssuedBrowserSession | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM pairing_transactions WHERE reference = ?",
      ).get(reference) as Record<string, unknown> | undefined;
      if (!row || row.consumed_at !== null || Number(row.expires_at) <= this.now()) return null;
      if (!safeEqual(String(row.secret_digest), digest(secret))) return null;
      if (typeof row.approved_user_id !== "string" || !row.approved_user_id) return null;
      const slug = slugForUser(row.approved_user_id);
      if (!slug) return null;
      const issued = this.issueSession(row.approved_user_id, slug, String(row.audience), {
        method: "pairing",
        credential_id: null,
        authenticated_at: this.now(),
      });
      this.db.prepare("UPDATE pairing_transactions SET consumed_at = ? WHERE reference = ?")
        .run(this.now(), reference);
      return issued;
    })();
  }

  issueSession(
    userId: string,
    slug: string,
    audience: string,
    evidence: AuthEvidence,
    options: {
      rootFamilyId?: string;
      rawToken?: string;
      familyId?: string;
      absoluteExpiresAt?: number;
      legacyFingerprint?: string;
    } = {},
  ): IssuedBrowserSession {
    const registration = this.requiredInstance(audience);
    if (!options.rootFamilyId) {
      const active = this.db.prepare(
        "SELECT COUNT(DISTINCT root_family_id) AS count FROM browser_sessions WHERE revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?",
      ).get(this.now(), this.now()) as { count: number };
      if (active.count >= MAX_ACTIVE_FAMILIES) {
        throw new Error("Browser session capacity is full; revoke an existing environment explicitly.");
      }
    }
    const raw = options.rawToken ?? token(32);
    const csrf = csrfForToken(raw);
    const familyId = options.familyId ?? `family_${randomBytes(16).toString("base64url")}`;
    const rootFamilyId = options.rootFamilyId ?? familyId;
    const expiresAt = this.now() + DEFAULT_RENEWABLE_MS;
    const absoluteExpiresAt = Math.min(
      options.absoluteExpiresAt ?? this.now() + DEFAULT_ABSOLUTE_MS,
      this.now() + DEFAULT_ABSOLUTE_MS,
    );
    this.db.prepare(`
      INSERT INTO browser_sessions (
        family_id, root_family_id, token_digest, csrf_digest, user_id, slug, audience,
        effect_ceiling_json, evidence_json, created_at, last_activity_at,
        expires_at, absolute_expires_at, revoked_at, legacy_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      familyId, rootFamilyId, digest(raw), digest(csrf), userId, slug, audience,
      JSON.stringify(registration.effect_ceiling), JSON.stringify(evidence),
      this.now(), this.now(), expiresAt, absoluteExpiresAt,
      options.legacyFingerprint ?? null,
    );
    return {
      token: raw,
      family_id: familyId,
      root_family_id: rootFamilyId,
      user_id: userId,
      slug,
      audience,
      effect_ceiling: registration.effect_ceiling,
      csrf_token: csrf,
      expires_at: expiresAt,
      absolute_expires_at: absoluteExpiresAt,
      evidence,
    };
  }

  authenticate(raw: string, audience: string): BrowserSession | null {
    const result = this.classify(raw, audience);
    return result.state === "active" ? result.session : null;
  }

  classify(raw: string, audience: string): BrowserSessionAuthentication {
    const row = this.db.prepare(
      "SELECT * FROM browser_sessions WHERE token_digest = ?",
    ).get(digest(raw)) as SessionRow | undefined;
    if (!row) return { state: "missing", session: null };
    if (row.revoked_at !== null) return { state: "revoked", session: null };
    if (row.audience !== audience) return { state: "wrong_audience", session: null };
    const now = this.now();
    if (row.expires_at <= now || row.absolute_expires_at <= now) {
      return { state: "expired", session: null };
    }
    const renewedExpires = Math.min(row.absolute_expires_at, now + DEFAULT_RENEWABLE_MS);
    this.db.prepare(`
      UPDATE browser_sessions
         SET last_activity_at = ?, expires_at = max(expires_at, ?)
       WHERE family_id = ? AND revoked_at IS NULL
    `).run(now, renewedExpires, row.family_id);
    return {
      state: "active",
      session: sessionFromRow({ ...row, expires_at: Math.max(row.expires_at, renewedExpires) }, raw),
    };
  }

  validateCsrf(session: BrowserSession, csrf: string | null | undefined): boolean {
    if (!csrf) return false;
    const row = this.db.prepare(
      "SELECT csrf_digest, revoked_at FROM browser_sessions WHERE family_id = ?",
    ).get(session.family_id) as { csrf_digest: string; revoked_at: number | null } | undefined;
    return Boolean(row && row.revoked_at === null && safeEqual(row.csrf_digest, digest(csrf)));
  }

  revokeFamily(familyId: string): BrowserSessionRevocation | null {
    const row = this.db.prepare(
      "SELECT root_family_id, user_id FROM browser_sessions WHERE family_id = ?",
    ).get(familyId) as { root_family_id: string; user_id: string } | undefined;
    if (!row) return null;
    const familyIds = (this.db.prepare(
      "SELECT family_id FROM browser_sessions WHERE root_family_id = ? AND revoked_at IS NULL ORDER BY family_id",
    ).all(row.root_family_id) as Array<{ family_id: string }>).map((entry) => entry.family_id);
    if (familyIds.length === 0) return null;
    this.db.prepare(
      "UPDATE browser_sessions SET revoked_at = ? WHERE root_family_id = ? AND revoked_at IS NULL",
    ).run(this.now(), row.root_family_id);
    return { root_family_id: row.root_family_id, family_ids: familyIds, user_id: row.user_id };
  }

  revokeUser(userId: string): BrowserSessionRevocation | null {
    const rows = this.db.prepare(
      "SELECT family_id FROM browser_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY family_id",
    ).all(userId) as Array<{ family_id: string }>;
    if (rows.length === 0) return null;
    this.db.prepare(
      "UPDATE browser_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    ).run(this.now(), userId);
    return { root_family_id: null, family_ids: rows.map((row) => row.family_id), user_id: userId };
  }

  beginPreviewTransfer(targetAudience: string, returnPath: string): PreviewTransfer {
    const target = this.requiredInstance(targetAudience);
    if (target.role !== "preview") throw new Error("Preview transfer target must be a registered preview.");
    const reference = `transfer_${token(12)}`;
    const secret = token(32);
    const expiresAt = this.now() + 5 * 60 * 1_000;
    this.db.prepare(`
      INSERT INTO preview_transfers (
        reference, secret_digest, target_audience, return_path, expires_at,
        authorized_root_family_id, authorized_user_id, authorized_at,
        issued_family_id, consumed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
    `).run(reference, digest(secret), target.instance_id, validateReturnPath(returnPath), expiresAt);
    return {
      reference,
      secret,
      target_audience: target.instance_id,
      return_path: validateReturnPath(returnPath),
      expires_at: expiresAt,
    };
  }

  authorizePreviewTransfer(reference: string, session: BrowserSession): InstanceRegistration {
    const source = this.requiredInstance(session.audience);
    if (source.role !== "main" || session.family_id !== session.root_family_id) {
      throw new Error("Preview transfer authorization requires a production root session.");
    }
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM preview_transfers WHERE reference = ?")
        .get(reference) as Record<string, unknown> | undefined;
      if (!row || Number(row.expires_at) <= this.now() || row.consumed_at !== null) {
        throw new Error("Preview transfer is invalid, expired, or already consumed.");
      }
      if (row.authorized_root_family_id !== null
          && row.authorized_root_family_id !== session.root_family_id) {
        throw new Error("Preview transfer was authorized by another browser family.");
      }
      this.db.prepare(`
        UPDATE preview_transfers
           SET authorized_root_family_id = ?, authorized_user_id = ?, authorized_at = ?
         WHERE reference = ?
      `).run(session.root_family_id, session.user_id, this.now(), reference);
      return this.requiredInstance(String(row.target_audience));
    })();
  }

  completePreviewTransfer(reference: string, secret: string): IssuedBrowserSession | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM preview_transfers WHERE reference = ?")
        .get(reference) as Record<string, unknown> | undefined;
      if (!row || Number(row.expires_at) <= this.now()
          || !safeEqual(String(row.secret_digest), digest(secret))
          || typeof row.authorized_root_family_id !== "string"
          || typeof row.authorized_user_id !== "string") return null;
      const root = this.db.prepare(`
        SELECT * FROM browser_sessions
         WHERE family_id = ? AND root_family_id = family_id AND revoked_at IS NULL
           AND expires_at > ? AND absolute_expires_at > ?
      `).get(row.authorized_root_family_id, this.now(), this.now()) as SessionRow | undefined;
      if (!root || root.user_id !== row.authorized_user_id) return null;
      const raw = this.derivedToken("preview-session", secret);
      const existingFamily = typeof row.issued_family_id === "string" ? row.issued_family_id : null;
      if (existingFamily) {
        const existing = this.db.prepare("SELECT * FROM browser_sessions WHERE family_id = ?")
          .get(existingFamily) as SessionRow | undefined;
        return existing && existing.revoked_at === null
          ? { ...sessionFromRow(existing, raw), token: raw }
          : null;
      }
      const familyId = `family_${this.derivedId("preview-family", reference)}`;
      const issued = this.issueSession(
        root.user_id,
        root.slug,
        String(row.target_audience),
        JSON.parse(root.evidence_json) as AuthEvidence,
        {
          rootFamilyId: root.root_family_id,
          rawToken: raw,
          familyId,
          absoluteExpiresAt: root.absolute_expires_at,
        },
      );
      this.db.prepare(`
        UPDATE preview_transfers SET issued_family_id = ?, consumed_at = ? WHERE reference = ?
      `).run(familyId, this.now(), reference);
      return issued;
    })();
  }

  previewTransferReturnPath(reference: string): string | null {
    const row = this.db.prepare("SELECT return_path FROM preview_transfers WHERE reference = ?")
      .get(reference) as { return_path: string } | undefined;
    return row?.return_path ?? null;
  }

  beginLegacyConversion(input: {
    raw_legacy_token: string;
    legacy_fingerprint: string;
    user_id: string;
    slug: string;
    target_audience: string;
    return_path: string;
    browser_state: Record<string, string>;
    authenticated_at: number;
  }): LegacyConversion {
    const target = this.requiredInstance(input.target_audience);
    if (target.role !== "main" && target.role !== "preview") {
      throw new Error("Legacy conversion target must be a registered local instance.");
    }
    const reference = `migration_${this.derivedId("legacy-reference", input.legacy_fingerprint)}`;
    const secret = this.derivedToken("legacy-transfer", input.raw_legacy_token);
    const returnPath = validateReturnPath(input.return_path);
    const expiresAt = this.now() + 30 * 60 * 1_000;
    const stateJson = JSON.stringify(input.browser_state);
    if (Buffer.byteLength(stateJson) > 256 * 1_024) throw new Error("Legacy browser state is too large.");
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM legacy_conversions WHERE legacy_fingerprint = ?")
        .get(input.legacy_fingerprint) as Record<string, unknown> | undefined;
      if (existing?.retired_at !== null && existing?.retired_at !== undefined) {
        throw new Error("Legacy browser session was already converted and cannot be resurrected.");
      }
      if (existing) {
        if (existing.user_id !== input.user_id || existing.target_audience !== target.instance_id
            || existing.secret_digest !== digest(secret)) {
          throw new Error("Legacy conversion state conflicts with the recorded transaction.");
        }
        this.db.prepare(`
          UPDATE legacy_conversions
             SET expires_at = max(expires_at, ?)
           WHERE legacy_fingerprint = ? AND retired_at IS NULL
        `).run(expiresAt, input.legacy_fingerprint);
        return;
      }
      this.db.prepare(`
        INSERT INTO legacy_conversions (
          reference, secret_digest, legacy_fingerprint, user_id, slug,
          target_audience, return_path, browser_state_json, authenticated_at,
          created_at, expires_at, issued_family_id, verified_at, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(
        reference,
        digest(secret),
        input.legacy_fingerprint,
        input.user_id,
        input.slug,
        target.instance_id,
        returnPath,
        stateJson,
        input.authenticated_at,
        this.now(),
        expiresAt,
      );
    })();
    return { reference, secret, target_audience: target.instance_id, return_path: returnPath, expires_at: expiresAt };
  }

  completeLegacyConversion(reference: string, secret: string): IssuedBrowserSession | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM legacy_conversions WHERE reference = ?")
        .get(reference) as Record<string, unknown> | undefined;
      if (!row || row.retired_at !== null || Number(row.expires_at) <= this.now()
          || !safeEqual(String(row.secret_digest), digest(secret))) return null;
      const raw = this.derivedToken("legacy-session", secret);
      const familyId = typeof row.issued_family_id === "string"
        ? row.issued_family_id
        : `family_${this.derivedId("legacy-family", reference)}`;
      const existing = this.db.prepare("SELECT * FROM browser_sessions WHERE family_id = ?")
        .get(familyId) as SessionRow | undefined;
      if (existing) return existing.revoked_at === null
        ? { ...sessionFromRow(existing, raw), token: raw }
        : null;
      const absoluteExpiresAt = Number(row.authenticated_at) + DEFAULT_ABSOLUTE_MS;
      if (absoluteExpiresAt <= this.now()) return null;
      const issued = this.issueSession(
        String(row.user_id),
        String(row.slug),
        String(row.target_audience),
        {
          method: "legacy_conversion",
          credential_id: null,
          authenticated_at: Number(row.authenticated_at),
        },
        {
          rawToken: raw,
          familyId,
          legacyFingerprint: String(row.legacy_fingerprint),
          absoluteExpiresAt,
        },
      );
      this.db.prepare("UPDATE legacy_conversions SET issued_family_id = ? WHERE reference = ?")
        .run(familyId, reference);
      return issued;
    })();
  }

  legacyConversionReturnPath(reference: string): string | null {
    const row = this.db.prepare(
      "SELECT return_path FROM legacy_conversions WHERE reference = ? OR issued_family_id = ?",
    ).get(reference, reference) as { return_path: string } | undefined;
    return row?.return_path ?? null;
  }

  legacyConversionDetails(session: BrowserSession): {
    browser_state: Record<string, string>;
    return_path: string;
    finalized: boolean;
  } | null {
    const row = this.db.prepare(`
      SELECT browser_state_json, return_path, retired_at FROM legacy_conversions
       WHERE issued_family_id = ?
    `).get(session.family_id) as {
      browser_state_json: string;
      return_path: string;
      retired_at: number | null;
    } | undefined;
    return row ? {
      browser_state: JSON.parse(row.browser_state_json) as Record<string, string>,
      return_path: row.return_path,
      finalized: row.retired_at !== null,
    } : null;
  }

  finalizeLegacyConversion(session: BrowserSession): string | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT legacy_fingerprint FROM legacy_conversions
         WHERE issued_family_id = ? AND verified_at IS NULL AND retired_at IS NULL
      `).get(session.family_id) as { legacy_fingerprint: string } | undefined;
      if (!row) return null;
      const verified = this.classifyByFamily(session.family_id);
      if (!verified) throw new Error("The replacement browser session is not active.");
      this.db.prepare(`
        UPDATE legacy_conversions SET verified_at = ?, retired_at = ?
         WHERE issued_family_id = ? AND verified_at IS NULL AND retired_at IS NULL
      `).run(this.now(), this.now(), session.family_id);
      return row.legacy_fingerprint;
    })();
  }

  retiredLegacyFingerprints(): string[] {
    return (this.db.prepare(
      "SELECT legacy_fingerprint FROM legacy_conversions WHERE retired_at IS NOT NULL ORDER BY legacy_fingerprint",
    ).all() as Array<{ legacy_fingerprint: string }>).map((row) => row.legacy_fingerprint);
  }

  isLegacyFingerprintRetired(fingerprint: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM legacy_conversions WHERE legacy_fingerprint = ? AND retired_at IS NOT NULL",
    ).get(fingerprint));
  }

  async signPreviewContext(session: BrowserSession, previewInstanceId: string): Promise<string> {
    const preview = this.requiredInstance(previewInstanceId);
    if (preview.role !== "preview" || !fs.existsSync(this.privateKeyPath)) {
      throw new Error("Preview context signing is unavailable.");
    }
    const key = await importPKCS8(fs.readFileSync(this.privateKeyPath, "utf8"), "EdDSA");
    const ceiling = preview.effect_ceiling.filter((effect) => session.effect_ceiling.includes(effect));
    return new SignJWT({
      sid: session.family_id,
      root: session.root_family_id,
      uid: session.user_id,
      slug: session.slug,
      effects: ceiling,
      csrf: session.csrf_token,
      generation: preview.backend_generation,
      auth_time: session.evidence.authenticated_at,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(this.installationId)
      .setAudience(preview.instance_id)
      .setJti(token(16))
      .setIssuedAt()
      .setExpirationTime(`${INTERNAL_CONTEXT_TTL_SECONDS}s`)
      .sign(key);
  }

  static async verifyPreviewContext(
    compact: string,
    verificationKeyPem: string,
    registration: InstanceRegistration,
  ): Promise<BrowserSession | null> {
    try {
      const key = await importSPKI(verificationKeyPem, "EdDSA");
      const { payload } = await jwtVerify(compact, key, {
        issuer: registration.installation_id,
        audience: registration.instance_id,
        algorithms: ["EdDSA"],
        maxTokenAge: `${INTERNAL_CONTEXT_TTL_SECONDS}s`,
      });
      if (
        typeof payload.sid !== "string" || typeof payload.root !== "string" || typeof payload.uid !== "string"
        || typeof payload.slug !== "string" || typeof payload.csrf !== "string"
        || payload.generation !== registration.backend_generation
        || !Array.isArray(payload.effects)
        || payload.effects.some((effect) => !registration.effect_ceiling.includes(effect as Effect))
      ) return null;
      return {
        family_id: payload.sid,
        root_family_id: payload.root,
        user_id: payload.uid,
        slug: payload.slug,
        audience: registration.instance_id,
        effect_ceiling: payload.effects as Effect[],
        csrf_token: payload.csrf,
        expires_at: Number(payload.exp) * 1_000,
        absolute_expires_at: Number(payload.exp) * 1_000,
        evidence: {
          method: "installation_context",
          credential_id: null,
          authenticated_at: Number(payload.auth_time),
        },
      };
    } catch {
      return null;
    }
  }

  private requiredInstance(instanceId: string): InstanceRegistration {
    const registration = this.instance(instanceId);
    if (!registration) throw new Error(`Instance is not registered: ${instanceId}`);
    return registration;
  }

  private classifyByFamily(familyId: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM browser_sessions WHERE family_id = ?")
      .get(familyId) as SessionRow | undefined;
    if (!row || row.revoked_at !== null || row.expires_at <= this.now()
        || row.absolute_expires_at <= this.now()) return null;
    return row;
  }

  private derivedToken(purpose: string, input: string): string {
    return createHmac("sha256", this.derivationKey)
      .update(`mandible:${purpose}\0`, "utf8")
      .update(input, "utf8")
      .digest("base64url");
  }

  private derivedId(purpose: string, input: string): string {
    return createHmac("sha256", this.derivationKey)
      .update(`mandible:${purpose}\0`, "utf8")
      .update(input, "utf8")
      .digest("hex")
      .slice(0, 32);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authority_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instance_registrations (
        instance_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('main', 'preview')),
        public_origin TEXT NOT NULL UNIQUE,
        backend_origin TEXT NOT NULL,
        backend_generation TEXT NOT NULL,
        effect_ceiling_json TEXT NOT NULL,
        writable_roots_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_sessions (
        family_id TEXT PRIMARY KEY,
        root_family_id TEXT NOT NULL,
        token_digest TEXT NOT NULL UNIQUE,
        csrf_digest TEXT NOT NULL,
        user_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        audience TEXT NOT NULL REFERENCES instance_registrations(instance_id),
        effect_ceiling_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        legacy_fingerprint TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS pairing_transactions (
        reference TEXT PRIMARY KEY,
        secret_digest TEXT NOT NULL,
        audience TEXT NOT NULL REFERENCES instance_registrations(instance_id),
        return_path TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        approved_user_id TEXT,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS preview_transfers (
        reference TEXT PRIMARY KEY,
        secret_digest TEXT NOT NULL,
        target_audience TEXT NOT NULL REFERENCES instance_registrations(instance_id),
        return_path TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        authorized_root_family_id TEXT,
        authorized_user_id TEXT,
        authorized_at INTEGER,
        issued_family_id TEXT REFERENCES browser_sessions(family_id),
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS legacy_conversions (
        reference TEXT PRIMARY KEY,
        secret_digest TEXT NOT NULL,
        legacy_fingerprint TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        target_audience TEXT NOT NULL REFERENCES instance_registrations(instance_id),
        return_path TEXT NOT NULL,
        browser_state_json TEXT NOT NULL,
        authenticated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        issued_family_id TEXT UNIQUE REFERENCES browser_sessions(family_id),
        verified_at INTEGER,
        retired_at INTEGER
      );
    `);
    const meta = this.db.prepare("SELECT value FROM authority_meta WHERE key = 'installation_id'")
      .get() as { value: string } | undefined;
    if (meta && meta.value !== this.installationId) {
      throw new Error("Local session authority belongs to another installation.");
    }
    if (!meta) {
      this.db.prepare("INSERT INTO authority_meta (key, value) VALUES ('installation_id', ?)")
        .run(this.installationId);
    }
    const schema = this.db.prepare("SELECT value FROM authority_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (schema?.value === "1") {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE browser_sessions ADD COLUMN root_family_id TEXT");
        this.db.exec("ALTER TABLE browser_sessions ADD COLUMN legacy_fingerprint TEXT");
        this.db.exec("UPDATE browser_sessions SET root_family_id = family_id WHERE root_family_id IS NULL");
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_sessions_legacy_fingerprint ON browser_sessions(legacy_fingerprint) WHERE legacy_fingerprint IS NOT NULL");
        this.db.prepare("UPDATE authority_meta SET value = ? WHERE key = 'schema_version'")
          .run(AUTHORITY_SCHEMA_VERSION);
      })();
    } else if (schema && schema.value !== AUTHORITY_SCHEMA_VERSION) {
      throw new Error(`Unsupported local session authority schema: ${schema.value}`);
    }
    if (!schema) {
      this.db.prepare("INSERT INTO authority_meta (key, value) VALUES ('schema_version', ?)")
        .run(AUTHORITY_SCHEMA_VERSION);
    }
  }

  private ensureSigningKeys(): void {
    if (fs.existsSync(this.privateKeyPath) && fs.existsSync(this.publicKeyPath)) return;
    if (fs.existsSync(this.privateKeyPath) || fs.existsSync(this.publicKeyPath)) {
      throw new Error("Local session signing key state is incomplete.");
    }
    const pair = generateKeyPairSync("ed25519");
    writeProtected(this.privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    writeProtected(this.publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
  }

  private ensureDerivationKey(): void {
    if (fs.existsSync(this.derivationKeyPath)) return;
    writeProtected(this.derivationKeyPath, token(32));
  }
}

function registrationFromRow(row: Record<string, unknown>): InstanceRegistration {
  return {
    instance_id: String(row.instance_id),
    installation_id: String(row.installation_id),
    role: row.role === "preview" ? "preview" : "main",
    public_origin: String(row.public_origin),
    backend_origin: String(row.backend_origin),
    backend_generation: String(row.backend_generation),
    effect_ceiling: JSON.parse(String(row.effect_ceiling_json)) as Effect[],
    writable_roots: JSON.parse(String(row.writable_roots_json)) as string[],
  };
}

function sessionFromRow(row: SessionRow, raw: string): BrowserSession {
  const evidence = JSON.parse(row.evidence_json) as AuthEvidence;
  return {
    family_id: row.family_id,
    root_family_id: row.root_family_id,
    user_id: row.user_id,
    slug: row.slug,
    audience: row.audience,
    effect_ceiling: JSON.parse(row.effect_ceiling_json) as Effect[],
    csrf_token: csrfForToken(raw),
    expires_at: row.expires_at,
    absolute_expires_at: row.absolute_expires_at,
    evidence,
  };
}

function validateRegistration(registration: InstanceRegistration, installationId: string): void {
  if (registration.installation_id !== installationId) throw new Error("Registration installation mismatch.");
  const publicOrigin = new URL(registration.public_origin);
  const backendOrigin = new URL(registration.backend_origin);
  for (const [raw, origin] of [[registration.public_origin, publicOrigin], [registration.backend_origin, backendOrigin]] as const) {
    if (origin.username || origin.password || !origin.port || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error(`Invalid instance origin: ${raw}`);
    }
  }
  if (publicOrigin.protocol !== "https:"
      || !publicOrigin.hostname.toLowerCase().endsWith(".mandible.localhost")) {
    throw new Error("Instance public origin must be an exact Mandible HTTPS hostname.");
  }
  if (backendOrigin.protocol !== "http:"
      || !new Set(["127.0.0.1", "::1", "[::1]"]).has(backendOrigin.hostname.toLowerCase())) {
    throw new Error("Instance backend origin must be loopback HTTP.");
  }
  if (new Set(registration.effect_ceiling).size !== registration.effect_ceiling.length) {
    throw new Error("Instance effect ceiling contains duplicates.");
  }
  if (registration.writable_roots.some((root) => !path.isAbsolute(root))) {
    throw new Error("Instance writable roots must be absolute.");
  }
}

function validateReturnPath(raw: string): string {
  const value = raw.trim() || "/";
  const parsed = new URL(value, "https://return.invalid");
  if (parsed.origin !== "https://return.invalid" || !value.startsWith("/") || value.startsWith("//")) {
    throw new Error("Pairing return path must be a local absolute path.");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function csrfForToken(raw: string): string {
  return createHash("sha256").update("mandible-csrf\0").update(raw).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeProtected(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600, flag: "wx" });
  fs.chmodSync(filePath, 0o600);
}
